
-- ══════════════════════════════════════════════════════════
-- A3-02：清空 profiles.wechat_pwd 明文凭据
--
-- 背景：
--   wechat-auth 函数曾将随机密码写入 profiles.wechat_pwd，
--   导致任何已登录用户通过 qual=true SELECT policy 可读他人密码。
--   当前基线：wechat_pwd_nonempty = 0（审计已确认），
--   但仍需幂等清空以阻止任何残留，并为新 wechat-auth 提供
--   "该列永远为空"的数据库层保障。
--
-- 注意：
--   - 不删除 wechat_pwd 列（旧线上兼容）
--   - 不删除 wechat_openid 列（旧线上兼容，由 wechat_identities 接管新写入）
-- ══════════════════════════════════════════════════════════

-- 1. 清空所有非空的 wechat_pwd（当前 0 行，幂等）
UPDATE public.profiles
SET wechat_pwd = NULL
WHERE wechat_pwd IS NOT NULL AND wechat_pwd <> '';

-- 2. 同时清空 wechat_openid（已迁移至 wechat_identities，旧列置空）
UPDATE public.profiles
SET wechat_openid = NULL
WHERE wechat_openid IS NOT NULL AND wechat_openid <> '';

-- 3. 验收断言
DO $$
DECLARE
  v_pwd_count    INTEGER;
  v_openid_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_pwd_count
    FROM public.profiles WHERE wechat_pwd IS NOT NULL AND wechat_pwd <> '';
  SELECT COUNT(*) INTO v_openid_count
    FROM public.profiles WHERE wechat_openid IS NOT NULL AND wechat_openid <> '';

  IF v_pwd_count > 0 THEN
    RAISE EXCEPTION 'a3_02 FAIL: profiles.wechat_pwd still has % nonempty rows', v_pwd_count;
  END IF;
  IF v_openid_count > 0 THEN
    RAISE EXCEPTION 'a3_02 FAIL: profiles.wechat_openid still has % nonempty rows', v_openid_count;
  END IF;

  RAISE NOTICE 'a3_02 PASS: wechat_pwd=0 nonempty, wechat_openid=0 nonempty';
END;
$$;
