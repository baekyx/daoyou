
-- ══════════════════════════════════════════════════════════════════
-- A2 复核修正 Migration 03
-- 根因说明：
--   1. join_room_with_password 在 ELSE（密码错误）分支中用 IF NOT FOUND 判断
--      v_rate 是否存在，但此时 FOUND 标志已被上方 "SELECT pwd_hash INTO v_hash"
--      语句覆盖（FOUND = 该 room_secrets 是否找到），与 v_rate 的查找无关。
--      后果：第一次输错密码时，IF NOT FOUND 永远为 false（room_secrets 存在），
--      走 UPDATE 分支，但 rate_limits 行尚不存在 → UPDATE 0 行 → fail_count 从未写入
--      → 限流完全失效，可无限次尝试密码。
--   2. verify_room_password_only 缺失，摄影师必须调 join_room_with_password
--      导致密码验证时错误写入 room_members tourist 记录。
-- 修复：
--   1. 重写 join_room_with_password，用显式布尔 v_rate_found 追踪 rate row 是否存在；
--      始终用 INSERT...ON CONFLICT 原子更新，消除 UPDATE 0 行的竞态。
--      第1次错误写 fail_count=1；到第5次写 locked_until；锁定期正确密码仍拒绝；
--      解锁后允许重新验证；成功后 DELETE 限流记录。
--   2. 新增 verify_room_password_only：复用相同限流规则，成功只返回 ok=true，
--      绝不写 room_members 或 memberships。
-- ══════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────────────────────────
-- 1. 修复 join_room_with_password（完整重写）
-- ─────────────────────────────────────────────────────────────────
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
  v_rate_fail     INT     := 0;
  v_rate_locked   TIMESTAMPTZ := NULL;
  v_rate_found    BOOLEAN := FALSE;  -- 显式追踪 rate row 是否存在，不依赖 FOUND
  v_new_fail      INT;
  v_remaining     INT;
  v_lock_secs     INT;
  v_member_exists BOOLEAN := FALSE;
