
-- A3-03-02b: 内部函数 anon/PUBLIC EXECUTE 权限收口（重试）

-- 1. _sync_room_password_hash：trigger 函数，不应被 anon 直接调用
REVOKE EXECUTE ON FUNCTION public._sync_room_password_hash() FROM anon;

-- 2. get_user_role(uid uuid)：收口为仅 authenticated
REVOKE EXECUTE ON FUNCTION public.get_user_role(uuid) FROM anon, PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_user_role(uuid) TO authenticated, service_role;

-- 3. restore_current_room_for_user：anon 不需要恢复登录房间
REVOKE EXECUTE ON FUNCTION public.restore_current_room_for_user(uuid) FROM anon;

-- 4. set_card_push_sequence：导游专用，PUBLIC 多余
REVOKE EXECUTE ON FUNCTION public.set_card_push_sequence() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.set_card_push_sequence() TO authenticated, service_role;

-- 5. generate_room_number：只被 create_room_secure 内部调用
REVOKE EXECUTE ON FUNCTION public.generate_room_number() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.generate_room_number() TO authenticated, service_role;

-- 保留：handle_new_user PUBLIC（auth trigger），
--       get_kc_by_push / get_latest_pushed_kc_for_room / get_pushed_kc_for_room anon（KC推送），
--       increment_online_count PUBLIC（统计，非SECURITY DEFINER）
-- 记录到 A3-4 再评估

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema='public' AND routine_name='_sync_room_password_hash'
      AND privilege_type='EXECUTE' AND grantee='anon'
  ) THEN RAISE EXCEPTION 'FAIL: _sync_room_password_hash still grants anon'; END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.routine_privileges
    WHERE routine_schema='public' AND routine_name='get_user_role'
      AND privilege_type='EXECUTE' AND grantee IN ('anon','PUBLIC')
  ) THEN RAISE EXCEPTION 'FAIL: get_user_role still grants anon/PUBLIC'; END IF;

  RAISE NOTICE 'a3_03_02b PASS: internal function anon/PUBLIC EXECUTE revoked';
END;
$$;
