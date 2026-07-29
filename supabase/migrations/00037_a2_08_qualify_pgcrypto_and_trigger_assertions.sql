
-- ══════════════════════════════════════════════════════════════════════
-- A2 Migration 08：显式限定 pgcrypto 调用 + 触发器兼容性断言
--
-- 审计发现（a2_08 之前）：
--   _sync_room_password_hash : bare crypt(  bare gen_salt(  search_path=public      ← 运行时 42883
--   join_room_with_password  : bare crypt(  no gen_salt     search_path=public,extensions ← 依赖 search_path
--   verify_room_password_only: bare crypt(  no gen_salt     search_path=public,extensions ← 依赖 search_path
--
-- 修复原则：
--   所有 pgcrypto 调用显式写成 extensions.crypt(...) / extensions.gen_salt(...)
--   SECURITY DEFINER 函数 search_path 改为仅 'public'（最小化；不再需要 extensions 在路径中）
--   业务逻辑、advisory lock、原子递增、权限全部保留
-- ══════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────
-- 1. 修正 _sync_room_password_hash（触发器函数）
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public._sync_room_password_hash()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'INSERT'
     OR (TG_OP = 'UPDATE' AND NEW.password IS DISTINCT FROM OLD.password) THEN
    IF NEW.password IS NOT NULL AND NEW.password <> '' THEN
      INSERT INTO public.room_secrets (room_id, pwd_hash, updated_at)
      VALUES (
        NEW.id,
        extensions.crypt(NEW.password, extensions.gen_salt('bf', 8)),
        NOW()
      )
      ON CONFLICT (room_id) DO UPDATE
        SET pwd_hash   = EXCLUDED.pwd_hash,
            updated_at = NOW();
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- ─────────────────────────────────────────────────────────────────────
-- 2. 修正 join_room_with_password（搜索路径改为仅 public；crypt 显式限定）
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.join_room_with_password(
  p_room_id  UUID,
  p_password TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid           UUID;
  v_room_status   public.room_status;
  v_hash          TEXT;
  v_rate_fail     INT;
  v_rate_locked   TIMESTAMPTZ;
  v_rate_found    BOOLEAN := FALSE;
  v_final_fail    INT;
  v_final_locked  TIMESTAMPTZ;
  v_remaining     INT;
  v_lock_secs     INT;
  v_member_exists BOOLEAN := FALSE;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated');
  END IF;

  SELECT status INTO v_room_status FROM public.rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_found');
  END IF;
  IF v_room_status NOT IN ('pending', 'live') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_active');
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.room_members WHERE room_id = p_room_id AND user_id = v_uid
  ) INTO v_member_exists;

  IF v_member_exists THEN
    UPDATE public.room_members SET left_at = NULL
    WHERE room_id = p_room_id AND user_id = v_uid;
    RETURN jsonb_build_object('ok', true, 'code', 'resumed');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_uid::text || ':' || p_room_id::text, 0)
  );

  SELECT fail_count, locked_until INTO v_rate_fail, v_rate_locked
  FROM public.room_join_rate_limits
  WHERE user_id = v_uid AND room_id = p_room_id;
  IF FOUND THEN v_rate_found := TRUE; END IF;

  IF v_rate_found AND v_rate_locked IS NOT NULL AND v_rate_locked > NOW() THEN
    v_lock_secs := EXTRACT(EPOCH FROM (v_rate_locked - NOW()))::INT;
    RETURN jsonb_build_object(
      'ok', false, 'code', 'rate_limited',
      'retry_after_seconds', v_lock_secs, 'attempts_remaining', 0
    );
  END IF;

  SELECT pwd_hash INTO v_hash FROM public.room_secrets WHERE room_id = p_room_id;
  IF v_hash IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_found');
  END IF;

  IF extensions.crypt(p_password, v_hash) = v_hash THEN
    DELETE FROM public.room_join_rate_limits WHERE user_id = v_uid AND room_id = p_room_id;
    INSERT INTO public.room_members (room_id, user_id, role, joined_at, left_at)
    VALUES (p_room_id, v_uid, 'tourist', NOW(), NULL)
    ON CONFLICT (room_id, user_id) DO UPDATE
      SET left_at = NULL, joined_at = NOW(), role = 'tourist';
    RETURN jsonb_build_object('ok', true, 'code', 'joined');
  ELSE
    INSERT INTO public.room_join_rate_limits
      (user_id, room_id, fail_count, last_fail_at, locked_until)
    VALUES (v_uid, p_room_id, 1, NOW(), NULL)
    ON CONFLICT (user_id, room_id) DO UPDATE
      SET fail_count =
            CASE WHEN room_join_rate_limits.locked_until IS NOT NULL
                      AND room_join_rate_limits.locked_until <= NOW()
                 THEN 1
                 ELSE room_join_rate_limits.fail_count + 1
            END,
          last_fail_at = NOW(),
          locked_until =
            CASE WHEN room_join_rate_limits.locked_until IS NOT NULL
                      AND room_join_rate_limits.locked_until <= NOW()
                 THEN NULL
                 WHEN (CASE WHEN room_join_rate_limits.locked_until IS NOT NULL
                                 AND room_join_rate_limits.locked_until <= NOW()
                            THEN 1
                            ELSE room_join_rate_limits.fail_count + 1
                       END) >= 5
                 THEN NOW() + INTERVAL '60 seconds'
                 ELSE NULL
            END
    RETURNING fail_count, locked_until INTO v_final_fail, v_final_locked;

    IF v_final_fail IS NULL THEN v_final_fail := 1; v_final_locked := NULL; END IF;
    v_remaining := GREATEST(0, 5 - v_final_fail);

    IF v_final_locked IS NOT NULL AND v_final_locked > NOW() THEN
      RETURN jsonb_build_object(
        'ok', false, 'code', 'rate_limited',
        'retry_after_seconds', 60, 'attempts_remaining', 0
      );
    ELSE
      RETURN jsonb_build_object(
        'ok', false, 'code', 'wrong_password', 'attempts_remaining', v_remaining
      );
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.join_room_with_password(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.join_room_with_password(UUID, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.join_room_with_password(UUID, TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 3. 修正 verify_room_password_only（搜索路径改为仅 public；crypt 显式限定）
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_room_password_only(
  p_room_id  UUID,
  p_password TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_uid          UUID;
  v_room_status  public.room_status;
  v_hash         TEXT;
  v_rate_fail    INT;
  v_rate_locked  TIMESTAMPTZ;
  v_rate_found   BOOLEAN := FALSE;
  v_final_fail   INT;
  v_final_locked TIMESTAMPTZ;
  v_remaining    INT;
  v_lock_secs    INT;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated');
  END IF;

  SELECT status INTO v_room_status FROM public.rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_found');
  END IF;
  IF v_room_status NOT IN ('pending', 'live') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_active');
  END IF;

  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_uid::text || ':' || p_room_id::text, 0)
  );

  SELECT fail_count, locked_until INTO v_rate_fail, v_rate_locked
  FROM public.room_join_rate_limits
  WHERE user_id = v_uid AND room_id = p_room_id;
  IF FOUND THEN v_rate_found := TRUE; END IF;

  IF v_rate_found AND v_rate_locked IS NOT NULL AND v_rate_locked > NOW() THEN
    v_lock_secs := EXTRACT(EPOCH FROM (v_rate_locked - NOW()))::INT;
    RETURN jsonb_build_object(
      'ok', false, 'code', 'rate_limited',
      'retry_after_seconds', v_lock_secs, 'attempts_remaining', 0
    );
  END IF;

  SELECT pwd_hash INTO v_hash FROM public.room_secrets WHERE room_id = p_room_id;
  IF v_hash IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_found');
  END IF;

  IF extensions.crypt(p_password, v_hash) = v_hash THEN
    DELETE FROM public.room_join_rate_limits WHERE user_id = v_uid AND room_id = p_room_id;
    RETURN jsonb_build_object('ok', true, 'code', 'verified');
  ELSE
    INSERT INTO public.room_join_rate_limits
      (user_id, room_id, fail_count, last_fail_at, locked_until)
    VALUES (v_uid, p_room_id, 1, NOW(), NULL)
    ON CONFLICT (user_id, room_id) DO UPDATE
      SET fail_count =
            CASE WHEN room_join_rate_limits.locked_until IS NOT NULL
                      AND room_join_rate_limits.locked_until <= NOW()
                 THEN 1
                 ELSE room_join_rate_limits.fail_count + 1
            END,
          last_fail_at = NOW(),
          locked_until =
            CASE WHEN room_join_rate_limits.locked_until IS NOT NULL
                      AND room_join_rate_limits.locked_until <= NOW()
                 THEN NULL
                 WHEN (CASE WHEN room_join_rate_limits.locked_until IS NOT NULL
                                 AND room_join_rate_limits.locked_until <= NOW()
                            THEN 1
                            ELSE room_join_rate_limits.fail_count + 1
                       END) >= 5
                 THEN NOW() + INTERVAL '60 seconds'
                 ELSE NULL
            END
    RETURNING fail_count, locked_until INTO v_final_fail, v_final_locked;

    IF v_final_fail IS NULL THEN v_final_fail := 1; v_final_locked := NULL; END IF;
    v_remaining := GREATEST(0, 5 - v_final_fail);

    IF v_final_locked IS NOT NULL AND v_final_locked > NOW() THEN
      RETURN jsonb_build_object(
        'ok', false, 'code', 'rate_limited',
        'retry_after_seconds', 60, 'attempts_remaining', 0
      );
    ELSE
      RETURN jsonb_build_object(
        'ok', false, 'code', 'wrong_password', 'attempts_remaining', v_remaining
      );
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_room_password_only(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_room_password_only(UUID, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.verify_room_password_only(UUID, TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 4. 触发器兼容性断言（真实 UPDATE rooms.password → 验证 hash 可用）
--    无净数据变化：测试结束后完全恢复原始值
-- ─────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_room_id       UUID;
  v_orig_password TEXT;
  v_orig_hash     TEXT;
  v_test_pwd      CONSTANT TEXT := 'a2_08_trigger_test_' || md5(clock_timestamp()::text);
  v_new_hash      TEXT;
BEGIN
  -- 选取一条有 room_secrets 的房间（FOR UPDATE 锁行）
  SELECT r.id, r.password, rs.pwd_hash
  INTO   v_room_id, v_orig_password, v_orig_hash
  FROM   public.rooms r
  JOIN   public.room_secrets rs ON rs.room_id = r.id
  WHERE  r.password IS NOT NULL AND r.password <> ''
  ORDER BY r.created_at
  LIMIT  1
  FOR UPDATE OF r;

  IF v_room_id IS NULL THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: no room with room_secrets found';
  END IF;
  RAISE NOTICE '[trigger-test] target room locked, original hash length=%', length(v_orig_hash);

  -- 用测试密码触发同步触发器（不输出真实密码）
  UPDATE public.rooms SET password = v_test_pwd WHERE id = v_room_id;

  -- 取触发器写入的新 hash
  SELECT pwd_hash INTO v_new_hash
  FROM   public.room_secrets WHERE room_id = v_room_id;

  IF v_new_hash IS NULL THEN
    RAISE EXCEPTION 'FAIL trigger-write: room_secrets.pwd_hash is NULL after UPDATE';
  END IF;

  -- 验证新 hash 可由 extensions.crypt 正确验证
  IF extensions.crypt(v_test_pwd, v_new_hash) <> v_new_hash THEN
    RAISE EXCEPTION 'FAIL trigger-verify: crypt(test_pwd, new_hash) != new_hash';
  END IF;
  RAISE NOTICE '[trigger-test] new hash verified by extensions.crypt  ✅';

  -- 恢复原始 password（触发器会再次运行，重写 hash）
  UPDATE public.rooms SET password = v_orig_password WHERE id = v_room_id;

  -- 精确恢复原始 hash（跳过 bcrypt 重新计算的细微时间差，保证与测试前一致）
  UPDATE public.room_secrets
  SET pwd_hash = v_orig_hash, updated_at = NOW()
  WHERE room_id = v_room_id;

  -- 最终断言：rooms.password 与 room_secrets.pwd_hash 与测试前完全一致
  IF NOT EXISTS(
    SELECT 1 FROM public.rooms
    WHERE id = v_room_id AND password = v_orig_password
  ) THEN
    RAISE EXCEPTION 'FAIL restore: rooms.password does not match original';
  END IF;

  IF NOT EXISTS(
    SELECT 1 FROM public.room_secrets
    WHERE room_id = v_room_id AND pwd_hash = v_orig_hash
  ) THEN
    RAISE EXCEPTION 'FAIL restore: room_secrets.pwd_hash does not match original';
  END IF;

  RAISE NOTICE '[trigger-test] rooms.password and room_secrets.pwd_hash fully restored  ✅';
  RAISE NOTICE '[trigger-test] trigger compatibility assertion PASSED — no net data change  ✅';
END;
$$;
