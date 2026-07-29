
-- 为 profiles 表添加微信登录所需字段
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS wechat_openid  TEXT UNIQUE,
  ADD COLUMN IF NOT EXISTS wechat_pwd     TEXT;    -- 服务端存储，RLS 不暴露给客户端

-- 确保普通用户无法读写这两个敏感列（通过 RLS UPDATE check 已限制，此处额外收紧 column 权限）
REVOKE UPDATE (wechat_openid, wechat_pwd) ON public.profiles FROM authenticated;
