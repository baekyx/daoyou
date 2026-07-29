
-- 插入 auth.users 测试账号
INSERT INTO auth.users (
  id, instance_id, aud, role, phone, phone_confirmed_at,
  encrypted_password, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new,
  raw_app_meta_data, raw_user_meta_data, is_super_admin
)
VALUES (
  gen_random_uuid(),
  '00000000-0000-0000-0000-000000000000',
  'authenticated', 'authenticated',
  '+8618888888888',
  now(),
  crypt('dev_bypass_18888888888', gen_salt('bf')),
  now(), now(), '', '', '',
  '{"provider":"phone","providers":["phone"]}',
  '{}', false
)
ON CONFLICT (phone) DO NOTHING;

-- 同步 profiles（username 填占位符，role 默认 tourist，用户登录后可选角色）
INSERT INTO public.profiles (id, username, phone, role, created_at)
SELECT u.id, '测试账号_18888888888', '18888888888', NULL, now()
FROM auth.users u
WHERE u.phone = '+8618888888888'
ON CONFLICT (id) DO UPDATE
  SET phone = EXCLUDED.phone,
      username = CASE WHEN profiles.username IS NULL OR profiles.username = ''
                      THEN EXCLUDED.username ELSE profiles.username END;
