
-- ══════════════════════════════════════════════════════════════════════
-- A2 Migration 07：修正 search_path 语法
-- 问题：ALTER FUNCTION ... SET search_path = 'public, extensions' 
--   把带引号的整体当作单一 schema 名（"public, extensions"），
--   而非两个独立 schema。
-- 修复：使用 CREATE OR REPLACE，在函数头写 SET search_path TO public, extensions
--   （不加引号，逗号分隔两个 schema）
-- ══════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.join_room_with_password(
  p_room_id  UUID,
  p_password TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
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

  -- 并发串行化（与 verify 使用完全相同的锁键）
  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_uid::text || ':' || p_room_id::text, 0)
  );

  -- 加锁后再读限流行
  SELECT fail_count, locked_until INTO v_rate_fail, v_rate_locked
  FROM public.room_join_rate_limits
  WHERE user_id = v_uid AND room_id = p_room_id;
  IF FOUND THEN v_rate_found := TRUE; END IF;

  -- 锁定检查（正确密码也不绕过）
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

  IF crypt(p_password, v_hash) = v_hash THEN
    DELETE FROM public.room_join_rate_limits WHERE user_id = v_uid AND room_id = p_room_id;
    INSERT INTO public.room_members (room_id, user_id, role, joined_at, left_at)
    VALUES (p_room_id, v_uid, 'tourist', NOW(), NULL)
    ON CONFLICT (room_id, user_id) DO UPDATE
      SET left_at = NULL, joined_at = NOW(), role = 'tourist';
    RETURN jsonb_build_object('ok', true, 'code', 'joined');
  ELSE
    -- 原子递增：基于表中当前值；锁过期后从 1 重置
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

CREATE OR REPLACE FUNCTION public.verify_room_password_only(
  p_room_id  UUID,
  p_password TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
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

  IF crypt(p_password, v_hash) = v_hash THEN
    DELETE FROM public.room_join_rate_limits WHERE user_id = v_uid AND room_id = p_room_id;
    -- 注意：绝不写 room_members 或 memberships
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
