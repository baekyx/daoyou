
-- ══════════════════════════════════════════════════════════════════════
-- A2 Migration 06：修复 crypt() search_path
--
-- 根因：pgcrypto 的 crypt() 位于 extensions schema；
--   a2_02/a2_03/a2_04 中函数的 SET search_path = 'public' 不包含 extensions，
--   导致每次调用 crypt(p_password, v_hash) 都报 function not found。
--   这是所有以前版本的潜伏 bug——函数定义可以保存，
--   但执行到 crypt() 行时立即报 42883。
--
-- 修复：将 search_path 改为 'public, extensions'。
--   仅修改 search_path，不改函数逻辑。
-- ══════════════════════════════════════════════════════════════════════

-- 修复 join_room_with_password
ALTER FUNCTION public.join_room_with_password(UUID, TEXT)
  SET search_path = 'public, extensions';

-- 修复 verify_room_password_only
ALTER FUNCTION public.verify_room_password_only(UUID, TEXT)
  SET search_path = 'public, extensions';

-- 修复 create_room_secure（如含 crypt 相关调用则一并修复）
-- 此函数不直接调用 crypt，但为防御性一致，仅修改含 crypt 的两个函数

-- 确认修改生效
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'join_room_with_password'
      AND EXISTS (
        SELECT 1 FROM unnest(p.proconfig) AS c
        WHERE c LIKE '%extensions%'
      )
  ) THEN
    RAISE EXCEPTION 'FAIL: join_room_with_password search_path not updated';
  END IF;
  RAISE NOTICE 'search_path updated: join_room_with_password  ✅';

  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'verify_room_password_only'
      AND EXISTS (
        SELECT 1 FROM unnest(p.proconfig) AS c
        WHERE c LIKE '%extensions%'
      )
  ) THEN
    RAISE EXCEPTION 'FAIL: verify_room_password_only search_path not updated';
  END IF;
  RAISE NOTICE 'search_path updated: verify_room_password_only  ✅';
END;
$$;
