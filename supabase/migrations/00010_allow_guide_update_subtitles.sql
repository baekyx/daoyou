-- 英文翻译和 TTS 在中文字幕插入后异步补齐，因此导游需要更新自己房间的字幕。
ALTER TABLE public.subtitles ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "subtitles: 导游可更新" ON public.subtitles;
CREATE POLICY "subtitles: 导游可更新" ON public.subtitles
  FOR UPDATE TO authenticated
  USING (room_id IN (SELECT id FROM public.rooms WHERE guide_id = auth.uid()))
  WITH CHECK (room_id IN (SELECT id FROM public.rooms WHERE guide_id = auth.uid()));
