
-- ══════════════════════════════════════════════════════════════════
-- A3-03-01: 安全读取 RPC 四件套
--   1. get_my_profile_private()              本人资料（无入参，仅 auth.uid()）
--   2. get_room_public_profiles(p_room_id)   房间成员公开资料（导游/有效成员）
--   3. get_room_subtitles(p_room_id, p_limit, p_before)  字幕安全读取
--   4. get_room_photos(p_room_id, p_limit, p_before)     照片安全读取
-- 全部 SECURITY DEFINER, search_path 固定, REVOKE PUBLIC/anon, GRANT authenticated
-- ══════════════════════════════════════════════════════════════════

-- ─── 辅助：校验调用者是否为指定房间的导游或有效成员 ───────────────
CREATE OR REPLACE FUNCTION public._is_room_participant(p_room_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  RETURN (
    -- 该房导游
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = p_room_id AND r.guide_id = auth.uid()
    )
    OR
    -- 有效成员（left_at IS NULL）
    EXISTS (
      SELECT 1 FROM public.room_members rm
      WHERE rm.room_id = p_room_id
        AND rm.user_id = auth.uid()
        AND rm.left_at IS NULL
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public._is_room_participant(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._is_room_participant(uuid) TO authenticated, service_role;

-- ─── 1. get_my_profile_private() ─────────────────────────────────
-- 无入参，仅返回调用者本人安全字段，永不返回微信凭据
CREATE OR REPLACE FUNCTION public.get_my_profile_private()
RETURNS TABLE (
  id          uuid,
  username    text,
  nickname    text,
  avatar_url  text,
  phone       text,
  role        text,
  gender      text,
  created_at  timestamptz,
  updated_at  timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  RETURN QUERY
  SELECT
    p.id,
    p.username,
    p.nickname,
    p.avatar_url,
    p.phone,
    p.role::text,
    p.gender,
    p.created_at,
    p.updated_at
  FROM public.profiles p
  WHERE p.id = auth.uid();
END;
$$;

REVOKE ALL ON FUNCTION public.get_my_profile_private() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_my_profile_private() TO authenticated, service_role;

-- ─── 2. get_room_public_profiles(p_room_id) ──────────────────────
-- 调用者必须是该房导游或有效成员，只返回最小公开字段
-- 禁止枚举任意用户；禁止返回 phone/gender/微信字段
CREATE OR REPLACE FUNCTION public.get_room_public_profiles(p_room_id uuid)
RETURNS TABLE (
  id          uuid,
  username    text,
  nickname    text,
  avatar_url  text,
  member_role text   -- 'guide' | 'tourist'（来自 room_members.role）
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public._is_room_participant(p_room_id) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  RETURN QUERY
  -- 导游（来自 rooms）
  SELECT
    p.id,
    p.username,
    p.nickname,
    p.avatar_url,
    'guide'::text AS member_role
  FROM public.rooms r
  JOIN public.profiles p ON p.id = r.guide_id
  WHERE r.id = p_room_id

  UNION ALL

  -- 有效成员（left_at IS NULL）
  SELECT
    p.id,
    p.username,
    p.nickname,
    p.avatar_url,
    rm.role::text AS member_role
  FROM public.room_members rm
  JOIN public.profiles p ON p.id = rm.user_id
  WHERE rm.room_id = p_room_id
    AND rm.left_at IS NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.get_room_public_profiles(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_room_public_profiles(uuid) TO authenticated, service_role;

-- ─── 3. get_room_subtitles(p_room_id, p_limit, p_before) ─────────
-- 调用者必须是该房导游或有效成员
-- p_limit 限制 1..100；p_before 用于游标分页（可为 NULL 表示最新）
CREATE OR REPLACE FUNCTION public.get_room_subtitles(
  p_room_id uuid,
  p_limit   int     DEFAULT 50,
  p_before  timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id               uuid,
  room_id          uuid,
  content_cn       text,
  content_en       text,
  audio_url        text,
  chinese_audio_url text,
  created_at       timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 100);
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;
  IF NOT public._is_room_participant(p_room_id) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  RETURN QUERY
  SELECT
    s.id, s.room_id, s.content_cn, s.content_en,
    s.audio_url, s.chinese_audio_url, s.created_at
  FROM public.subtitles s
  WHERE s.room_id = p_room_id
    AND (p_before IS NULL OR s.created_at < p_before)
  ORDER BY s.created_at DESC
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.get_room_subtitles(uuid, int, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_room_subtitles(uuid, int, timestamptz) TO authenticated, service_role;

-- ─── 4. get_room_photos(p_room_id, p_limit, p_before) ────────────
-- 调用者须为：该房导游 OR 有效 room_members OR approved photographer（memberships）
CREATE OR REPLACE FUNCTION public.get_room_photos(
  p_room_id uuid,
  p_limit   int     DEFAULT 50,
  p_before  timestamptz DEFAULT NULL
)
RETURNS TABLE (
  id               uuid,
  room_id          uuid,
  photographer_id  uuid,
  url              text,
  taken_at         timestamptz,
  uploaded_at      timestamptz,
  photographer_nickname text,
  photographer_username text,
  photographer_avatar   text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_limit int := LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
  v_allowed bool := false;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'not_authenticated'; END IF;

  -- 导游或有效成员
  IF public._is_room_participant(p_room_id) THEN
    v_allowed := true;
  END IF;

  -- approved photographer（memberships）
  IF NOT v_allowed THEN
    SELECT EXISTS(
      SELECT 1 FROM public.memberships m
      WHERE m.room_id = p_room_id
        AND m.user_id = auth.uid()
        AND m.role = 'photographer'
        AND m.approval_status = 'approved'
        AND m.left_at IS NULL
    ) INTO v_allowed;
  END IF;

  IF NOT v_allowed THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  RETURN QUERY
  SELECT
    ph.id,
    ph.room_id,
    ph.photographer_id,
    ph.url,
    ph.taken_at,
    ph.uploaded_at,
    p.nickname  AS photographer_nickname,
    p.username  AS photographer_username,
    p.avatar_url AS photographer_avatar
  FROM public.photos ph
  LEFT JOIN public.profiles p ON p.id = ph.photographer_id
  WHERE ph.room_id = p_room_id
    AND (p_before IS NULL OR ph.uploaded_at < p_before)
  ORDER BY ph.uploaded_at DESC
  LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.get_room_photos(uuid, int, timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_room_photos(uuid, int, timestamptz) TO authenticated, service_role;

-- ─── 验收断言 ─────────────────────────────────────────────────────
DO $$
DECLARE
  v_fn TEXT;
BEGIN
  FOR v_fn IN VALUES
    ('get_my_profile_private'),
    ('get_room_public_profiles'),
    ('get_room_subtitles'),
    ('get_room_photos'),
    ('_is_room_participant')
  LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
      WHERE p.proname = v_fn
    ) THEN
      RAISE EXCEPTION 'a3_03_01 FAIL: % not found', v_fn;
    END IF;
    -- 确认无 PUBLIC/anon EXECUTE（只检查是否 NOT LIKE '%PUBLIC%' 或 '%anon%'）
    IF EXISTS (
      SELECT 1 FROM information_schema.routine_privileges rp
      WHERE rp.routine_schema = 'public'
        AND rp.routine_name = v_fn
        AND rp.privilege_type = 'EXECUTE'
        AND rp.grantee IN ('PUBLIC', 'anon')
    ) THEN
      RAISE EXCEPTION 'a3_03_01 FAIL: % still grants EXECUTE to PUBLIC/anon', v_fn;
    END IF;
  END LOOP;
  RAISE NOTICE 'a3_03_01 PASS: all 5 secure RPC functions created, no PUBLIC/anon EXECUTE';
END;
$$;
