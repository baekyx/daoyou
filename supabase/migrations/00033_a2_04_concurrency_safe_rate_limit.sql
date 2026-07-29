
-- ══════════════════════════════════════════════════════════════════════
-- A2 Migration 04：并发安全限流
--
-- 问题根因（a2_03 残留）：
--   两个并发请求同时到达，均未找到 rate_limit 行，各自计算 v_new_fail=1。
--   第一个 INSERT 成功写入 fail_count=1；第二个触发 ON CONFLICT，
--   DO UPDATE SET fail_count = v_new_fail（仍是旧计算值 1），结果 fail_count=1
--   而非 2。并发丢计数。
--
-- 修复方案：
--   1. 在认证/房间校验后、读取限流行前，调用
--      pg_advisory_xact_lock(hashtextextended(uid||':'||room_id, 0))
--      将同一 uid+room_id 的并发请求串行化，事务结束自动释放。
--   2. 错误分支 UPSERT 在冲突时使用
--      room_join_rate_limits.fail_count + 1（基于表中当前值），
--      不再使用冲突前计算的 v_new_fail。
--   3. 用 RETURNING fail_count, locked_until 取最终落库值（不依赖估算）。
--   4. 锁过期后（locked_until <= NOW()）重置 fail_count 从 1 重新计数。
-- ══════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────────
-- 1. 重写 join_room_with_password（并发安全版）
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.join_room_with_password(
  p_room_id  UUID,
  p_password TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
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
  -- 0. 必须已登录
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated');
  END IF;

  -- 1. 房间状态校验
  SELECT status INTO v_room_status
  FROM public.rooms
  WHERE id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_found');
  END IF;
  IF v_room_status NOT IN ('pending', 'live') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_active');
  END IF;

  -- 2. 已有成员记录 → 免密恢复（跳过密码校验和限流）
  SELECT EXISTS(
    SELECT 1 FROM public.room_members
    WHERE room_id = p_room_id AND user_id = v_uid
  ) INTO v_member_exists;

  IF v_member_exists THEN
    UPDATE public.room_members
    SET left_at = NULL
    WHERE room_id = p_room_id AND user_id = v_uid;
    RETURN jsonb_build_object('ok', true, 'code', 'resumed');
  END IF;

  -- 3. 串行化同一 uid+room_id 的并发请求（事务结束自动释放）
  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_uid::text || ':' || p_room_id::text, 0)
  );

  -- 4. 读取限流记录（加锁后再读，确保一致性）
  SELECT fail_count, locked_until
  INTO   v_rate_fail, v_rate_locked
  FROM   public.room_join_rate_limits
  WHERE  user_id = v_uid AND room_id = p_room_id;

  IF FOUND THEN v_rate_found := TRUE; END IF;

  -- 5. 锁定检查（锁定期间正确密码也不能绕过）
  --    锁过期后：v_rate_locked <= NOW()，允许重新验证，fail_count 将从 1 重置
  IF v_rate_found AND v_rate_locked IS NOT NULL AND v_rate_locked > NOW() THEN
    v_lock_secs := EXTRACT(EPOCH FROM (v_rate_locked - NOW()))::INT;
    RETURN jsonb_build_object(
      'ok',                  false,
      'code',                'rate_limited',
      'retry_after_seconds', v_lock_secs,
      'attempts_remaining',  0
    );
  END IF;

  -- 6. 获取 hash
  SELECT pwd_hash INTO v_hash
  FROM public.room_secrets
  WHERE room_id = p_room_id;

  IF v_hash IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_found');
  END IF;

  -- 7. bcrypt 校验
  IF crypt(p_password, v_hash) = v_hash THEN
    -- ✅ 正确：清除限流，写入 tourist 成员
    DELETE FROM public.room_join_rate_limits
    WHERE user_id = v_uid AND room_id = p_room_id;

    INSERT INTO public.room_members (room_id, user_id, role, joined_at, left_at)
    VALUES (p_room_id, v_uid, 'tourist', NOW(), NULL)
    ON CONFLICT (room_id, user_id) DO UPDATE
      SET left_at   = NULL,
          joined_at = NOW(),
          role      = 'tourist';

    RETURN jsonb_build_object('ok', true, 'code', 'joined');

  ELSE
    -- ❌ 错误：基于表中当前值原子递增
    --    锁过期后重新从 1 计数（locked_until <= NOW() 视为过期，重置）
    INSERT INTO public.room_join_rate_limits
      (user_id, room_id, fail_count, last_fail_at, locked_until)
    VALUES (
      v_uid, p_room_id, 1, NOW(), NULL
    )
    ON CONFLICT (user_id, room_id) DO UPDATE
      SET fail_count   =
            -- 锁过期 → 重置计数从 1 开始
            CASE
              WHEN room_join_rate_limits.locked_until IS NOT NULL
                   AND room_join_rate_limits.locked_until <= NOW()
              THEN 1
              ELSE room_join_rate_limits.fail_count + 1
            END,
          last_fail_at = NOW(),
          locked_until =
            CASE
              WHEN room_join_rate_limits.locked_until IS NOT NULL
                   AND room_join_rate_limits.locked_until <= NOW()
              THEN NULL  -- 先清除过期锁
              WHEN (
                CASE
                  WHEN room_join_rate_limits.locked_until IS NOT NULL
                       AND room_join_rate_limits.locked_until <= NOW()
                  THEN 1
                  ELSE room_join_rate_limits.fail_count + 1
                END
              ) >= 5
              THEN NOW() + INTERVAL '60 seconds'
              ELSE NULL
            END
    RETURNING fail_count, locked_until
    INTO v_final_fail, v_final_locked;

    -- 第一次插入（非冲突）时 RETURNING 不需额外处理，fail_count=1
    IF v_final_fail IS NULL THEN
      v_final_fail   := 1;
      v_final_locked := NULL;
    END IF;

    v_remaining := GREATEST(0, 5 - v_final_fail);

    IF v_final_locked IS NOT NULL AND v_final_locked > NOW() THEN
      RETURN jsonb_build_object(
        'ok',                  false,
        'code',                'rate_limited',
        'retry_after_seconds', 60,
        'attempts_remaining',  0
      );
    ELSE
      RETURN jsonb_build_object(
        'ok',                 false,
        'code',               'wrong_password',
        'attempts_remaining', v_remaining
      );
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.join_room_with_password(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.join_room_with_password(UUID, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.join_room_with_password(UUID, TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────────
-- 2. 重写 verify_room_password_only（并发安全版，与 join 共享相同锁键）
-- ─────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.verify_room_password_only(
  p_room_id  UUID,
  p_password TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_uid         UUID;
  v_room_status public.room_status;
  v_hash        TEXT;
  v_rate_fail   INT;
  v_rate_locked TIMESTAMPTZ;
  v_rate_found  BOOLEAN := FALSE;
  v_final_fail  INT;
  v_final_locked TIMESTAMPTZ;
  v_remaining   INT;
  v_lock_secs   INT;
BEGIN
  -- 0. 必须已登录
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated');
  END IF;

  -- 1. 房间状态校验
  SELECT status INTO v_room_status
  FROM public.rooms
  WHERE id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_found');
  END IF;
  IF v_room_status NOT IN ('pending', 'live') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_active');
  END IF;

  -- 2. 串行化同一 uid+room_id（与 join_room_with_password 完全相同的锁键）
  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_uid::text || ':' || p_room_id::text, 0)
  );

  -- 3. 读取限流记录
  SELECT fail_count, locked_until
  INTO   v_rate_fail, v_rate_locked
  FROM   public.room_join_rate_limits
  WHERE  user_id = v_uid AND room_id = p_room_id;

  IF FOUND THEN v_rate_found := TRUE; END IF;

  -- 4. 锁定检查
  IF v_rate_found AND v_rate_locked IS NOT NULL AND v_rate_locked > NOW() THEN
    v_lock_secs := EXTRACT(EPOCH FROM (v_rate_locked - NOW()))::INT;
    RETURN jsonb_build_object(
      'ok',                  false,
      'code',                'rate_limited',
      'retry_after_seconds', v_lock_secs,
      'attempts_remaining',  0
    );
  END IF;

  -- 5. 获取 hash
  SELECT pwd_hash INTO v_hash
  FROM public.room_secrets
  WHERE room_id = p_room_id;

  IF v_hash IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_found');
  END IF;

  -- 6. bcrypt 校验
  IF crypt(p_password, v_hash) = v_hash THEN
    -- ✅ 正确：清除限流，绝不写 room_members 或 memberships
    DELETE FROM public.room_join_rate_limits
    WHERE user_id = v_uid AND room_id = p_room_id;

    RETURN jsonb_build_object('ok', true, 'code', 'verified');

  ELSE
    -- ❌ 错误：与 join 相同的原子递增逻辑
    INSERT INTO public.room_join_rate_limits
      (user_id, room_id, fail_count, last_fail_at, locked_until)
    VALUES (
      v_uid, p_room_id, 1, NOW(), NULL
    )
    ON CONFLICT (user_id, room_id) DO UPDATE
      SET fail_count   =
            CASE
              WHEN room_join_rate_limits.locked_until IS NOT NULL
                   AND room_join_rate_limits.locked_until <= NOW()
              THEN 1
              ELSE room_join_rate_limits.fail_count + 1
            END,
          last_fail_at = NOW(),
          locked_until =
            CASE
              WHEN room_join_rate_limits.locked_until IS NOT NULL
                   AND room_join_rate_limits.locked_until <= NOW()
              THEN NULL
              WHEN (
                CASE
                  WHEN room_join_rate_limits.locked_until IS NOT NULL
                       AND room_join_rate_limits.locked_until <= NOW()
                  THEN 1
                  ELSE room_join_rate_limits.fail_count + 1
                END
              ) >= 5
              THEN NOW() + INTERVAL '60 seconds'
              ELSE NULL
            END
    RETURNING fail_count, locked_until
    INTO v_final_fail, v_final_locked;

    IF v_final_fail IS NULL THEN
      v_final_fail   := 1;
      v_final_locked := NULL;
    END IF;

    v_remaining := GREATEST(0, 5 - v_final_fail);

    IF v_final_locked IS NOT NULL AND v_final_locked > NOW() THEN
      RETURN jsonb_build_object(
        'ok',                  false,
        'code',                'rate_limited',
        'retry_after_seconds', 60,
        'attempts_remaining',  0
      );
    ELSE
      RETURN jsonb_build_object(
        'ok',                 false,
        'code',               'wrong_password',
        'attempts_remaining', v_remaining
      );
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.verify_room_password_only(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_room_password_only(UUID, TEXT) FROM anon;
GRANT  EXECUTE ON FUNCTION public.verify_room_password_only(UUID, TEXT) TO authenticated;
