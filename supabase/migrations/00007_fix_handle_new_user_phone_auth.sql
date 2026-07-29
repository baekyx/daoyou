
-- 修复 handle_new_user：兼容手机号注册（email 为 null 的情况）
-- 手机号注册时 username 取 'u_' + 手机号后6位 + 随机4位，保证唯一且不暴露完整号码
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  derived_username TEXT;
BEGIN
  IF NEW.email IS NOT NULL THEN
    -- 邮箱/用户名注册：取 @ 前缀
    derived_username := split_part(NEW.email, '@', 1);
  ELSIF NEW.phone IS NOT NULL THEN
    -- 手机号注册：取后6位 + 随机4位十六进制，避免重复
    derived_username := 'u_' || right(NEW.phone, 6) || substr(md5(random()::text), 1, 4);
  ELSE
    -- 兜底：生成随机唯一用户名
    derived_username := 'user_' || substr(md5(NEW.id::text), 1, 8);
  END IF;

  INSERT INTO public.profiles (id, username, role, phone)
  VALUES (
    NEW.id,
    derived_username,
    COALESCE((NEW.raw_user_meta_data->>'role')::public.user_role, 'tourist'),
    NEW.phone
  );
  RETURN NEW;
END;
$$;
