
-- ══════════════════════════════════════════════════════════════════
-- A3-02-P02: memberships policy 收口
--
-- 审计结果：
--   INSERT  roles={public}, with_check=(uid()=user_id)
--   SELECT  roles={public}, qual=true
--   UPDATE  roles={public}, qual=true  ← 阻断项：任意人可篡改 approval_status
--   无 DELETE policy
--
-- 前端调用分析：
--   PhotographerScreens: INSERT(upsert) user_id=self, role=photographer, status=pending
--   PhotographerScreens: DELETE(撤回申请) user_id=self
--   PhotographerScreens: SELECT user_id=self (查看自己的状态)
--   PhotographerWait: SELECT user_id=self (轮询审批状态)
--   TouristExtra:    SELECT user_id=self (历史记录)
--   Guide端:         UPDATE(审批) — 目前依赖宽泛 public UPDATE（漏洞所在）
--
-- 目标 policy：
--   SELECT: 本人（摄影师查自己的） + 该房导游（审批用）
--   INSERT: 已登录 + user_id=uid() + role='photographer' + status='pending'（申请入口）
--   UPDATE: 仅该房间导游可以更新 approval_status/rejection_reason
--   DELETE: 仅本人（撤回申请，仅 pending 状态）
-- ══════════════════════════════════════════════════════════════════

-- 1. 删除旧 policies
DROP POLICY IF EXISTS "members_select" ON public.memberships;
DROP POLICY IF EXISTS "members_insert" ON public.memberships;
DROP POLICY IF EXISTS "members_update" ON public.memberships;
DROP POLICY IF EXISTS "members_delete" ON public.memberships;

-- 防御性清理历史命名
DROP POLICY IF EXISTS "memberships_select" ON public.memberships;
DROP POLICY IF EXISTS "memberships_insert" ON public.memberships;
DROP POLICY IF EXISTS "memberships_update" ON public.memberships;
DROP POLICY IF EXISTS "memberships_delete" ON public.memberships;

-- 2. SELECT：本人 OR 该房间导游
CREATE POLICY "memberships: 本人或导游可查看"
ON public.memberships FOR SELECT TO authenticated
USING (
  user_id = auth.uid()
  OR EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id = memberships.room_id
      AND r.guide_id = auth.uid()
  )
);

-- 3. INSERT：已登录 + user_id=uid() + role='photographer' + approval_status='pending'
--    （摄影师只能以 pending 状态申请，不能自行写入 approved）
CREATE POLICY "memberships: 摄影师可申请加入"
ON public.memberships FOR INSERT TO authenticated
WITH CHECK (
  user_id = auth.uid()
  AND role = 'photographer'
  AND approval_status = 'pending'
);

-- 4. UPDATE：仅该房间导游可更新（审批 approval_status / rejection_reason）
CREATE POLICY "memberships: 仅导游可审批"
ON public.memberships FOR UPDATE TO authenticated
USING (
  EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id = memberships.room_id
      AND r.guide_id = auth.uid()
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id = memberships.room_id
      AND r.guide_id = auth.uid()
  )
);

-- 5. DELETE：仅本人且状态为 pending（撤回申请）
CREATE POLICY "memberships: 本人可撤回申请"
ON public.memberships FOR DELETE TO authenticated
USING (
  user_id = auth.uid()
  AND approval_status = 'pending'
);

-- 6. 验收断言
DO $$
DECLARE
  v_cnt         INTEGER;
  v_pub_update  INTEGER;
  v_pub_insert  INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_cnt
  FROM pg_policies WHERE schemaname='public' AND tablename='memberships';

  SELECT COUNT(*) INTO v_pub_update
  FROM pg_policies
  WHERE schemaname='public' AND tablename='memberships'
    AND cmd='UPDATE' AND roles = '{public}';

  SELECT COUNT(*) INTO v_pub_insert
  FROM pg_policies
  WHERE schemaname='public' AND tablename='memberships'
    AND cmd='INSERT' AND roles = '{public}';

  IF v_cnt <> 4 THEN
    RAISE EXCEPTION 'a3_02p_02 FAIL: expected 4 memberships policies, found %', v_cnt;
  END IF;
  IF v_pub_update <> 0 THEN
    RAISE EXCEPTION 'a3_02p_02 FAIL: public UPDATE still exists on memberships';
  END IF;
  IF v_pub_insert <> 0 THEN
    RAISE EXCEPTION 'a3_02p_02 FAIL: public INSERT still exists on memberships';
  END IF;
  RAISE NOTICE 'a3_02p_02 PASS: memberships has % policies, no public UPDATE/INSERT', v_cnt;
END; $$;
