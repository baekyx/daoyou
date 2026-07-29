
-- ══════════════════════════════════════════════════════════════════════
-- A2 Migration 05：真实 RPC 调用验收断言
-- 房间: 985c2636-51e7-43df-8748-7e8a2e65de61 (status=pending, 有 room_secrets)
-- 用户: d838fcc3-a6d8-4a55-a6a4-c1702dd843f6 (无该房间 room_members，无 rate_limit)
-- migration 本身是事务；断言失败 → 整条回滚，不留脏数据
-- ══════════════════════════════════════════════════════════════════════
DO $$
DECLARE
  v_room_id        CONSTANT UUID := '985c2636-51e7-43df-8748-7e8a2e65de61';
  v_test_uid       CONSTANT UUID := 'd838fcc3-a6d8-4a55-a6a4-c1702dd843f6';
  v_correct_pwd    TEXT;
  v_wrong_pwd      CONSTANT TEXT := 'XXXXXX';
  v_result         JSONB;
  v_members_before INT;
  v_members_after  INT;
  v_rate_count     INT;
BEGIN

  -- ── 前置检查 ──
  SELECT COUNT(*) INTO v_rate_count
  FROM public.room_join_rate_limits
  WHERE user_id = v_test_uid AND room_id = v_room_id;
  IF v_rate_count > 0 THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: test user already has rate_limit records (count=%)', v_rate_count;
  END IF;

  IF EXISTS(SELECT 1 FROM public.room_members
            WHERE user_id = v_test_uid AND room_id = v_room_id) THEN
    RAISE EXCEPTION 'PRECONDITION FAILED: test user already has room_members record';
  END IF;

  -- ── 模拟已登录用户（auth.uid() = v_test_uid）──
  PERFORM set_config('request.jwt.claim.sub', v_test_uid::text, true);
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', v_test_uid::text, 'role', 'authenticated')::text, true);

  -- ════════════════════════════════════════════════════
  -- 测试组 1：5次错误密码 + 第6次仍限流
  -- ════════════════════════════════════════════════════

  SELECT public.join_room_with_password(v_room_id, v_wrong_pwd) INTO v_result;
  IF v_result->>'code' <> 'wrong_password' OR (v_result->>'attempts_remaining')::int <> 4 THEN
    RAISE EXCEPTION 'FAIL attempt-1: got %', v_result;
  END IF;
  RAISE NOTICE '[1] code=wrong_password  remaining=4  ✅';

  SELECT public.join_room_with_password(v_room_id, v_wrong_pwd) INTO v_result;
  IF v_result->>'code' <> 'wrong_password' OR (v_result->>'attempts_remaining')::int <> 3 THEN
    RAISE EXCEPTION 'FAIL attempt-2: got %', v_result;
  END IF;
  RAISE NOTICE '[2] code=wrong_password  remaining=3  ✅';

  SELECT public.join_room_with_password(v_room_id, v_wrong_pwd) INTO v_result;
  IF v_result->>'code' <> 'wrong_password' OR (v_result->>'attempts_remaining')::int <> 2 THEN
    RAISE EXCEPTION 'FAIL attempt-3: got %', v_result;
  END IF;
  RAISE NOTICE '[3] code=wrong_password  remaining=2  ✅';

  SELECT public.join_room_with_password(v_room_id, v_wrong_pwd) INTO v_result;
  IF v_result->>'code' <> 'wrong_password' OR (v_result->>'attempts_remaining')::int <> 1 THEN
    RAISE EXCEPTION 'FAIL attempt-4: got %', v_result;
  END IF;
  RAISE NOTICE '[4] code=wrong_password  remaining=1  ✅';

  SELECT public.join_room_with_password(v_room_id, v_wrong_pwd) INTO v_result;
  IF v_result->>'code' <> 'rate_limited' OR (v_result->>'attempts_remaining')::int <> 0 THEN
    RAISE EXCEPTION 'FAIL attempt-5: expected rate_limited/remaining=0, got %', v_result;
  END IF;
  RAISE NOTICE '[5] code=rate_limited  remaining=0  ✅ (locked)';

  SELECT public.join_room_with_password(v_room_id, v_wrong_pwd) INTO v_result;
  IF v_result->>'code' <> 'rate_limited' THEN
    RAISE EXCEPTION 'FAIL attempt-6: expected rate_limited, got %', v_result;
  END IF;
  RAISE NOTICE '[6] code=rate_limited  ✅ (still locked)';

  -- 清理限流行，准备正确密码测试
  DELETE FROM public.room_join_rate_limits
  WHERE user_id = v_test_uid AND room_id = v_room_id;
  RAISE NOTICE '[cleanup-1] rate_limit rows deleted  ✅';

  -- ════════════════════════════════════════════════════
  -- 测试组 2：正确密码 → joined，幂等
  -- ════════════════════════════════════════════════════

  SELECT password INTO v_correct_pwd FROM public.rooms WHERE id = v_room_id;

  v_members_before := (SELECT COUNT(*) FROM public.room_members WHERE room_id = v_room_id);

  SELECT public.join_room_with_password(v_room_id, v_correct_pwd) INTO v_result;
  IF v_result->>'code' <> 'joined' OR NOT (v_result->>'ok')::boolean THEN
    RAISE EXCEPTION 'FAIL join-correct-1: expected joined, got %', v_result;
  END IF;
  RAISE NOTICE '[join-1] code=joined  ✅';

  v_members_after := (SELECT COUNT(*) FROM public.room_members WHERE room_id = v_room_id);
  IF v_members_after <> v_members_before + 1 THEN
    RAISE EXCEPTION 'FAIL member-count: before=%, after=% (expected +1)', v_members_before, v_members_after;
  END IF;
  RAISE NOTICE '[join-1] room_members %→%  (+1 tourist)  ✅', v_members_before, v_members_after;

  IF NOT EXISTS(SELECT 1 FROM public.room_members
                WHERE room_id = v_room_id AND user_id = v_test_uid AND role = 'tourist') THEN
    RAISE EXCEPTION 'FAIL join-role: member not found with role=tourist';
  END IF;
  RAISE NOTICE '[join-1] role=tourist  ✅';

  -- 幂等：第2次正确调用（已有成员 → resumed）
  SELECT public.join_room_with_password(v_room_id, v_correct_pwd) INTO v_result;
  IF v_result->>'code' NOT IN ('joined', 'resumed') THEN
    RAISE EXCEPTION 'FAIL join-idempotent: expected joined/resumed, got %', v_result;
  END IF;
  v_members_after := (SELECT COUNT(*) FROM public.room_members WHERE room_id = v_room_id);
  IF v_members_after <> v_members_before + 1 THEN
    RAISE EXCEPTION 'FAIL join-idempotent-count: expected %, got %', v_members_before+1, v_members_after;
  END IF;
  RAISE NOTICE '[join-2] code=%  count unchanged (%)  ✅', v_result->>'code', v_members_after;

  -- 清理 test tourist member
  DELETE FROM public.room_members WHERE user_id = v_test_uid AND room_id = v_room_id;
  IF EXISTS(SELECT 1 FROM public.room_members WHERE user_id = v_test_uid AND room_id = v_room_id) THEN
    RAISE EXCEPTION 'CLEANUP FAIL: test member not deleted';
  END IF;
  RAISE NOTICE '[cleanup-2] test room_member deleted  ✅';

  -- ════════════════════════════════════════════════════
  -- 测试组 3：verify_room_password_only 正确密码 → verified，不写成员
  -- ════════════════════════════════════════════════════

  v_members_before := (SELECT COUNT(*) FROM public.room_members WHERE room_id = v_room_id);

  SELECT public.verify_room_password_only(v_room_id, v_correct_pwd) INTO v_result;
  IF v_result->>'code' <> 'verified' OR NOT (v_result->>'ok')::boolean THEN
    RAISE EXCEPTION 'FAIL verify-correct: expected verified, got %', v_result;
  END IF;
  RAISE NOTICE '[verify] code=verified  ✅';

  v_members_after := (SELECT COUNT(*) FROM public.room_members WHERE room_id = v_room_id);
  IF v_members_before <> v_members_after THEN
    RAISE EXCEPTION 'FAIL verify-no-member: room_members changed before=% after=%', v_members_before, v_members_after;
  END IF;
  RAISE NOTICE '[verify] room_members count unchanged (%)  ✅', v_members_before;

  IF EXISTS(SELECT 1 FROM public.memberships WHERE user_id = v_test_uid AND room_id = v_room_id) THEN
    RAISE EXCEPTION 'FAIL verify-no-membership: memberships row created unexpectedly';
  END IF;
  RAISE NOTICE '[verify] memberships unchanged  ✅';

  SELECT COUNT(*) INTO v_rate_count
  FROM public.room_join_rate_limits WHERE user_id = v_test_uid AND room_id = v_room_id;
  IF v_rate_count <> 0 THEN
    RAISE EXCEPTION 'FAIL verify-rate-cleanup: % rate_limit rows remain after correct verify', v_rate_count;
  END IF;
  RAISE NOTICE '[verify] rate_limit cleared after correct verify  ✅';

  -- ════════════════════════════════════════════════════
  -- 最终清理确认：无遗留测试数据
  -- ════════════════════════════════════════════════════
  IF EXISTS(SELECT 1 FROM public.room_members WHERE user_id = v_test_uid AND room_id = v_room_id)
  OR EXISTS(SELECT 1 FROM public.room_join_rate_limits WHERE user_id = v_test_uid AND room_id = v_room_id)
  THEN
    RAISE EXCEPTION 'FINAL CLEANUP FAIL: test data remains in DB';
  END IF;

  RAISE NOTICE '════ ALL ASSERTIONS PASSED — no test data remains ════';
END;
$$;
