
-- ══════════════════════════════════════════════════════════════════
-- A3-02-P01: 撤销 mark_question_answered RPC 的所有 EXECUTE 权限并删除函数
-- 产品已确认：问题由导游口头回应，不需要任何"标记已回答"步骤
-- 保留 questions.is_answered 列作为空壳，不迁移历史数据
-- ══════════════════════════════════════════════════════════════════

-- 1. 撤销所有角色的 EXECUTE 权限（幂等，角色不存在时 REVOKE 静默通过）
REVOKE EXECUTE ON FUNCTION public.mark_question_answered(uuid) FROM anon;
REVOKE EXECUTE ON FUNCTION public.mark_question_answered(uuid) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_question_answered(uuid) FROM service_role;

-- 2. 删除函数
DROP FUNCTION IF EXISTS public.mark_question_answered(uuid);

-- 3. 验收断言：函数不再存在
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc
    WHERE proname = 'mark_question_answered'
      AND pronamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  ) THEN
    RAISE EXCEPTION 'a3_02p_01 FAIL: mark_question_answered still exists';
  END IF;
  RAISE NOTICE 'a3_02p_01 PASS: mark_question_answered deleted';
END; $$;
