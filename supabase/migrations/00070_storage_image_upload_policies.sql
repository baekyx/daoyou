-- 图片上传闭环：补齐 bucket 与 storage.objects 权限。
-- 固定路径：
--   avatars/{user_id}/avatar.jpg
--   room-covers/{guide_id}/{room_id}.jpg
--   card-images/{guide_id}/{card_id}.jpg
--   photos/{room_id}/{photographer_id}/{filename}

INSERT INTO storage.buckets (id, name, public)
VALUES
  ('avatars', 'avatars', true),
  ('room-covers', 'room-covers', true),
  ('photos', 'photos', true),
  ('card-images', 'card-images', true)
ON CONFLICT (id) DO UPDATE SET public = EXCLUDED.public;

-- ── 头像：仅本人目录可写，可覆盖 ─────────────────────────────
DROP POLICY IF EXISTS "avatars: 已登录可上传" ON storage.objects;
DROP POLICY IF EXISTS "avatars: 公开可读" ON storage.objects;
DROP POLICY IF EXISTS "avatars: 本人可上传" ON storage.objects;
DROP POLICY IF EXISTS "avatars: 本人可更新" ON storage.objects;
DROP POLICY IF EXISTS "avatars: 本人可删除" ON storage.objects;

CREATE POLICY "avatars: 公开可读"
ON storage.objects FOR SELECT TO public
USING (bucket_id = 'avatars');

CREATE POLICY "avatars: 本人可上传"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'avatars'
  AND (storage.foldername(objects.name))[1] = auth.uid()::text
);

CREATE POLICY "avatars: 本人可更新"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'avatars'
  AND (storage.foldername(objects.name))[1] = auth.uid()::text
)
WITH CHECK (
  bucket_id = 'avatars'
  AND (storage.foldername(objects.name))[1] = auth.uid()::text
);

CREATE POLICY "avatars: 本人可删除"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'avatars'
  AND (storage.foldername(objects.name))[1] = auth.uid()::text
);

-- ── 房间封面：仅房间所属导游可写，可覆盖 ───────────────────
DROP POLICY IF EXISTS "room-covers: 导游可上传" ON storage.objects;
DROP POLICY IF EXISTS "room-covers: 公开可读" ON storage.objects;
DROP POLICY IF EXISTS "room-covers: 房主可上传" ON storage.objects;
DROP POLICY IF EXISTS "room-covers: 房主可更新" ON storage.objects;
DROP POLICY IF EXISTS "room-covers: 房主可删除" ON storage.objects;

CREATE POLICY "room-covers: 公开可读"
ON storage.objects FOR SELECT TO public
USING (bucket_id = 'room-covers');

CREATE POLICY "room-covers: 房主可上传"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'room-covers'
  AND (storage.foldername(objects.name))[1] = auth.uid()::text
  AND EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id::text = (storage.foldername(objects.name))[2]
      AND r.guide_id = auth.uid()
  )
);

CREATE POLICY "room-covers: 房主可更新"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'room-covers'
  AND (storage.foldername(objects.name))[1] = auth.uid()::text
  AND EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id::text = (storage.foldername(objects.name))[2]
      AND r.guide_id = auth.uid()
  )
)
WITH CHECK (
  bucket_id = 'room-covers'
  AND (storage.foldername(objects.name))[1] = auth.uid()::text
  AND EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id::text = (storage.foldername(objects.name))[2]
      AND r.guide_id = auth.uid()
  )
);

CREATE POLICY "room-covers: 房主可删除"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'room-covers'
  AND (storage.foldername(objects.name))[1] = auth.uid()::text
);

-- ── 卡片图片：仅导游本人目录可写，可覆盖 ───────────────────
DROP POLICY IF EXISTS "card-images: 导游可上传" ON storage.objects;
DROP POLICY IF EXISTS "card-images: 公开可读" ON storage.objects;
DROP POLICY IF EXISTS "card-images: 导游本人可上传" ON storage.objects;
DROP POLICY IF EXISTS "card-images: 导游本人可更新" ON storage.objects;
DROP POLICY IF EXISTS "card-images: 导游本人可删除" ON storage.objects;

CREATE POLICY "card-images: 公开可读"
ON storage.objects FOR SELECT TO public
USING (bucket_id = 'card-images');

CREATE POLICY "card-images: 导游本人可上传"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'card-images'
  AND (storage.foldername(objects.name))[1] = auth.uid()::text
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.role = 'guide'
  )
);

CREATE POLICY "card-images: 导游本人可更新"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'card-images'
  AND (storage.foldername(objects.name))[1] = auth.uid()::text
)
WITH CHECK (
  bucket_id = 'card-images'
  AND (storage.foldername(objects.name))[1] = auth.uid()::text
  AND EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = auth.uid() AND p.role = 'guide'
  )
);

CREATE POLICY "card-images: 导游本人可删除"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'card-images'
  AND (storage.foldername(objects.name))[1] = auth.uid()::text
);

-- ── 摄影师照片：上传/更新需有效任务；本人始终可清理自己的路径 ──
DROP POLICY IF EXISTS "photos: 摄影师可上传" ON storage.objects;
DROP POLICY IF EXISTS "photos: 已授权摄影师可上传" ON storage.objects;
DROP POLICY IF EXISTS "photos: 已授权摄影师可更新" ON storage.objects;
DROP POLICY IF EXISTS "photos: 已授权摄影师可删除" ON storage.objects;
DROP POLICY IF EXISTS "photos: 摄影师可删除" ON storage.objects;

CREATE POLICY "photos: 已授权摄影师可上传"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'photos'
  AND (storage.foldername(objects.name))[2] = auth.uid()::text
  AND EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.room_id::text = (storage.foldername(objects.name))[1]
      AND m.user_id = auth.uid()
      AND m.role = 'photographer'
      AND m.approval_status = 'approved'
      AND m.left_at IS NULL
  )
);

CREATE POLICY "photos: 已授权摄影师可更新"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'photos'
  AND (storage.foldername(objects.name))[2] = auth.uid()::text
)
WITH CHECK (
  bucket_id = 'photos'
  AND (storage.foldername(objects.name))[2] = auth.uid()::text
  AND EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.room_id::text = (storage.foldername(objects.name))[1]
      AND m.user_id = auth.uid()
      AND m.role = 'photographer'
      AND m.approval_status = 'approved'
      AND m.left_at IS NULL
  )
);

CREATE POLICY "photos: 摄影师可删除"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'photos'
  AND (storage.foldername(objects.name))[2] = auth.uid()::text
);
