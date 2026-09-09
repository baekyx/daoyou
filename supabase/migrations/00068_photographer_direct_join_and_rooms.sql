-- 摄影师新流程：输入正确房间密码后直接加入，不再等待导游审批。
-- 成功后持久化 memberships(role=photographer, approval_status=approved)，
-- 供照片表与 Storage 的现有 RLS 策略授权上传、删除。

CREATE OR REPLACE FUNCTION public.join_photographer_room_with_password(
  p_room_id UUID,
  p_password TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions
AS $$
DECLARE
  v_uid UUID;
  v_verify JSONB;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_authenticated');
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.profiles p
    WHERE p.id = v_uid
      AND p.role = 'photographer'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'forbidden');
  END IF;

  v_verify := public.verify_room_password_only(p_room_id, p_password);
  IF NOT COALESCE((v_verify->>'ok')::BOOLEAN, FALSE) THEN
    RETURN v_verify;
  END IF;

  INSERT INTO public.memberships (
    room_id,
    user_id,
    role,
    approval_status,
    rejection_reason,
    joined_at,
    left_at
  )
  VALUES (
    p_room_id,
    v_uid,
    'photographer',
    'approved',
    NULL,
    NOW(),
    NULL
  )
  ON CONFLICT (room_id, user_id) DO UPDATE
  SET role = 'photographer',
      approval_status = 'approved',
      rejection_reason = NULL,
      joined_at = NOW(),
      left_at = NULL;

  RETURN jsonb_build_object('ok', true, 'code', 'joined');
END;
$$;

REVOKE ALL ON FUNCTION public.join_photographer_room_with_password(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.join_photographer_room_with_password(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.join_photographer_room_with_password(UUID, TEXT) TO authenticated;

-- 只向游客/摄影师公开主动设置为“可发现”的待开始或进行中房间。
CREATE OR REPLACE FUNCTION public.get_active_rooms_secure()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = 'public'
AS $$
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'id',                  room_rows.id,
        'room_number',         room_rows.room_number,
        'name',                room_rows.name,
        'cover_url',           room_rows.cover_url,
        'guide_id',            room_rows.guide_id,
        'status',              room_rows.status,
        'discoverable',        room_rows.discoverable,
        'estimated_duration',  room_rows.estimated_duration,
        'actual_duration',     room_rows.actual_duration,
        'online_count',        room_rows.online_count,
        'started_at',          room_rows.started_at,
        'ended_at',            room_rows.ended_at,
        'created_at',          room_rows.created_at,
        'guide',               jsonb_build_object(
          'id',         room_rows.profile_id,
          'username',   room_rows.username,
          'nickname',   room_rows.nickname,
          'avatar_url', room_rows.avatar_url
        )
      )
      ORDER BY room_rows.created_at DESC
    ),
    '[]'::JSONB
  )
  FROM (
    SELECT
      r.*,
      p.id AS profile_id,
      p.username,
      p.nickname,
      p.avatar_url
    FROM public.rooms r
    LEFT JOIN public.profiles p ON p.id = r.guide_id
    WHERE r.status IN ('pending', 'live')
      AND r.discoverable IS TRUE
    ORDER BY r.created_at DESC
    LIMIT 30
  ) room_rows;
$$;

REVOKE ALL ON FUNCTION public.get_active_rooms_secure() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_active_rooms_secure() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_active_rooms_secure() TO authenticated;

-- 摄影师删除本人照片不依赖房间仍处于进行中，也不需要导游审批。
DROP POLICY IF EXISTS "photos: 摄影师可删除自己的" ON public.photos;
DROP POLICY IF EXISTS "photos: 已授权摄影师可删除自己的" ON public.photos;
CREATE POLICY "photos: 摄影师可删除自己的"
ON public.photos FOR DELETE TO authenticated
USING (photographer_id = auth.uid());

-- Storage 路径为 {room_id}/{photographer_id}/{filename}，只允许路径所属本人删除。
DROP POLICY IF EXISTS "photos: 摄影师可删除" ON storage.objects;
DROP POLICY IF EXISTS "photos: 已授权摄影师可删除" ON storage.objects;
CREATE POLICY "photos: 摄影师可删除"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'photos'
  AND (storage.foldername(objects.name))[2] = auth.uid()::text
);

-- 导游历史成员：返回除导游外所有实际进入过房间的人。
-- 游客来自 room_members，摄影师来自 approved memberships；同一用户只返回一次。
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
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.rooms
    WHERE rooms.id = p_room_id
      AND rooms.guide_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'permission_denied';
  END IF;

  RETURN QUERY
  WITH entered_members AS (
    SELECT
      rm.id,
      rm.room_id,
      rm.user_id,
      rm.role::TEXT AS role,
      rm.joined_at,
      rm.left_at
    FROM public.room_members rm
    WHERE rm.room_id = p_room_id
      AND rm.role::TEXT <> 'guide'

    UNION ALL

    SELECT
      m.id,
      m.room_id,
      m.user_id,
      m.role::TEXT AS role,
      m.joined_at,
      m.left_at
    FROM public.memberships m
    WHERE m.room_id = p_room_id
      AND m.approval_status = 'approved'
      AND m.role::TEXT <> 'guide'
  ),
  unique_members AS (
    SELECT DISTINCT ON (entered_members.user_id)
      entered_members.*,
      MIN(entered_members.joined_at) OVER (
        PARTITION BY entered_members.user_id
      ) AS first_joined_at
    FROM entered_members
    ORDER BY
      entered_members.user_id,
      CASE WHEN entered_members.role = 'photographer' THEN 0 ELSE 1 END,
      entered_members.joined_at ASC
  )
  SELECT
    um.id,
    um.room_id,
    um.user_id,
    um.role,
    um.first_joined_at,
    um.left_at,
    p.id,
    p.username,
    p.nickname,
    p.avatar_url
  FROM unique_members um
  LEFT JOIN public.profiles p ON p.id = um.user_id
  ORDER BY um.joined_at ASC;
END;
$$;

REVOKE ALL ON FUNCTION public.get_room_member_history_safe(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_room_member_history_safe(UUID) FROM anon;
GRANT EXECUTE ON FUNCTION public.get_room_member_history_safe(UUID) TO authenticated;
