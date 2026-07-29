
-- ══════════════════════════════════════════════════════════════════
-- A3-02-02: audio Storage 写权限收口
--
-- 路径结构已确认：{room_id}/{filename}（2层，首段为 room_id UUID）
-- rooms 表有 guide_id 字段，可在 Storage policy 中 JOIN 验证。
-- 采用"导游 + 路径首段 room_id 校验"（非临时 authenticated-only）。
--
-- 保留：audio_select_all (public SELECT) —— 不改
-- 撤销：audio_insert_all / audio_update_all / audio_delete_all (public)
-- 新增：仅该房间导游可 INSERT/UPDATE/DELETE，且路径首段 = 自己房间 id
-- ══════════════════════════════════════════════════════════════════

-- 1. 移除旧的 public INSERT/UPDATE/DELETE policies
DROP POLICY IF EXISTS "audio_insert_all" ON storage.objects;
DROP POLICY IF EXISTS "audio_update_all" ON storage.objects;
DROP POLICY IF EXISTS "audio_delete_all" ON storage.objects;

-- 防御性：也尝试清理可能存在的其他命名
DROP POLICY IF EXISTS "audio: 导游可上传"   ON storage.objects;
DROP POLICY IF EXISTS "audio: 导游可更新"   ON storage.objects;
DROP POLICY IF EXISTS "audio: 导游可删除"   ON storage.objects;

-- 2. INSERT：已登录 + 路径首段是自己作为 guide_id 的房间
--    路径格式：{room_id}/{filename}
--    (storage.foldername(name))[1] 取 name 按 '/' 分割的第 1 段 = room_id
CREATE POLICY "audio: 导游可上传"
ON storage.objects
FOR INSERT
TO authenticated
WITH CHECK (
  bucket_id = 'audio'
  AND EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id::text = (storage.foldername(name))[1]
      AND r.guide_id = auth.uid()
  )
);

-- 3. UPDATE：已登录 + 路径首段是自己房间
CREATE POLICY "audio: 导游可更新"
ON storage.objects
FOR UPDATE
TO authenticated
USING (
  bucket_id = 'audio'
  AND EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id::text = (storage.foldername(name))[1]
      AND r.guide_id = auth.uid()
  )
)
WITH CHECK (
  bucket_id = 'audio'
  AND EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id::text = (storage.foldername(name))[1]
      AND r.guide_id = auth.uid()
  )
);

-- 4. DELETE：已登录 + 路径首段是自己房间
CREATE POLICY "audio: 导游可删除"
ON storage.objects
FOR DELETE
TO authenticated
USING (
  bucket_id = 'audio'
  AND EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id::text = (storage.foldername(name))[1]
      AND r.guide_id = auth.uid()
  )
);

-- 5. SELECT 不变（audio_select_all public 保留）

-- 6. 验收断言：audio bucket 现有 policies 应精确为 4 条（SELECT + INSERT + UPDATE + DELETE）
DO $$
DECLARE v_cnt INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_cnt
  FROM pg_policies
  WHERE schemaname='storage' AND tablename='objects'
    AND (qual LIKE '%audio%' OR with_check LIKE '%audio%');
  IF v_cnt <> 4 THEN
    RAISE EXCEPTION 'a3_02_02 FAIL: expected 4 audio storage policies, found %', v_cnt;
  END IF;
  RAISE NOTICE 'a3_02_02 PASS: audio storage has % policies', v_cnt;
END; $$;
