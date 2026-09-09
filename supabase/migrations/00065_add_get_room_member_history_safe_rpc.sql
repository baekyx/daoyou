-- get_room_member_history_safe: 返回指定房间全部 tourist 历史成员（含已退出）
-- 权限：调用方必须是该房间的 guide（rooms.guide_id = auth.uid()）
-- 按 joined_at ASC 排序，主键去重；不按 left_at 过滤
CREATE OR REPLACE FUNCTION public.get_room_member_history_safe(p_room_id UUID)
RETURNS TABLE (
  id                  UUID,
  room_id             UUID,
  user_id             UUID,
  role                TEXT,
  joined_at           TIMESTAMPTZ,
  left_at             TIMESTAMPTZ,
  profile_id          UUID,
  profile_username    TEXT,
  profile_nickname    TEXT,
  profile_avatar_url  TEXT
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 仅允许该房间的导游调用
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.rooms
    WHERE id = p_room_id AND guide_id = auth.uid()
  ) THEN
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
  WHERE rm.room_id    = p_room_id
    AND rm.role::text = 'tourist'
  ORDER BY rm.joined_at ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_room_member_history_safe(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_room_member_history_safe(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_room_member_history_safe(UUID) TO authenticated;
