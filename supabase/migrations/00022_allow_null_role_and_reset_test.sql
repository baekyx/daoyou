-- 1. 允许 role 为 NULL（新用户未选择身份时）
ALTER TABLE public.profiles ALTER COLUMN role DROP NOT NULL;

-- 2. 清除测试账号 role，让其重走身份选择流程
UPDATE public.profiles
SET role = NULL
WHERE id IN (
  SELECT id FROM auth.users
  WHERE email IN ('test17779923426@gmail.com', 'test18888888888@gmail.com')
);