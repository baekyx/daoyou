
-- ══════════════════════════════════════════════════════════════════
-- A3-02-05: 修复 audio INSERT policy 中的 r.name bug
-- a3_02_02 原始 INSERT policy 的 foldername 参数误写为 r.name（rooms 表无 name 列）
-- 应为 objects.name（Storage objects 表中的文件路径列）
-- UPDATE/DELETE 已在 a3_02_04 修复，本次仅修复 INSERT。
-- ══════════════════════════════════════════════════════════════════

DROP POLICY IF EXISTS "audio: 导游可上传" ON storage.objects;

CREATE POLICY "audio: 导游可上传"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'audio'
  AND EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id::text = (storage.foldername(objects.name))[1]
      AND r.guide_id = auth.uid()
  )
);

-- 验收：audio policies 4 条，public 写 = 0，INSERT 引用 objects.name
DO $$
DECLARE
  v_total     INTEGER;
  v_pub_write INTEGER;
  v_fix_check TEXT;
BEGIN
  SELECT COUNT(*) INTO v_total
  FROM pg_policies
  WHERE schemaname='storage' AND tablename='objects'
    AND (qual LIKE '%audio%' OR with_check LIKE '%audio%');

  SELECT COUNT(*) INTO v_pub_write
  FROM pg_policies
  WHERE schemaname='storage' AND tablename='objects'
    AND cmd IN ('INSERT','UPDATE','DELETE') AND roles='{public}'
    AND (qual LIKE '%audio%' OR with_check LIKE '%audio%');

  -- 确认 INSERT policy 已用 objects.name
  SELECT with_check INTO v_fix_check
  FROM pg_policies
  WHERE schemaname='storage' AND tablename='objects'
    AND policyname='audio: 导游可上传';

  IF v_total <> 4 THEN
    RAISE EXCEPTION 'a3_02_05 FAIL: expected 4 audio policies, found %', v_total;
  END IF;
  IF v_pub_write <> 0 THEN
    RAISE EXCEPTION 'a3_02_05 FAIL: audio still has % public write policies', v_pub_write;
  END IF;
  IF v_fix_check NOT LIKE '%objects.name%' THEN
    RAISE EXCEPTION 'a3_02_05 FAIL: INSERT policy still references r.name: %', v_fix_check;
  END IF;
  RAISE NOTICE 'a3_02_05 PASS: audio INSERT policy uses objects.name, total=%, pub_write=%',
    v_total, v_pub_write;
END; $$;
