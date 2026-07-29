
-- 禁用两个测试账号：设置 banned_until 至远期，防止已有 session 继续使用
-- 不删除任何业务数据（profiles/rooms/room_members 等均保留）
UPDATE auth.users
SET banned_until = '2099-12-31 23:59:59+00',
    updated_at = NOW()
WHERE email IN (
  'test18888888888@gmail.com',
  'test17779923426@gmail.com'
);
