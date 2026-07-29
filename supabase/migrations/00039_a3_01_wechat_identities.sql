
-- ══════════════════════════════════════════════════════════
-- A3-01：wechat_identities 私有映射表
-- 目的：将 openid 与 auth.users 的映射从 profiles 迁出至
--       服务端专用表；客户端角色（anon / authenticated）
--       完全禁止直接访问。
-- ══════════════════════════════════════════════════════════

-- 1. 创建映射表
CREATE TABLE IF NOT EXISTS public.wechat_identities (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  openid      TEXT        NOT NULL,
  appid       TEXT        NOT NULL DEFAULT '',   -- 支持多 AppID 扩展
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT wechat_identities_openid_appid_unique UNIQUE (openid, appid),
  CONSTRAINT wechat_identities_user_appid_unique   UNIQUE (user_id, appid)
);

-- 2. 启用 RLS，拒绝全部客户端直接访问（无任何 policy = 全部 DENY）
ALTER TABLE public.wechat_identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.wechat_identities FORCE ROW LEVEL SECURITY;

-- 3. 明确撤销客户端角色的 table-level grant（防止 GRANT ALL 传递）
REVOKE ALL ON public.wechat_identities FROM anon, authenticated;
-- service_role 与 postgres 保留完整权限（Supabase 默认已有，无需重复 GRANT）

-- 4. 迁移现有 profiles.wechat_openid 非空行（当前为 0 行，但保持幂等）
INSERT INTO public.wechat_identities (user_id, openid, appid, created_at, updated_at)
SELECT
  p.id,
  p.wechat_openid,
  'migrated',          -- appid 未知时用占位符；部署后可通过服务端更新
  COALESCE(p.created_at, now()),
  now()
FROM public.profiles p
WHERE p.wechat_openid IS NOT NULL
  AND p.wechat_openid <> ''
ON CONFLICT (openid, appid) DO NOTHING;

-- 5. 验收断言：wechat_identities 行数应与 profiles.wechat_openid 非空行数一致
DO $$
DECLARE
  v_identity_count  INTEGER;
  v_openid_count    INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_identity_count FROM public.wechat_identities;
  SELECT COUNT(*) INTO v_openid_count
    FROM public.profiles WHERE wechat_openid IS NOT NULL AND wechat_openid <> '';
  IF v_identity_count <> v_openid_count THEN
    RAISE EXCEPTION 'MIGRATION ASSERT FAIL: wechat_identities rows (%) != profiles.wechat_openid nonempty (%)',
      v_identity_count, v_openid_count;
  END IF;
  RAISE NOTICE 'a3_01 ASSERT PASS: wechat_identities=% rows migrated', v_identity_count;
END;
$$;
