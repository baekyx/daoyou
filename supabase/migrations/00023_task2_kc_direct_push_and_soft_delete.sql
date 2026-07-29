
-- ================================================================
-- Task 2：KC 单一数据源、软删除与推送链路改造
-- 增量幂等，不删除任何业务数据
-- ================================================================

-- 1. knowledge_cards 新增 deleted_at（软删除字段）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='knowledge_cards' AND column_name='deleted_at'
  ) THEN
    ALTER TABLE public.knowledge_cards ADD COLUMN deleted_at timestamptz DEFAULT NULL;
  END IF;
END $$;

-- 2. card_pushes 新增 kc_card_id（直接引用 KC，新推送链路）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='card_pushes' AND column_name='kc_card_id'
  ) THEN
    ALTER TABLE public.card_pushes
      ADD COLUMN kc_card_id uuid REFERENCES public.knowledge_cards(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3. card_pushes 新增 sequence（推送顺序，便于历史排序）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='card_pushes' AND column_name='sequence'
  ) THEN
    ALTER TABLE public.card_pushes ADD COLUMN sequence int;
  END IF;
END $$;

-- 4. 更新 cp_strict_insert 策略：允许仅有 kc_card_id 的新推送
DROP POLICY IF EXISTS "cp_strict_insert" ON public.card_pushes;
CREATE POLICY "cp_strict_insert" ON public.card_pushes
  FOR INSERT TO authenticated
  WITH CHECK (
    -- 必须是该房间导游
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = card_pushes.room_id
        AND r.guide_id = auth.uid()
    )
    -- 三个来源字段至少有一个非空
    AND (
      card_pushes.kc_card_id IS NOT NULL
      OR card_pushes.room_card_id IS NOT NULL
      OR card_pushes.card_id IS NOT NULL
    )
    -- kc_card_id 引用的卡片必须存在且未软删除
    AND (
      card_pushes.kc_card_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.knowledge_cards kc
        WHERE kc.id = card_pushes.kc_card_id
          AND kc.deleted_at IS NULL
      )
    )
  );

-- 5. SECURITY DEFINER RPC：游客按房间推送记录精确读取 KC
--    只返回当前房间内已推送的 KC 卡片，不开放全库读取
CREATE OR REPLACE FUNCTION public.get_pushed_kc_for_room(p_room_id uuid)
RETURNS SETOF public.knowledge_cards
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT kc.*
  FROM public.knowledge_cards kc
  JOIN public.card_pushes cp ON cp.kc_card_id = kc.id
  WHERE cp.room_id = p_room_id
    AND (
      -- 调用者是该房间成员
      EXISTS (
        SELECT 1 FROM public.room_members rm
        WHERE rm.room_id = p_room_id
          AND rm.user_id = auth.uid()
          AND rm.left_at IS NULL
      )
      -- 或调用者是该房间导游
      OR EXISTS (
        SELECT 1 FROM public.rooms r
        WHERE r.id = p_room_id
          AND r.guide_id = auth.uid()
      )
    );
$$;
REVOKE ALL ON FUNCTION public.get_pushed_kc_for_room(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_pushed_kc_for_room(uuid) TO authenticated;

-- 6. SECURITY DEFINER RPC：按 kc_card_id 读取单张 KC（游客需通过推送关系验证）
CREATE OR REPLACE FUNCTION public.get_kc_by_push(p_room_id uuid, p_kc_card_id uuid)
RETURNS public.knowledge_cards
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT kc.*
  FROM public.knowledge_cards kc
  WHERE kc.id = p_kc_card_id
    AND EXISTS (
      SELECT 1 FROM public.card_pushes cp
      WHERE cp.room_id = p_room_id
        AND cp.kc_card_id = p_kc_card_id
    )
    AND (
      EXISTS (
        SELECT 1 FROM public.room_members rm
        WHERE rm.room_id = p_room_id
          AND rm.user_id = auth.uid()
          AND rm.left_at IS NULL
      )
      OR EXISTS (
        SELECT 1 FROM public.rooms r
        WHERE r.id = p_room_id
          AND r.guide_id = auth.uid()
      )
    )
  LIMIT 1;
$$;
REVOKE ALL ON FUNCTION public.get_kc_by_push(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_kc_by_push(uuid, uuid) TO authenticated;

-- 7. 索引：加速按房间查推送历史
CREATE INDEX IF NOT EXISTS idx_card_pushes_room_kc
  ON public.card_pushes(room_id, kc_card_id, pushed_at DESC);
