
-- 用 SECURITY DEFINER 函数允许用户更新自己的角色（绕过 RLS 中禁改 role 的限制）
CREATE OR REPLACE FUNCTION public.set_my_role(new_role public.user_role)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.profiles
  SET role = new_role, updated_at = now()
  WHERE id = auth.uid();
END;
$$;

-- 仅允许已登录用户调用
REVOKE ALL ON FUNCTION public.set_my_role(public.user_role) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.set_my_role(public.user_role) TO authenticated;
