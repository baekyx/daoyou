
-- ══════════════════════════════════════════════════════════════════
-- A2 预置 Migration 02 — 安全 RPC 全套
-- 所有函数：SECURITY DEFINER, fixed search_path, REVOKE PUBLIC/anon
-- ══════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────
-- 辅助：安全房间字段投影（排除 password）
-- ────────────────────────────────────────────────────────────────
-- 用于各 RPC 返回统一安全结构（不含 password）
-- 注意：RPC 返回类型直接用 RECORD，或在 SELECT 中明确排除 password

-- ────────────────────────────────────────────────────────────────
-- 1. join_room_with_password
--    首次加入：服务端 bcrypt 校验 + 限流；已有成员免密恢复
-- ────────────────────────────────────────────────────────────────
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
  v_uid          UUID;
  v_room_status  public.room_status;
  v_hash         TEXT;
  v_rate         public.room_join_rate_limits%ROWTYPE;
  v_remaining    INT;
  v_lock_secs    INT;
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

  -- 2. 检查是否已有成员记录（免密恢复路径）
  SELECT EXISTS(
    SELECT 1 FROM public.room_members
    WHERE room_id = p_room_id AND user_id = v_uid
  ) INTO v_member_exists;

  IF v_member_exists THEN
    -- 已有记录：免密恢复 left_at = null
    UPDATE public.room_members
    SET left_at = NULL
    WHERE room_id = p_room_id AND user_id = v_uid;
    RETURN jsonb_build_object('ok', true, 'code', 'resumed');
  END IF;

  -- 3. 首次加入：检查限流（FOR UPDATE 原子读写）
  SELECT * INTO v_rate
  FROM public.room_join_rate_limits
  WHERE user_id = v_uid AND room_id = p_room_id
  FOR UPDATE;

  IF FOUND AND v_rate.locked_until IS NOT NULL AND v_rate.locked_until > NOW() THEN
    v_lock_secs := EXTRACT(EPOCH FROM (v_rate.locked_until - NOW()))::INT;
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'rate_limited',
      'retry_after_seconds', v_lock_secs
    );
  END IF;

  -- 4. 获取 hash
  SELECT pwd_hash INTO v_hash
  FROM public.room_secrets
  WHERE room_id = p_room_id;

  IF NOT FOUND OR v_hash IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_found');
  END IF;

  -- 5. bcrypt 校验
  IF crypt(p_password, v_hash) = v_hash THEN
    -- 密码正确：清除限流记录，upsert 成员
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
    -- 密码错误：更新限流计数
    IF NOT FOUND THEN
      -- 第一次失败（v_rate 是空的）
      INSERT INTO public.room_join_rate_limits
        (user_id, room_id, fail_count, last_fail_at, locked_until)
      VALUES
        (v_uid, p_room_id, 1, NOW(), NULL)
      ON CONFLICT (user_id, room_id) DO UPDATE
        SET fail_count   = room_join_rate_limits.fail_count + 1,
            last_fail_at = NOW(),
            locked_until = CASE
              WHEN room_join_rate_limits.fail_count + 1 >= 5
              THEN NOW() + INTERVAL '60 seconds'
              ELSE NULL
            END;
    ELSE
      UPDATE public.room_join_rate_limits
      SET fail_count   = fail_count + 1,
          last_fail_at = NOW(),
          locked_until = CASE
            WHEN fail_count + 1 >= 5
            THEN NOW() + INTERVAL '60 seconds'
            ELSE NULL
          END
      WHERE user_id = v_uid AND room_id = p_room_id;
    END IF;

    -- 查询最新 fail_count
    SELECT fail_count INTO v_remaining
    FROM public.room_join_rate_limits
    WHERE user_id = v_uid AND room_id = p_room_id;

    v_remaining := GREATEST(0, 5 - COALESCE(v_remaining, 1));

    RETURN jsonb_build_object(
      'ok', false,
      'code', 'wrong_password',
      'attempts_remaining', v_remaining
    );
  END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.join_room_with_password(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.join_room_with_password(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.join_room_with_password(UUID, TEXT) TO authenticated;

-- ────────────────────────────────────────────────────────────────
-- 2. resume_room_membership
--    仅已有成员本人可恢复 left_at=null
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
  v_uid UUID;
  v_exists BOOLEAN;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated');
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.room_members
    WHERE room_id = p_room_id AND user_id = v_uid
  ) INTO v_exists;

  IF NOT v_exists THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_a_member');
  END IF;

  UPDATE public.room_members
  SET left_at = NULL
  WHERE room_id = p_room_id AND user_id = v_uid;

  RETURN jsonb_build_object('ok', true, 'code', 'resumed');
END;
$$;

REVOKE ALL ON FUNCTION public.resume_room_membership(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resume_room_membership(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.resume_room_membership(UUID) TO authenticated;

-- ────────────────────────────────────────────────────────────────
-- 3. has_joined_room_secure
--    只返回当前 uid 是否已有记录（布尔）
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
  v_uid UUID;
  v_exists BOOLEAN;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RETURN FALSE; END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.room_members
    WHERE room_id = p_room_id AND user_id = v_uid
  ) INTO v_exists;

  RETURN v_exists;
END;
$$;

REVOKE ALL ON FUNCTION public.has_joined_room_secure(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_joined_room_secure(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.has_joined_room_secure(UUID) TO authenticated;

-- ────────────────────────────────────────────────────────────────
-- 4. create_room_secure
--    仅 guide；服务端生成唯一六位 room_number；并发安全
--    过渡期：写 rooms.password（触发器自动同步 hash）
--    返回：安全房间字段，不含 rooms.password
-- ────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.create_room_secure(
  p_name               TEXT,
  p_password           TEXT,
  p_cover_url          TEXT    DEFAULT NULL,
  p_estimated_duration INT     DEFAULT 60
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_uid         UUID;
  v_role        TEXT;
  v_existing    public.rooms%ROWTYPE;
  v_new_room    public.rooms%ROWTYPE;
  v_room_number TEXT;
  v_attempt     INT := 0;
  v_err_msg     TEXT;
BEGIN
  -- 0. 登录校验
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated');
  END IF;

  -- 1. 角色校验（仅 guide）
  SELECT role::TEXT INTO v_role FROM public.profiles WHERE id = v_uid;
  IF v_role IS DISTINCT FROM 'guide' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;

  -- 2. 参数校验
  p_name := TRIM(p_name);
  IF LENGTH(p_name) < 2 OR LENGTH(p_name) > 30 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_name');
  END IF;
  IF p_password !~ '^\d{6}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_password');
  END IF;

  -- 3. 查重：该导游已有 pending/live 房间
  SELECT * INTO v_existing
  FROM public.rooms
  WHERE guide_id = v_uid
    AND status IN ('pending', 'live')
  ORDER BY created_at DESC
  LIMIT 1
  FOR UPDATE;   -- 并发锁：防止两个请求同时通过查重

  IF FOUND THEN
    RETURN jsonb_build_object(
      'ok',     true,
      'code',   'existed',
      'room',   jsonb_build_object(
        'id',                  v_existing.id,
        'room_number',         v_existing.room_number,
        'name',                v_existing.name,
        'cover_url',           v_existing.cover_url,
        'guide_id',            v_existing.guide_id,
        'status',              v_existing.status,
        'discoverable',        v_existing.discoverable,
        'estimated_duration',  v_existing.estimated_duration,
        'actual_duration',     v_existing.actual_duration,
        'online_count',        v_existing.online_count,
        'started_at',          v_existing.started_at,
        'ended_at',            v_existing.ended_at,
        'created_at',          v_existing.created_at
      )
    );
  END IF;

  -- 4. 循环生成唯一 room_number，最多 10 次
  LOOP
    v_attempt := v_attempt + 1;
    IF v_attempt > 10 THEN
      RETURN jsonb_build_object('ok', false, 'code', 'room_number_exhausted');
    END IF;

    v_room_number := LPAD(
      (FLOOR(RANDOM() * 900000) + 100000)::TEXT,
      6, '0'
    );

    BEGIN
      INSERT INTO public.rooms (
        room_number, password, name, cover_url,
        guide_id, estimated_duration, status
      ) VALUES (
        v_room_number, p_password, p_name, p_cover_url,
        v_uid, p_estimated_duration, 'pending'
      )
      RETURNING * INTO v_new_room;

      -- 插入成功，退出循环
      EXIT;

    EXCEPTION
      WHEN unique_violation THEN
        -- 检查是哪个唯一约束
        GET STACKED DIAGNOSTICS v_err_msg = MESSAGE_TEXT;
        IF v_err_msg LIKE '%room_number%' OR v_err_msg LIKE '%rooms_room_number_key%' THEN
          CONTINUE;  -- room_number 冲突，重试
        ELSIF v_err_msg LIKE '%one_active_per_guide%' THEN
          -- 并发穿透：重查返回已有房间
          SELECT * INTO v_existing
          FROM public.rooms
          WHERE guide_id = v_uid AND status IN ('pending', 'live')
          ORDER BY created_at DESC LIMIT 1;
          IF FOUND THEN
            RETURN jsonb_build_object(
              'ok', true, 'code', 'existed',
              'room', jsonb_build_object(
                'id',                  v_existing.id,
                'room_number',         v_existing.room_number,
                'name',                v_existing.name,
                'cover_url',           v_existing.cover_url,
                'guide_id',            v_existing.guide_id,
                'status',              v_existing.status,
                'discoverable',        v_existing.discoverable,
                'estimated_duration',  v_existing.estimated_duration,
                'actual_duration',     v_existing.actual_duration,
                'online_count',        v_existing.online_count,
                'started_at',          v_existing.started_at,
                'ended_at',            v_existing.ended_at,
                'created_at',          v_existing.created_at
              )
            );
          END IF;
          RETURN jsonb_build_object('ok', false, 'code', 'concurrent_conflict');
        ELSE
          RAISE;
        END IF;
    END;
  END LOOP;

  -- 5. 触发器已自动写入 room_secrets，此处不重复写
  -- 返回安全字段（不含 password）
  RETURN jsonb_build_object(
    'ok',   true,
    'code', 'created',
    'room', jsonb_build_object(
      'id',                  v_new_room.id,
      'room_number',         v_new_room.room_number,
      'name',                v_new_room.name,
      'cover_url',           v_new_room.cover_url,
      'guide_id',            v_new_room.guide_id,
      'status',              v_new_room.status,
      'discoverable',        v_new_room.discoverable,
      'estimated_duration',  v_new_room.estimated_duration,
      'actual_duration',     v_new_room.actual_duration,
      'online_count',        v_new_room.online_count,
      'started_at',          v_new_room.started_at,
      'ended_at',            v_new_room.ended_at,
      'created_at',          v_new_room.created_at
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.create_room_secure(TEXT, TEXT, TEXT, INT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_room_secure(TEXT, TEXT, TEXT, INT) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_room_secure(TEXT, TEXT, TEXT, INT) TO authenticated;

-- ────────────────────────────────────────────────────────────────
-- 5. 安全读取 RPC 族（所有返回均不含 password）
-- ────────────────────────────────────────────────────────────────

-- 5a. get_active_rooms_secure：游客查看 pending/live 房间列表
CREATE OR REPLACE FUNCTION public.get_active_rooms_secure()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
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
      ORDER BY r.created_at DESC
    ),
    '[]'::JSONB
  )
  FROM public.rooms r
  LEFT JOIN public.profiles p ON p.id = r.guide_id
  WHERE r.status IN ('pending', 'live')
  LIMIT 30;
$$;

REVOKE ALL ON FUNCTION public.get_active_rooms_secure() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_active_rooms_secure() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_active_rooms_secure() TO authenticated;

-- 5b. get_room_by_number_secure：按 room_number 查（不含密码）
CREATE OR REPLACE FUNCTION public.get_room_by_number_secure(
  p_room_number TEXT
)
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
  LEFT JOIN public.profiles p ON p.id = r.guide_id
  WHERE r.room_number = p_room_number
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_room_by_number_secure(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_room_by_number_secure(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_room_by_number_secure(TEXT) TO authenticated;

-- 5c. get_room_by_id_secure：按 id 查（不含密码）
CREATE OR REPLACE FUNCTION public.get_room_by_id_secure(
  p_room_id UUID
)
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
  LEFT JOIN public.profiles p ON p.id = r.guide_id
  WHERE r.id = p_room_id
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_room_by_id_secure(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_room_by_id_secure(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_room_by_id_secure(UUID) TO authenticated;

-- 5d. get_guide_rooms_secure：导游自己的房间列表（不含密码）
CREATE OR REPLACE FUNCTION public.get_guide_rooms_secure()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
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
        'created_at',          r.created_at
      )
      ORDER BY r.created_at DESC
    ),
    '[]'::JSONB
  )
  FROM public.rooms r
  WHERE r.guide_id = auth.uid()
  LIMIT 50;
$$;

REVOKE ALL ON FUNCTION public.get_guide_rooms_secure() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_guide_rooms_secure() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_guide_rooms_secure() TO authenticated;

-- 5e. get_my_joined_rooms_secure：游客/摄影师已加入的房间（不含密码）
CREATE OR REPLACE FUNCTION public.get_my_joined_rooms_secure()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
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
      ORDER BY rm.joined_at DESC
    ),
    '[]'::JSONB
  )
  FROM public.room_members rm
  JOIN public.rooms r ON r.id = rm.room_id
  LEFT JOIN public.profiles p ON p.id = r.guide_id
  WHERE rm.user_id = auth.uid()
  LIMIT 30;
$$;

REVOKE ALL ON FUNCTION public.get_my_joined_rooms_secure() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_joined_rooms_secure() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_joined_rooms_secure() TO authenticated;

-- 5f. restore_current_room_secure：取代旧 restore_current_room_for_user，返回不含密码的房间
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
  WHERE rm.user_id = auth.uid()
    AND rm.left_at IS NULL
  ORDER BY
    CASE r.status
      WHEN 'live'    THEN 1
      WHEN 'pending' THEN 2
      ELSE               3
    END ASC,
    rm.joined_at DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.restore_current_room_secure() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.restore_current_room_secure() FROM anon;
GRANT EXECUTE ON FUNCTION public.restore_current_room_secure() TO authenticated;
