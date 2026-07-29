-- 插入测试账号（phone-only provider，无 email）
-- ON CONFLICT 幂等：已有则跳过，不覆盖已有 role/nickname
DO $$
DECLARE
  v_uid uuid;
BEGIN
  -- 检查是否已存在
  SELECT id INTO v_uid FROM auth.users WHERE phone = '+8618888888888' LIMIT 1;

  IF v_uid IS NULL THEN
    -- 创建新账号
    v_uid := gen_random_uuid();
    INSERT INTO auth.users (
      id, instance_id, aud, role, phone, phone_confirmed_at,
      email, email_confirmed_at,
      encrypted_password, created_at, updated_at,
      confirmation_token, recovery_token, email_change_token_new,
      raw_app_meta_data, raw_user_meta_data, is_super_admin
    ) VALUES (
      v_uid,
      '00000000-0000-0000-0000-000000000000',
      'authenticated', 'authenticated',
      '+8618888888888',
      now(),
      concat('dev_test_18888888888_', substring(v_uid::text, 1, 8), '@shiguang.dev'),
      now(),
      crypt('dev_bypass_18888888888', gen_salt('bf')),
      now(), now(), '', '', '',
      '{"provider":"phone","providers":["phone"]}',
      '{}', false
    );
  END IF;

  -- 同步 profiles（幂等：已有则只补全空字段，不覆盖 role/nickname）
  INSERT INTO public.profiles (id, username, phone, role, created_at)
  VALUES (v_uid, 'dev_test_18888888888', '18888888888', 'photographer', now())
  ON CONFLICT (id) DO UPDATE
    SET phone    = CASE WHEN profiles.phone IS NULL OR profiles.phone = ''
                        THEN EXCLUDED.phone ELSE profiles.phone END,
        username = CASE WHEN profiles.username IS NULL OR profiles.username = ''
                        THEN EXCLUDED.username ELSE profiles.username END;
END $$;