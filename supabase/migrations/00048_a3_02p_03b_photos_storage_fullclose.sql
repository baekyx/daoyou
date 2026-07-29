
-- A3-02-P03b: photos Storage INSERT/UPDATE/DELETE 完整闭环（重试）
-- 路径：{room_id}/{photographer_id}/{filename}
-- 条件：authenticated + 第一段=approved photographer room_id + 第二段=uid()

DROP POLICY IF EXISTS "photos: 已授权摄影师可上传" ON storage.objects;
DROP POLICY IF EXISTS "photos: 已授权摄影师可更新" ON storage.objects;
DROP POLICY IF EXISTS "photos: 已授权摄影师可删除" ON storage.objects;

-- INSERT
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

-- UPDATE
CREATE POLICY "photos: 已授权摄影师可更新"
ON storage.objects FOR UPDATE TO authenticated
USING (
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

-- DELETE
CREATE POLICY "photos: 已授权摄影师可删除"
ON storage.objects FOR DELETE TO authenticated
USING (
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

-- 验收断言：photos storage = 4 条，public SELECT 保留
DO $$
DECLARE v_cnt INTEGER; v_sel INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_cnt FROM pg_policies
  WHERE schemaname='storage' AND tablename='objects'
    AND (qual LIKE '%photos%' OR with_check LIKE '%photos%');
  SELECT COUNT(*) INTO v_sel FROM pg_policies
  WHERE schemaname='storage' AND tablename='objects'
    AND cmd='SELECT' AND roles='{public}' AND qual LIKE '%photos%';
  IF v_cnt <> 4 THEN
    RAISE EXCEPTION 'a3_02p_03b FAIL: expected 4, found %', v_cnt;
  END IF;
  IF v_sel <> 1 THEN
    RAISE EXCEPTION 'a3_02p_03b FAIL: public SELECT not preserved';
  END IF;
  RAISE NOTICE 'a3_02p_03b PASS: photos storage policies=%, public SELECT ok', v_cnt;
END; $$;
