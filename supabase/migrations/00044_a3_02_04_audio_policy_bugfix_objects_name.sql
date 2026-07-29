
-- ══════════════════════════════════════════════════════════════════
-- A3-02-04: 修复 audio UPDATE/DELETE policy 中的列引用 bug
--
-- 问题：a3_02_02 中 UPDATE/DELETE 的 qual 使用了 r.name（rooms 表无 name 列）
--       实际应为 objects.name（Storage objects 表中的文件路径列）
-- 影响：UPDATE/DELETE policy 的 EXISTS 子查询永远返回 false（导游无法上传/更新/删除）
-- 修复：将 r.name 改为 objects.name（INSERT policy 已正确写法，仅 UPDATE/DELETE 需修复）
-- ══════════════════════════════════════════════════════════════════

-- 1. 删除有 bug 的 UPDATE/DELETE policies
DROP POLICY IF EXISTS "audio: 导游可更新" ON storage.objects;
DROP POLICY IF EXISTS "audio: 导游可删除" ON storage.objects;

-- 2. 重建 UPDATE：使用 objects.name
CREATE POLICY "audio: 导游可更新"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'audio'
  AND EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id::text = (storage.foldername(objects.name))[1]
      AND r.guide_id = auth.uid()
  )
)
WITH CHECK (
  bucket_id = 'audio'
  AND EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id::text = (storage.foldername(objects.name))[1]
      AND r.guide_id = auth.uid()
  )
);

-- 3. 重建 DELETE：使用 objects.name
CREATE POLICY "audio: 导游可删除"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'audio'
  AND EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id::text = (storage.foldername(objects.name))[1]
      AND r.guide_id = auth.uid()
  )
);

-- 4. 验收断言：audio policies 仍为 4 条，且无 public 写权限
DO $$
DECLARE
  v_total   INTEGER;
  v_pub_write INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_total
  FROM pg_policies
  WHERE schemaname='storage' AND tablename='objects'
    AND (qual LIKE '%audio%' OR with_check LIKE '%audio%');

  SELECT COUNT(*) INTO v_pub_write
  FROM pg_policies
  WHERE schemaname='storage' AND tablename='objects'
    AND cmd IN ('INSERT','UPDATE','DELETE')
    AND roles = '{public}'
    AND (qual LIKE '%audio%' OR with_check LIKE '%audio%');

  IF v_total <> 4 THEN
    RAISE EXCEPTION 'a3_02_04 FAIL: expected 4 audio policies, found %', v_total;
  END IF;
  IF v_pub_write <> 0 THEN
    RAISE EXCEPTION 'a3_02_04 FAIL: audio still has % public write policies', v_pub_write;
  END IF;
  RAISE NOTICE 'a3_02_04 PASS: audio policies=%, public_write=%', v_total, v_pub_write;
END; $$;
