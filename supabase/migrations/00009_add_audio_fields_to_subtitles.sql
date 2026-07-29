-- 给 subtitles 表加 audio_url（英文TTS）和 chinese_audio_url（中文原声）字段
ALTER TABLE public.subtitles
  ADD COLUMN IF NOT EXISTS audio_url text DEFAULT '' NOT NULL,
  ADD COLUMN IF NOT EXISTS chinese_audio_url text DEFAULT '' NOT NULL;

-- 创建 audio 存储桶（公开读）
INSERT INTO storage.buckets (id, name, public)
VALUES ('audio', 'audio', true)
ON CONFLICT (id) DO NOTHING;

-- audio 桶 RLS 策略
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname='audio_select_all' AND polrelid='storage.objects'::regclass) THEN
    EXECUTE 'CREATE POLICY audio_select_all ON storage.objects FOR SELECT USING (bucket_id = ''audio'')';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname='audio_insert_all' AND polrelid='storage.objects'::regclass) THEN
    EXECUTE 'CREATE POLICY audio_insert_all ON storage.objects FOR INSERT WITH CHECK (bucket_id = ''audio'')';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname='audio_update_all' AND polrelid='storage.objects'::regclass) THEN
    EXECUTE 'CREATE POLICY audio_update_all ON storage.objects FOR UPDATE USING (bucket_id = ''audio'')';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polname='audio_delete_all' AND polrelid='storage.objects'::regclass) THEN
    EXECUTE 'CREATE POLICY audio_delete_all ON storage.objects FOR DELETE USING (bucket_id = ''audio'')';
  END IF;
END $$;

-- 确保 subtitles 表在 Realtime 发布里
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname='supabase_realtime')
  AND NOT EXISTS (
    SELECT 1 FROM pg_publication_rel pr
    JOIN pg_publication p ON p.oid = pr.prpubid
    WHERE p.pubname='supabase_realtime' AND pr.prrelid='public.subtitles'::regclass
  ) THEN
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.subtitles';
  END IF;
END $$;