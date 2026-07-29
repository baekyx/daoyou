-- 修复：新用户 profile 不预设 role，让前端引导用户选择身份
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
    derived_username := split_part(NEW.email, '@', 1);
  ELSIF NEW.phone IS NOT NULL THEN
    derived_username := 'u_' || right(NEW.phone, 6) || substr(md5(random()::text), 1, 4);
  ELSE
    derived_username := 'user_' || substr(md5(NEW.id::text), 1, 8);
  END IF;

  INSERT INTO public.profiles (id, username, role, phone)
  VALUES (
    NEW.id,
    derived_username,
    NULL,   -- 不预设角色，由前端引导用户在角色选择页完成
    NEW.phone
  );
  RETURN NEW;
END;
$$;