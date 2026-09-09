-- Persisted participation history and ended-room replay access.
-- Active rooms still require an active membership. Ended/archived rooms allow
-- the guide and people who actually joined to read saved subtitles/photos/minutes.

CREATE OR REPLACE FUNCTION public._is_room_participant(p_room_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN FALSE;
  END IF;

  RETURN (
    EXISTS (
      SELECT 1
      FROM public.rooms r
      WHERE r.id = p_room_id
        AND r.guide_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1
      FROM public.room_members rm
      JOIN public.rooms r ON r.id = rm.room_id
      WHERE rm.room_id = p_room_id
        AND rm.user_id = auth.uid()
        AND rm.access_granted_at IS NOT NULL
        AND rm.access_revoked_at IS NULL
        AND (
          (r.status::TEXT IN ('ended', 'archived'))
          OR (
            r.status::TEXT NOT IN ('ended', 'archived')
            AND rm.left_at IS NULL
          )
        )
    )
    OR EXISTS (
      SELECT 1
      FROM public.memberships m
      JOIN public.rooms r ON r.id = m.room_id
      WHERE m.room_id = p_room_id
        AND m.user_id = auth.uid()
        AND m.role = 'photographer'
        AND m.approval_status = 'approved'
        AND (
          r.status::TEXT IN ('ended', 'archived')
          OR (
            r.status::TEXT NOT IN ('ended', 'archived')
            AND m.left_at IS NULL
          )
        )
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public._is_room_participant(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public._is_room_participant(UUID) TO authenticated, service_role;

-- One persisted history feed for tourists and photographers. This is a
-- SECURITY DEFINER projection and never exposes room passwords.
CREATE OR REPLACE FUNCTION public.get_my_joined_rooms_secure()
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH joined AS (
    SELECT rm.room_id, rm.joined_at
    FROM public.room_members rm
    WHERE rm.user_id = auth.uid()
      AND rm.role::TEXT = 'tourist'

    UNION ALL

    SELECT m.room_id, m.joined_at
    FROM public.memberships m
    WHERE m.user_id = auth.uid()
      AND m.role::TEXT = 'photographer'
      AND m.approval_status = 'approved'
  ),
  unique_joined AS (
    SELECT room_id, MAX(joined_at) AS joined_at
    FROM joined
    GROUP BY room_id
    ORDER BY MAX(joined_at) DESC
    LIMIT 30
  )
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
      ORDER BY uj.joined_at DESC
    ),
    '[]'::JSONB
  )
  FROM unique_joined uj
  JOIN public.rooms r ON r.id = uj.room_id
  LEFT JOIN public.profiles p ON p.id = r.guide_id;
$$;

REVOKE ALL ON FUNCTION public.get_my_joined_rooms_secure() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_my_joined_rooms_secure() FROM anon;
GRANT EXECUTE ON FUNCTION public.get_my_joined_rooms_secure() TO authenticated;

-- Saved minutes are read-only for historical participants. Insert/update remain
-- guide-only under the existing policies.
DROP POLICY IF EXISTS "meeting_minutes: 房间参与者读取纪要" ON public.meeting_minutes;
CREATE POLICY "meeting_minutes: 房间参与者读取纪要"
ON public.meeting_minutes
FOR SELECT TO authenticated
USING (public._is_room_participant(room_id));
