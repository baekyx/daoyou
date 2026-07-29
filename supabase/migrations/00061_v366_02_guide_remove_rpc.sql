
-- ══════════════════════════════════════════════════════════════════
-- v366 Migration 02: guide_remove_room_member RPC
-- 导游移出游客：同时设置 left_at=now() + access_revoked_at=now()
-- 与普通 leaveRoom 的区别：普通离开只设 left_at，不触碰 access_revoked_at
-- ══════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.guide_remove_room_member(
  p_room_id   UUID,
  p_member_id UUID   -- 被移出的 user_id（非 room_members.id）
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public'
AS $$
DECLARE
  v_uid        UUID;
  v_guide_id   UUID;
  v_member_exists BOOLEAN;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated');
  END IF;

  -- 验证调用者是该房间的导游
  SELECT guide_id INTO v_guide_id FROM public.rooms WHERE id = p_room_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'room_not_found');
  END IF;
  IF v_guide_id IS DISTINCT FROM v_uid THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;

  -- 不允许导游移除自己
  IF p_member_id = v_uid THEN
    RETURN jsonb_build_object('ok', false, 'code', 'cannot_remove_self');
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM public.room_members
    WHERE room_id = p_room_id AND user_id = p_member_id
  ) INTO v_member_exists;

  IF NOT v_member_exists THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_a_member');
  END IF;

  -- 同时设置 left_at + access_revoked_at，撤销免密授权
  UPDATE public.room_members
  SET
    left_at           = NOW(),
    access_revoked_at = NOW()
  WHERE room_id = p_room_id AND user_id = p_member_id;

  RETURN jsonb_build_object('ok', true, 'code', 'removed');
END;
$$;

REVOKE ALL ON FUNCTION public.guide_remove_room_member(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guide_remove_room_member(UUID, UUID) FROM anon;
GRANT  EXECUTE ON FUNCTION public.guide_remove_room_member(UUID, UUID) TO authenticated;
