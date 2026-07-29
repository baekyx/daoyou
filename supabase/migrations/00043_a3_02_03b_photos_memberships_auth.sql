
-- ══════════════════════════════════════════════════════════════════
-- A3-02-03b: photos RLS 收紧 + Storage photos 写权限收紧
-- (重试，前次因 migration 主键冲突失败，SQL 完全相同，仅重命名)
--
-- memberships 字段：role text, approval_status text, left_at TIMESTAMPTZ
-- 摄影授权条件：role='photographer' AND approval_status='approved' AND left_at IS NULL
-- ══════════════════════════════════════════════════════════════════

-- ── DB table: photos ─────────────────────────────────────────────
DROP POLICY IF EXISTS "photos: 摄影师可上传"           ON public.photos;
DROP POLICY IF EXISTS "photos: 摄影师可删除自己的"     ON public.photos;
DROP POLICY IF EXISTS "photos: 摄影师可更新自己的"     ON public.photos;
DROP POLICY IF EXISTS "photos: 已授权摄影师可上传"     ON public.photos;
DROP POLICY IF EXISTS "photos: 已授权摄影师可删除自己的" ON public.photos;
DROP POLICY IF EXISTS "photos: 已授权摄影师可更新自己的" ON public.photos;

-- INSERT：photographer_id=uid() + memberships 已批准摄影授权
CREATE POLICY "photos: 已授权摄影师可上传"
ON public.photos FOR INSERT TO authenticated
WITH CHECK (
  photographer_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.room_id = photos.room_id
      AND m.user_id = auth.uid()
      AND m.role = 'photographer'
      AND m.approval_status = 'approved'
      AND m.left_at IS NULL
  )
);

-- DELETE：本人 + 仍具备摄影授权
CREATE POLICY "photos: 已授权摄影师可删除自己的"
ON public.photos FOR DELETE TO authenticated
USING (
  photographer_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.room_id = photos.room_id
      AND m.user_id = auth.uid()
      AND m.role = 'photographer'
      AND m.approval_status = 'approved'
      AND m.left_at IS NULL
  )
);

-- UPDATE：本人 + 仍具备摄影授权
CREATE POLICY "photos: 已授权摄影师可更新自己的"
ON public.photos FOR UPDATE TO authenticated
USING (
  photographer_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.room_id = photos.room_id
      AND m.user_id = auth.uid()
      AND m.role = 'photographer'
      AND m.approval_status = 'approved'
      AND m.left_at IS NULL
  )
)
WITH CHECK (
  photographer_id = auth.uid()
  AND EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.room_id = photos.room_id
      AND m.user_id = auth.uid()
      AND m.role = 'photographer'
      AND m.approval_status = 'approved'
      AND m.left_at IS NULL
  )
);

-- SELECT 保持不变（photos: 任何已登录可查看）

-- ── Storage bucket: photos ────────────────────────────────────────
DROP POLICY IF EXISTS "photos: 摄影师可上传"       ON storage.objects;
DROP POLICY IF EXISTS "photos: 已授权摄影师可上传" ON storage.objects;

-- Storage INSERT：已登录 + memberships 摄影授权
-- 路径格式：{room_id}/{photographer_id}/{filename}
-- (storage.foldername(name))[1] = room_id
CREATE POLICY "photos: 已授权摄影师可上传"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'photos'
  AND EXISTS (
    SELECT 1 FROM public.memberships m
    WHERE m.room_id::text = (storage.foldername(name))[1]
      AND m.user_id = auth.uid()
      AND m.role = 'photographer'
      AND m.approval_status = 'approved'
      AND m.left_at IS NULL
  )
);

-- 验收断言
DO $$
DECLARE
  v_photo_tbl  INTEGER;
  v_photo_stor INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_photo_tbl
    FROM pg_policies WHERE schemaname='public' AND tablename='photos';
  SELECT COUNT(*) INTO v_photo_stor
    FROM pg_policies
    WHERE schemaname='storage' AND tablename='objects'
      AND (qual LIKE '%photos%' OR with_check LIKE '%photos%');

  IF v_photo_tbl <> 4 THEN
    RAISE EXCEPTION 'a3_02_03b FAIL: expected 4 photos table policies, found %', v_photo_tbl;
  END IF;
  IF v_photo_stor <> 2 THEN
    RAISE EXCEPTION 'a3_02_03b FAIL: expected 2 photos storage policies, found %', v_photo_stor;
  END IF;
  RAISE NOTICE 'a3_02_03b PASS: photos table=%, storage=%', v_photo_tbl, v_photo_stor;
END; $$;
