
-- ================================================================
-- Migration 00027: 三项纠偏
-- 1. 替换 restore_current_room_for_user：支持 ended 只读态，优先 pending/live
-- 2. 新增 mark_question_answered SECURITY DEFINER RPC（最小权限）
-- 3. 删除 00026 新增的宽泛 questions guide UPDATE policy
-- 不删除任何业务数据，不破坏原有必要 RLS
-- ================================================================

-- ── 1. 替换 restore RPC ─────────────────────────────────────────
-- 规则：
--   a. 只能查 auth.uid() 自己的 left_at IS NULL 成员房间
--   b. 优先 status IN ('pending','live')，再允许最近 ended
--   c. 同状态下 joined_at DESC
--   d. 绝不跨用户、跨房间
CREATE OR REPLACE FUNCTION public.restore_current_room_for_user(p_user_id uuid)
RETURNS public.rooms
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.*
  FROM public.rooms r
  JOIN public.room_members rm ON rm.room_id = r.id
  WHERE rm.user_id = p_user_id
    AND rm.user_id = auth.uid()       -- 只能查自己
    AND rm.left_at IS NULL
  ORDER BY
    -- 优先 pending/live（CASE 值越小越优先）
    CASE r.status
      WHEN 'live'    THEN 1
      WHEN 'pending' THEN 2
      ELSE               3            -- ended 及其他
    END ASC,
    rm.joined_at DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.restore_current_room_for_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.restore_current_room_for_user(uuid) TO authenticated;

-- ── 2. 新增 mark_question_answered SECURITY DEFINER RPC ─────────
-- 只允许把 is_answered 更新为 true；内部校验 guide_id；不依赖 RLS UPDATE
CREATE OR REPLACE FUNCTION public.mark_question_answered(p_question_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_room_id uuid;
BEGIN
  -- 取该 question 的 room_id
  SELECT room_id INTO v_room_id
  FROM public.questions
  WHERE id = p_question_id;

  IF v_room_id IS NULL THEN
    RETURN false;
  END IF;

  -- 验证 auth.uid() 是该 room 的 guide
  IF NOT EXISTS (
    SELECT 1 FROM public.rooms
    WHERE id = v_room_id AND guide_id = auth.uid()
  ) THEN
    RETURN false;
  END IF;

  -- 只更新 is_answered，不能改其他字段
  UPDATE public.questions
  SET is_answered = true
  WHERE id = p_question_id;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.mark_question_answered(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_question_answered(uuid) TO authenticated;

-- ── 3. 删除 00026 新增的宽泛 questions guide UPDATE policy ───────
DROP POLICY IF EXISTS "questions: 导游可标记已回答" ON public.questions;
