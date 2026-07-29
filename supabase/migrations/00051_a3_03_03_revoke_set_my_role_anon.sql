
-- A3-03-03: set_my_role 收口 anon EXECUTE
-- set_my_role 调用者须为已登录用户（auth.uid() 确定角色），注册流程已在 authenticated 后执行
REVOKE EXECUTE ON FUNCTION public.set_my_role(user_role) FROM anon;

-- 验收
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema='public' AND routine_name='set_my_role'
      AND privilege_type='EXECUTE' AND grantee='anon'
  ) THEN RAISE EXCEPTION 'FAIL: set_my_role still grants anon'; END IF;
  RAISE NOTICE 'a3_03_03 PASS: set_my_role anon EXECUTE revoked';
END;
$$;
