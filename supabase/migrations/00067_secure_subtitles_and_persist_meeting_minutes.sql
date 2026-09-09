-- 收紧字幕 SELECT：仅房间导游或 left_at IS NULL 的有效成员可读取。
DROP POLICY IF EXISTS "subtitles: 任何已登录可查看" ON public.subtitles;
DROP POLICY IF EXISTS "subtitles: 房间参与者可查看" ON public.subtitles;
CREATE POLICY "subtitles: 房间参与者可查看"
ON public.subtitles
FOR SELECT
TO authenticated
USING (public._is_room_participant(room_id));

-- 会议纪要不再只保存在浏览器 localStorage，由导游按房间幂等持久化。
CREATE TABLE IF NOT EXISTS public.meeting_minutes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id uuid NOT NULL UNIQUE REFERENCES public.rooms(id) ON DELETE CASCADE,
  guide_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE DEFAULT auth.uid(),
  content jsonb NOT NULL,
  subtitle_count integer NOT NULL DEFAULT 0 CHECK (subtitle_count >= 0),
  generated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS meeting_minutes_guide_updated_idx
ON public.meeting_minutes (guide_id, updated_at DESC);

ALTER TABLE public.meeting_minutes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "meeting_minutes: 导游读取自己的纪要" ON public.meeting_minutes;
CREATE POLICY "meeting_minutes: 导游读取自己的纪要"
ON public.meeting_minutes
FOR SELECT TO authenticated
USING (
  guide_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.rooms
    WHERE rooms.id = meeting_minutes.room_id
      AND rooms.guide_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "meeting_minutes: 导游创建自己的纪要" ON public.meeting_minutes;
CREATE POLICY "meeting_minutes: 导游创建自己的纪要"
ON public.meeting_minutes
FOR INSERT TO authenticated
WITH CHECK (
  guide_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.rooms
    WHERE rooms.id = meeting_minutes.room_id
      AND rooms.guide_id = auth.uid()
  )
);

DROP POLICY IF EXISTS "meeting_minutes: 导游更新自己的纪要" ON public.meeting_minutes;
CREATE POLICY "meeting_minutes: 导游更新自己的纪要"
ON public.meeting_minutes
FOR UPDATE TO authenticated
USING (guide_id = auth.uid())
WITH CHECK (
  guide_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.rooms
    WHERE rooms.id = meeting_minutes.room_id
      AND rooms.guide_id = auth.uid()
  )
);

GRANT SELECT, INSERT, UPDATE ON public.meeting_minutes TO authenticated;
