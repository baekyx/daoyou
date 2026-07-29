
-- ══════════════════════════════════════════════════════════════════
-- A3-03p-01: get_room_members_safe
--   调用者必须是该房 guide 或有效 room_members（left_at IS NULL）
--   返回字段与前端 RoomMember 接口兼容：
--     id, room_id, user_id, role, joined_at, left_at（null）
--     + profile 嵌套：id, username, nickname, avatar_url
--   SECURITY DEFINER, search_path 固定, REVOKE PUBLIC/anon
-- ══════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION public.get_room_members_safe(p_room_id uuid)
RETURNS TABLE (
  id          uuid,
  room_id     uuid,
  user_id     uuid,
  role        text,
  joined_at   timestamptz,
  left_at     timestamptz,
  profile_id         uuid,
  profile_username   text,
  profile_nickname   text,
  profile_avatar_url text
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
  SELECT
    rm.id,
    rm.room_id,
    rm.user_id,
    rm.role::text,
    rm.joined_at,
    rm.left_at,
    p.id          AS profile_id,
    p.username    AS profile_username,
    p.nickname    AS profile_nickname,
    p.avatar_url  AS profile_avatar_url
  FROM public.room_members rm
  LEFT JOIN public.profiles p ON p.id = rm.user_id
  WHERE rm.room_id = p_room_id
    AND rm.left_at IS NULL
  ORDER BY rm.joined_at ASC
  LIMIT 200;
END;
$$;

REVOKE ALL ON FUNCTION public.get_room_members_safe(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_room_members_safe(uuid) TO authenticated, service_role;

-- 验收断言
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
    WHERE p.proname='get_room_members_safe'
  ) THEN RAISE EXCEPTION 'a3_03p_01 FAIL: get_room_members_safe not found'; END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema='public' AND routine_name='get_room_members_safe'
      AND privilege_type='EXECUTE' AND grantee IN ('PUBLIC','anon')
  ) THEN RAISE EXCEPTION 'a3_03p_01 FAIL: still grants PUBLIC/anon'; END IF;
  RAISE NOTICE 'a3_03p_01 PASS: get_room_members_safe created, no PUBLIC/anon EXECUTE';
END;
$$;
