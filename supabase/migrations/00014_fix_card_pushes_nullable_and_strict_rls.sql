
-- ================================================================
-- 阻断级修正迁移：card_pushes.card_id nullable + 重建严格 RLS
-- 增量幂等，不删除任何业务数据
-- ================================================================

-- 1. card_id DROP NOT NULL（保留外键、保留旧值）
ALTER TABLE public.card_pushes ALTER COLUMN card_id DROP NOT NULL;

-- 2. 删除所有旧的 card_pushes 策略（含过宽的 true 策略和重复策略）
DROP POLICY IF EXISTS "card_pushes: 任何已登录可查看"    ON public.card_pushes;
DROP POLICY IF EXISTS "card_pushes: 导游可推送"          ON public.card_pushes;
DROP POLICY IF EXISTS "card_pushes_select"               ON public.card_pushes;
DROP POLICY IF EXISTS "card_pushes_insert"               ON public.card_pushes;
DROP POLICY IF EXISTS "cp_select"                        ON public.card_pushes;
DROP POLICY IF EXISTS "cp_insert"                        ON public.card_pushes;

-- 3. 重建严格 card_pushes SELECT 策略
--    只有：该房间导游 OR 该房间成员（left_at IS NULL）
CREATE POLICY "cp_strict_select" ON public.card_pushes
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = card_pushes.room_id
        AND r.guide_id = auth.uid()
    )
    OR EXISTS (
      SELECT 1 FROM public.room_members rm
      WHERE rm.room_id = card_pushes.room_id
        AND rm.user_id = auth.uid()
        AND rm.left_at IS NULL
    )
  );

-- 4. 重建严格 card_pushes INSERT 策略
--    条件：
--    a) 操作者是该房间的 guide_id
--    b) 新流程：room_card_id 非空时，必须属于同一 room_id
--    c) 兼容旧流程：card_id 非空时允许
--    d) room_card_id 与 card_id 不得同时为空
CREATE POLICY "cp_strict_insert" ON public.card_pushes
  FOR INSERT TO authenticated
  WITH CHECK (
    -- (a) 必须是该房间导游
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = card_pushes.room_id
        AND r.guide_id = auth.uid()
    )
    -- (d) 不能两者都为空
    AND (card_pushes.room_card_id IS NOT NULL OR card_pushes.card_id IS NOT NULL)
    -- (b) 新流程：room_card_id 指向的 room_cards 必须属于同一 room
    AND (
      card_pushes.room_card_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.room_cards rc
        WHERE rc.id = card_pushes.room_card_id
          AND rc.room_id = card_pushes.room_id
      )
    )
  );

-- 5. 核对 room_cards 策略：无需修改（已有4条精确策略），但确认无过宽策略
-- （若存在 true 类策略则删除）
DROP POLICY IF EXISTS "rc_select" ON public.room_cards;
DROP POLICY IF EXISTS "rc_insert" ON public.room_cards;
DROP POLICY IF EXISTS "rc_update" ON public.room_cards;
DROP POLICY IF EXISTS "rc_delete" ON public.room_cards;
