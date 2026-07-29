
-- 插入示例景区卡片（seed数据，不涉及用户）
-- 由系统账号创建，先插入一个系统profiles
-- 注：实际导游登录后可自行创建，此处仅展示初始数据逻辑
-- 景区卡片seed（created_by会在Edge Function中设置真实用户，这里先留空注释以便后续测试时手动插入）
SELECT 1; -- placeholder, seed will be inserted after first guide registers
