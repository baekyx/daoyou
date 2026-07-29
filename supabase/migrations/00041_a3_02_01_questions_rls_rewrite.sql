
-- ══════════════════════════════════════════════════════════════════
-- A3-02-01: questions RLS 重写
-- 目标：
--   SELECT  — 同房间有效成员（room_members.left_at IS NULL）+ 导游
--   INSERT  — 有效房间成员（room_members）+ 房间状态 pending/live
--             + user_id = auth.uid()
--   UPDATE  — 无 policy（全部 DENY）—— 禁止客户端修改任何问题
--   DELETE  — 无 policy（全部 DENY）—— 禁止客户端删除任何问题
--
-- 不删除历史问题，仅修改 policy；幂等。
-- ══════════════════════════════════════════════════════════════════

-- 1. 删除旧 policies
DROP POLICY IF EXISTS "questions: 提问者和导游可查看"  ON public.questions;
DROP POLICY IF EXISTS "questions: 任何已登录可提问"    ON public.questions;

-- （防御性：若历史存在以下命名也一并清除）
DROP POLICY IF EXISTS "questions_select" ON public.questions;
DROP POLICY IF EXISTS "questions_insert" ON public.questions;
DROP POLICY IF EXISTS "questions_update" ON public.questions;
DROP POLICY IF EXISTS "questions_delete" ON public.questions;

-- 2. SELECT：同房间有效成员 OR 该房间导游
--    有效成员：room_members WHERE room_id=questions.room_id AND user_id=uid() AND left_at IS NULL
--    导游：rooms WHERE id=questions.room_id AND guide_id=uid()
CREATE POLICY "questions: 成员和导游可查看"
ON public.questions
FOR SELECT
TO authenticated
USING (
  (
    EXISTS (
      SELECT 1 FROM public.room_members rm
      WHERE rm.room_id = questions.room_id
        AND rm.user_id = auth.uid()
        AND rm.left_at IS NULL
    )
  ) OR (
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = questions.room_id
        AND r.guide_id = auth.uid()
    )
  )
);

-- 3. INSERT：有效成员 + 房间 pending/live + user_id=uid()
CREATE POLICY "questions: 有效成员可提问"
ON public.questions
FOR INSERT
TO authenticated
WITH CHECK (
  -- 写入者必须是自己
  user_id = auth.uid()
  AND
  -- 必须是该房间的有效成员（left_at IS NULL）
  EXISTS (
    SELECT 1 FROM public.room_members rm
    WHERE rm.room_id = questions.room_id
      AND rm.user_id = auth.uid()
      AND rm.left_at IS NULL
  )
  AND
  -- 房间必须处于允许互动的状态
  EXISTS (
    SELECT 1 FROM public.rooms r
    WHERE r.id = questions.room_id
      AND r.status IN ('pending', 'live')
  )
);

-- 4. 无 UPDATE policy（全部 DENY）——客户端不得修改问题
-- 5. 无 DELETE  policy（全部 DENY）——客户端不得删除问题
-- （不需要显式语句，RLS 启用时无 policy = DENY）

-- 6. 验收断言：确认 policies 精确为 2 条（SELECT + INSERT）
DO $$
DECLARE v_cnt INTEGER;
BEGIN
  SELECT COUNT(*) INTO v_cnt
  FROM pg_policies
  WHERE schemaname='public' AND tablename='questions';
  IF v_cnt <> 2 THEN
    RAISE EXCEPTION 'a3_02_01 FAIL: expected 2 policies on questions, found %', v_cnt;
  END IF;
  RAISE NOTICE 'a3_02_01 PASS: questions has % policies (SELECT+INSERT)', v_cnt;
END; $$;
