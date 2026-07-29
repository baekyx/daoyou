
-- 撤销两个测试账号的全部 session 与 refresh token
-- 操作顺序：先标记 refresh_tokens.revoked，再删除 sessions
-- 不删除 auth.users、profiles、rooms 或任何业务数据
-- 幂等：WHERE 条件包含状态检查或直接覆盖

-- Step 1：将 refresh_tokens 标记为已撤销（revoked = true）
-- refresh_tokens.user_id 为 varchar，需显式 cast
UPDATE auth.refresh_tokens
SET revoked = true,
    updated_at = NOW()
WHERE user_id::uuid IN (
  SELECT id FROM auth.users
  WHERE email IN (
    'test18888888888@gmail.com',
    'test17779923426@gmail.com'
  )
)
AND revoked = false;

-- Step 2：删除 sessions 记录（GoTrue 以 session 记录是否存在判断 session 有效性）
DELETE FROM auth.sessions
WHERE user_id IN (
  SELECT id FROM auth.users
  WHERE email IN (
    'test18888888888@gmail.com',
    'test17779923426@gmail.com'
  )
);
