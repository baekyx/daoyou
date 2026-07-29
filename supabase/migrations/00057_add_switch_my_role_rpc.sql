-- ================================================================
-- switch_my_role(p_role text)
-- 已登录用户在三个合法身份之间自由切换，与首次注册的 set_my_role 完全分离。
-- 安全保证：
--   1. SECURITY DEFINER，固定 search_path=public
--   2. 仅允许 authenticated 调用，revoke public/anon
--   3. 不接受任意 user_id 参数，内部用 auth.uid() 定位唯一行
--   4. 白名单校验：只接受 tourist/guide/photographer
--   5. profile 不存在时拒绝（防悬空切换）
--   6. 只 UPDATE role 与 updated_at，不 INSERT/DELETE
--   7. 返回更新后的 role 供前端校验
-- ================================================================
CREATE OR REPLACE FUNCTION public.switch_my_role(p_role text)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_uid  uuid := auth.uid();
  v_role public.user_role;
BEGIN
  -- 1. 拒绝匿名调用
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'switch_my_role: 未登录，拒绝切换';
  END IF;

  -- 2. 白名单校验（强转失败会自动抛 invalid_text_representation 异常）
  IF p_role NOT IN ('tourist', 'guide', 'photographer') THEN
    RAISE EXCEPTION 'switch_my_role: 非法身份值 %', p_role;
  END IF;
  v_role := p_role::public.user_role;

  -- 3. profile 必须存在
  IF NOT EXISTS (SELECT 1 FROM public.profiles WHERE id = v_uid) THEN
    RAISE EXCEPTION 'switch_my_role: profile 不存在，请先完成注册';
  END IF;

  -- 4. 仅更新当前用户的 role
  UPDATE public.profiles
  SET role = v_role, updated_at = now()
  WHERE id = v_uid;

  RETURN v_role::text;
END;
$$;

-- 权限收口：撤销所有人，仅授予 authenticated
REVOKE ALL ON FUNCTION public.switch_my_role(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.switch_my_role(text) FROM anon;
GRANT EXECUTE ON FUNCTION public.switch_my_role(text) TO authenticated;

-- 验收断言
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema = 'public' AND routine_name = 'switch_my_role'
      AND privilege_type = 'EXECUTE' AND grantee = 'anon'
  ) THEN RAISE EXCEPTION 'FAIL: switch_my_role still grants anon EXECUTE'; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.routines
    WHERE routine_schema = 'public' AND routine_name = 'switch_my_role'
  ) THEN RAISE EXCEPTION 'FAIL: switch_my_role function not found'; END IF;

  RAISE NOTICE 'switch_my_role PASS: function created, anon revoked';
END;
$$;