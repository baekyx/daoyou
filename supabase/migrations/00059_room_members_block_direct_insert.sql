
-- 禁止游客/任何角色直接 INSERT room_members，必须经由 RPC（join_room_with_password / resume_room_membership）
-- 导游管理自己房间的既有能力通过独立策略保持不变

-- 1. 先删除可能存在的旧游客 INSERT 策略（防重复）
DROP POLICY IF EXISTS "tourists_can_insert_own_membership" ON room_members;
DROP POLICY IF EXISTS "users_can_join_room" ON room_members;
DROP POLICY IF EXISTS "allow_tourist_insert_membership" ON room_members;

-- 2. 确认 RLS 已启用
ALTER TABLE room_members ENABLE ROW LEVEL SECURITY;

-- 3. 确保 RPC 函数以 SECURITY DEFINER 运行（绕过 RLS 写入）
--    join_room_with_password 和 resume_room_membership 已是 SECURITY DEFINER，此处仅做防御校验注释。
--    若需要重建，单独 migration 处理；本 migration 只管策略层。

-- 4. 游客只能 SELECT 自己的成员记录（已有策略保持；确保没有 INSERT 策略即可）
--    此处不新增 INSERT 策略，INSERT 只通过 SECURITY DEFINER RPC 完成。

-- 5. 验证：列出 room_members 上的所有策略（方便审计）
-- SELECT policyname, cmd, qual FROM pg_policies WHERE tablename = 'room_members';