BEGIN
  -- 0. 必须已登录（auth.uid() 由 Supabase 从 JWT 注入，客户端无法伪造）
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

  -- 2. 检查是否已有成员记录（免密恢复路径，跳过密码校验）
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

  -- 3. 读取限流记录（FOR UPDATE 持锁，防并发竞态）
  --    用显式变量接收，不依赖 FOUND（后续还有 SELECT 会覆盖 FOUND）
  SELECT fail_count, locked_until
  INTO   v_rate_fail, v_rate_locked
  FROM   public.room_join_rate_limits
  WHERE  user_id = v_uid AND room_id = p_room_id
  FOR UPDATE;

  IF FOUND THEN
    v_rate_found := TRUE;
  END IF;

  -- 4. 锁定检查（正确密码也不能绕过锁定）
  IF v_rate_found AND v_rate_locked IS NOT NULL AND v_rate_locked > NOW() THEN
    v_lock_secs := EXTRACT(EPOCH FROM (v_rate_locked - NOW()))::INT;
    RETURN jsonb_build_object(
      'ok',                  false,
      'code',                'rate_limited',
      'retry_after_seconds', v_lock_secs
    );
  END IF;

  -- 5. 获取 hash（用独立变量，不影响 v_rate_found）
  SELECT pwd_hash INTO v_hash
  FROM public.room_secrets
  WHERE room_id = p_room_id;

  IF v_hash IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_found');
  END IF;

  -- 6. bcrypt 校验
  IF crypt(p_password, v_hash) = v_hash THEN
    -- ✅ 密码正确：清除限流记录，upsert tourist 成员
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
    -- ❌ 密码错误：原子写入/更新限流计数
    v_new_fail := COALESCE(v_rate_fail, 0) + 1;

    INSERT INTO public.room_join_rate_limits
      (user_id, room_id, fail_count, last_fail_at, locked_until)
    VALUES (
      v_uid,
      p_room_id,
      v_new_fail,
      NOW(),
      CASE WHEN v_new_fail >= 5 THEN NOW() + INTERVAL '60 seconds' ELSE NULL END
    )
    ON CONFLICT (user_id, room_id) DO UPDATE
      SET fail_count   = v_new_fail,
          last_fail_at = NOW(),
          locked_until = CASE
            WHEN v_new_fail >= 5 THEN NOW() + INTERVAL '60 seconds'
            ELSE NULL
          END;

    v_remaining := GREATEST(0, 5 - v_new_fail);

    IF v_new_fail >= 5 THEN
      RETURN jsonb_build_object(
        'ok',                  false,
        'code',                'rate_limited',
        'retry_after_seconds', 60,
        'attempts_remaining',  0
      );
    ELSE
      RETURN jsonb_build_object(
        'ok',               false,
        'code',             'wrong_password',
        'attempts_remaining', v_remaining
      );
    END IF;
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.join_room_with_password(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.join_room_with_password(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.join_room_with_password(UUID, TEXT) TO authenticated;

-- ─────────────────────────────────────────────────────────────────
-- 2. 新增 verify_room_password_only
--    仅校验密码 + 限流，绝不写 room_members 或 memberships
-- ─────────────────────────────────────────────────────────────────
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
  v_rate_fail   INT         := 0;
  v_rate_locked TIMESTAMPTZ := NULL;
  v_rate_found  BOOLEAN     := FALSE;
  v_new_fail    INT;
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

  -- 2. 读取限流记录
  SELECT fail_count, locked_until
  INTO   v_rate_fail, v_rate_locked
  FROM   public.room_join_rate_limits
  WHERE  user_id = v_uid AND room_id = p_room_id
  FOR UPDATE;

  IF FOUND THEN v_rate_found := TRUE; END IF;

  -- 3. 锁定检查
  IF v_rate_found AND v_rate_locked IS NOT NULL AND v_rate_locked > NOW() THEN
    v_lock_secs := EXTRACT(EPOCH FROM (v_rate_locked - NOW()))::INT;
    RETURN jsonb_build_object(
      'ok',                  false,
      'code',                'rate_limited',
      'retry_after_seconds', v_lock_secs
    );
  END IF;

  -- 4. 获取 hash
  SELECT pwd_hash INTO v_hash
  FROM public.room_secrets
  WHERE room_id = p_room_id;

  IF v_hash IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_found');
  END IF;

  -- 5. bcrypt 校验
  IF crypt(p_password, v_hash) = v_hash THEN
    -- ✅ 密码正确：清除该用户+房间的限流记录
    DELETE FROM public.room_join_rate_limits
    WHERE user_id = v_uid AND room_id = p_room_id;
    -- 注意：绝不写 room_members 或 memberships
    RETURN jsonb_build_object('ok', true, 'code', 'verified');
  ELSE
    -- ❌ 密码错误：与 join_room_with_password 共享相同限流规则
    v_new_fail := COALESCE(v_rate_fail, 0) + 1;

    INSERT INTO public.room_join_rate_limits
      (user_id, room_id, fail_count, last_fail_at, locked_until)
    VALUES (
      v_uid,
      p_room_id,
      v_new_fail,
      NOW(),
      CASE WHEN v_new_fail >= 5 THEN NOW() + INTERVAL '60 seconds' ELSE NULL END
    )
    ON CONFLICT (user_id, room_id) DO UPDATE
      SET fail_count   = v_new_fail,
          last_fail_at = NOW(),
          locked_until = CASE
            WHEN v_new_fail >= 5 THEN NOW() + INTERVAL '60 seconds'
            ELSE NULL
          END;

    v_remaining := GREATEST(0, 5 - v_new_fail);

    IF v_new_fail >= 5 THEN
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
GRANT EXECUTE ON FUNCTION public.verify_room_password_only(UUID, TEXT) TO authenticated;
