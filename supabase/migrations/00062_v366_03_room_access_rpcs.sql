
-- ══════════════════════════════════════════════════════════════════
-- v366 Migration 03: 改造所有 room 访问相关 RPC
-- 有效授权唯一判定：access_granted_at IS NOT NULL AND access_revoked_at IS NULL
-- ══════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 1. check_room_access (新增)
--    只读 RPC；前端所有入口调用此函数决定路由
--    返回：authorized(bool), room_status(text), reason(text)
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.check_room_access(
  p_room_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_uid         UUID;
  v_room_status TEXT;
  v_authorized  BOOLEAN := FALSE;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object(
      'authorized', false,
      'room_status', null,
      'reason', 'not_authenticated'
    );
  END IF;

  SELECT status::text INTO v_room_status FROM public.rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'authorized', false,
      'room_status', null,
      'reason', 'room_not_found'
    );
  END IF;

  -- 有效授权：access_granted_at IS NOT NULL AND access_revoked_at IS NULL
  SELECT EXISTS(
    SELECT 1 FROM public.room_members
    WHERE room_id   = p_room_id
      AND user_id   = v_uid
      AND access_granted_at IS NOT NULL
      AND access_revoked_at IS NULL
  ) INTO v_authorized;

  RETURN jsonb_build_object(
    'authorized',   v_authorized,
    'room_status',  v_room_status,
    'reason',
      CASE
        WHEN v_authorized                          THEN 'authorized'
        WHEN v_room_status NOT IN ('pending','live') THEN 'room_not_active'
        ELSE                                           'no_access'
      END
  );
END;
$$;

REVOKE ALL ON FUNCTION public.check_room_access(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.check_room_access(UUID) FROM anon;
GRANT  EXECUTE ON FUNCTION public.check_room_access(UUID) TO authenticated;

-- ────────────────────────────────────────────────────────────────
-- 2. join_room_with_password (改造 - 最新版)
--    有效授权 → 免密恢复（不检查密码）
--    无授权   → 限流 + bcrypt 校验 → 成功写 access_granted_at
-- ────────────────────────────────────────────────────────────────
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

  -- 检查有效授权（access_granted_at IS NOT NULL AND access_revoked_at IS NULL）
  SELECT EXISTS(
    SELECT 1 FROM public.room_members
    WHERE room_id           = p_room_id
      AND user_id           = v_uid
      AND access_granted_at IS NOT NULL
      AND access_revoked_at IS NULL
  ) INTO v_authorized;

  IF v_authorized THEN
    -- 有效授权：免密恢复，更新 left_at=NULL（重新在线）
    UPDATE public.room_members
    SET left_at = NULL
    WHERE room_id = p_room_id AND user_id = v_uid;
    RETURN jsonb_build_object('ok', true, 'code', 'resumed');
  END IF;

  -- 无有效授权：必须走密码校验
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
    -- 密码正确：清限流记录 + upsert room_members，写入授权字段
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
    -- 密码错误：只更新限流，不写 room_members / 不写授权
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

-- ────────────────────────────────────────────────────────────────
-- 3. resume_room_membership (改造)
--    只承认有效授权；不能只凭历史 row 存在放行
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.resume_room_membership(
  p_room_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_uid        UUID;
  v_authorized BOOLEAN;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated');
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.room_members
    WHERE room_id           = p_room_id
      AND user_id           = v_uid
      AND access_granted_at IS NOT NULL
      AND access_revoked_at IS NULL
  ) INTO v_authorized;

  IF NOT v_authorized THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authorized');
  END IF;

  UPDATE public.room_members
  SET left_at = NULL
  WHERE room_id = p_room_id AND user_id = v_uid;

  RETURN jsonb_build_object('ok', true, 'code', 'resumed');
END;
$$;

REVOKE ALL ON FUNCTION public.resume_room_membership(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resume_room_membership(UUID) FROM anon;
GRANT  EXECUTE ON FUNCTION public.resume_room_membership(UUID) TO authenticated;

-- ────────────────────────────────────────────────────────────────
-- 4. has_joined_room_secure (改造)
--    只承认有效授权
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.has_joined_room_secure(
  p_room_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_uid    UUID;
  v_result BOOLEAN;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RETURN FALSE; END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.room_members
    WHERE room_id           = p_room_id
      AND user_id           = v_uid
      AND access_granted_at IS NOT NULL
      AND access_revoked_at IS NULL
  ) INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.has_joined_room_secure(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_joined_room_secure(UUID) FROM anon;
GRANT  EXECUTE ON FUNCTION public.has_joined_room_secure(UUID) TO authenticated;

-- ────────────────────────────────────────────────────────────────
-- 5. restore_current_room_secure (改造)
--    仅恢复：有效授权 + left_at IS NULL + pending/live 的实时房间
--    ended 不恢复（前端导航到历史页的逻辑在 check_room_access 中处理）
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.restore_current_room_secure()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT jsonb_build_object(
    'id',                  r.id,
    'room_number',         r.room_number,
    'name',                r.name,
    'cover_url',           r.cover_url,
    'guide_id',            r.guide_id,
    'status',              r.status,
    'discoverable',        r.discoverable,
    'estimated_duration',  r.estimated_duration,
    'actual_duration',     r.actual_duration,
    'online_count',        r.online_count,
    'started_at',          r.started_at,
    'ended_at',            r.ended_at,
    'created_at',          r.created_at,
    'guide',               jsonb_build_object(
      'id',         p.id,
      'username',   p.username,
      'nickname',   p.nickname,
      'avatar_url', p.avatar_url
    )
  )
  FROM public.rooms r
  JOIN public.room_members rm ON rm.room_id = r.id
  LEFT JOIN public.profiles p ON p.id = r.guide_id
  WHERE rm.user_id           = auth.uid()
    AND rm.access_granted_at IS NOT NULL      -- 有效授权
    AND rm.access_revoked_at IS NULL          -- 未被撤销
    AND rm.left_at           IS NULL          -- 当前在线
    AND r.status             IN ('pending', 'live')   -- 仅恢复实时房间
  ORDER BY
    CASE r.status WHEN 'live' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END ASC,
    rm.joined_at DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.restore_current_room_secure() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.restore_current_room_secure() FROM anon;
GRANT  EXECUTE ON FUNCTION public.restore_current_room_secure() TO authenticated;
