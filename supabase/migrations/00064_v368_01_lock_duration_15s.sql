
-- ══════════════════════════════════════════════════════════════════
-- v368 Migration 01: 将密码连续错误锁定时长从 60 秒统一改为 15 秒
-- 来源：join_room_with_password RPC（v366_03_room_access_rpcs 写入的版本）
-- 同时安全收敛现有未结束的 60 秒锁定记录，使其最多从现在起再等 15 秒
-- ══════════════════════════════════════════════════════════════════

-- 1. 重新部署 join_room_with_password，将 INTERVAL '60 seconds' 改为 INTERVAL '15 seconds'
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
  v_authorized    BOOLEAN := FALSE;
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

  -- 有效授权检查
  SELECT EXISTS(
    SELECT 1 FROM public.room_members
    WHERE room_id           = p_room_id
      AND user_id           = v_uid
      AND access_granted_at IS NOT NULL
      AND access_revoked_at IS NULL
  ) INTO v_authorized;

  IF v_authorized THEN
    UPDATE public.room_members
    SET left_at = NULL
    WHERE room_id = p_room_id AND user_id = v_uid;
    RETURN jsonb_build_object('ok', true, 'code', 'resumed');
  END IF;

  -- 串行化同一 uid+room_id 的写入
  PERFORM pg_advisory_xact_lock(
    hashtextextended(v_uid::text || ':' || p_room_id::text, 0)
  );

  -- 限流检查
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

  -- 读取密码 hash
  SELECT pwd_hash INTO v_hash FROM public.room_secrets WHERE room_id = p_room_id;
  IF v_hash IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_found');
  END IF;

  -- bcrypt 对比
  IF extensions.crypt(p_password, v_hash) = v_hash THEN
    -- 密码正确：清限流 + upsert room_members + 写授权
    DELETE FROM public.room_join_rate_limits WHERE user_id = v_uid AND room_id = p_room_id;
    INSERT INTO public.room_members
      (room_id, user_id, role, joined_at, left_at, access_granted_at, access_revoked_at)
    VALUES
      (p_room_id, v_uid, 'tourist', NOW(), NULL, NOW(), NULL)
    ON CONFLICT (room_id, user_id) DO UPDATE
      SET left_at           = NULL,
          joined_at         = NOW(),
          role              = 'tourist',
          access_granted_at = NOW(),
          access_revoked_at = NULL;
    RETURN jsonb_build_object('ok', true, 'code', 'joined');
  ELSE
    -- 密码错误：只更新限流，不写 room_members / 授权
    -- ★ 锁定时长改为 15 秒 ★
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
                 THEN NOW() + INTERVAL '15 seconds'   -- ★ 15s ★
                 ELSE NULL
            END
    RETURNING fail_count, locked_until INTO v_final_fail, v_final_locked;

    IF v_final_fail IS NULL THEN v_final_fail := 1; v_final_locked := NULL; END IF;
    v_remaining := GREATEST(0, 5 - v_final_fail);

    IF v_final_locked IS NOT NULL AND v_final_locked > NOW() THEN
      RETURN jsonb_build_object(
        'ok', false, 'code', 'rate_limited',
        'retry_after_seconds', 15, 'attempts_remaining', 0  -- ★ 15s ★
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

-- 2. 安全收敛现有未结束的超长锁定记录
--    将 locked_until > NOW() + 15s 的记录截断到 NOW() + 15s
--    不修改 fail_count，不删除任何记录
UPDATE public.room_join_rate_limits
SET locked_until = NOW() + INTERVAL '15 seconds'
WHERE locked_until IS NOT NULL
  AND locked_until > NOW() + INTERVAL '15 seconds';
