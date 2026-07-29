
-- ================================================================
-- 增量迁移：room_cards 表 + card_pushes 扩展 + RLS + Realtime
-- 幂等：所有操作使用 IF NOT EXISTS / DO $$ 保护，不删除任何现有数据
-- ================================================================

-- 1. 创建 room_cards 表（房间卡片快照）
CREATE TABLE IF NOT EXISTS public.room_cards (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id       uuid NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  source_card_id uuid REFERENCES public.knowledge_cards(id) ON DELETE SET NULL,
  title_cn      text NOT NULL,
  title_en      text,
  desc_cn       text NOT NULL DEFAULT '',
  desc_en       text,
  category      text NOT NULL DEFAULT '景点导览',
  image_url     text,
  era           text,
  location      text,
  imported_by   uuid NOT NULL DEFAULT auth.uid(),
  imported_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (room_id, source_card_id)
);

-- 2. card_pushes 新增 room_card_id 列（保留原 card_id 兼容）
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'card_pushes' AND column_name = 'room_card_id'
  ) THEN
    ALTER TABLE public.card_pushes
      ADD COLUMN room_card_id uuid REFERENCES public.room_cards(id) ON DELETE SET NULL;
  END IF;
END $$;

-- 3. 启用 RLS
ALTER TABLE public.room_cards ENABLE ROW LEVEL SECURITY;

-- 4. room_cards RLS 策略

-- 房间成员（含导游）可读
DROP POLICY IF EXISTS "room_cards_select" ON public.room_cards;
CREATE POLICY "room_cards_select" ON public.room_cards
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.room_members rm
      WHERE rm.room_id = room_cards.room_id
        AND rm.user_id = auth.uid()
        AND rm.left_at IS NULL
    )
    OR EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = room_cards.room_id
        AND r.guide_id = auth.uid()
    )
  );

-- 只有房间导游可导入（INSERT）
DROP POLICY IF EXISTS "room_cards_insert" ON public.room_cards;
CREATE POLICY "room_cards_insert" ON public.room_cards
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = room_cards.room_id
        AND r.guide_id = auth.uid()
    )
  );

-- 只有房间导游可更新
DROP POLICY IF EXISTS "room_cards_update" ON public.room_cards;
CREATE POLICY "room_cards_update" ON public.room_cards
  FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = room_cards.room_id
        AND r.guide_id = auth.uid()
    )
  );

-- 只有房间导游可删除
DROP POLICY IF EXISTS "room_cards_delete" ON public.room_cards;
CREATE POLICY "room_cards_delete" ON public.room_cards
  FOR DELETE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = room_cards.room_id
        AND r.guide_id = auth.uid()
    )
  );

-- 5. card_pushes RLS（补全 room_card_id 相关策略，保留原有逻辑）
-- 先检查是否已有策略，若无则创建
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'card_pushes' AND policyname = 'card_pushes_select'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "card_pushes_select" ON public.card_pushes
        FOR SELECT TO authenticated
        USING (
          EXISTS (
            SELECT 1 FROM public.room_members rm
            WHERE rm.room_id = card_pushes.room_id
              AND rm.user_id = auth.uid()
              AND rm.left_at IS NULL
          )
          OR EXISTS (
            SELECT 1 FROM public.rooms r
            WHERE r.id = card_pushes.room_id
              AND r.guide_id = auth.uid()
          )
        )
    $policy$;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'public' AND tablename = 'card_pushes' AND policyname = 'card_pushes_insert'
  ) THEN
    EXECUTE $policy$
      CREATE POLICY "card_pushes_insert" ON public.card_pushes
        FOR INSERT TO authenticated
        WITH CHECK (
          EXISTS (
            SELECT 1 FROM public.rooms r
            WHERE r.id = card_pushes.room_id
              AND r.guide_id = auth.uid()
          )
        )
    $policy$;
  END IF;
END $$;

-- 6. 旧数据迁移：把 cards 表存量卡片复制进 knowledge_cards（跳过已存在同名的）
INSERT INTO public.knowledge_cards (title_cn, title_en, desc_cn, desc_en, category, image_url, status, created_by, created_at)
SELECT
  c.title_cn,
  c.title_en,
  c.content_cn,
  c.content_en,
  c.category,
  c.image_url,
  'published',
  c.created_by,
  c.created_at
FROM public.cards c
WHERE NOT EXISTS (
  SELECT 1 FROM public.knowledge_cards kc
  WHERE kc.title_cn = c.title_cn AND kc.created_by = c.created_by
)
ON CONFLICT DO NOTHING;

-- 7. 为历史 card_pushes 记录尝试生成 room_cards 快照并回填 room_card_id
-- 先插快照（对应 knowledge_cards 中能匹配的记录）
INSERT INTO public.room_cards (room_id, source_card_id, title_cn, title_en, desc_cn, desc_en, category, image_url, era, location, imported_by, imported_at)
SELECT DISTINCT
  cp.room_id,
  kc.id          AS source_card_id,
  kc.title_cn,
  kc.title_en,
  kc.desc_cn,
  kc.desc_en,
  kc.category,
  kc.image_url,
  kc.era,
  kc.location,
  COALESCE(r.guide_id, cp.pushed_by) AS imported_by,
  cp.pushed_at   AS imported_at
FROM public.card_pushes cp
JOIN public.cards c ON c.id = cp.card_id
JOIN public.knowledge_cards kc ON kc.title_cn = c.title_cn
JOIN public.rooms r ON r.id = cp.room_id
WHERE cp.room_card_id IS NULL
ON CONFLICT (room_id, source_card_id) DO NOTHING;

-- 回填 room_card_id
UPDATE public.card_pushes cp
SET room_card_id = rc.id
FROM public.room_cards rc
JOIN public.knowledge_cards kc ON kc.id = rc.source_card_id
JOIN public.cards c ON c.title_cn = kc.title_cn
WHERE cp.card_id = c.id
  AND cp.room_id = rc.room_id
  AND cp.room_card_id IS NULL;

-- 8. 将 room_cards 和 card_pushes 加入 Realtime publication
DO $$
BEGIN
  -- room_cards
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'room_cards'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.room_cards;
  END IF;
  -- card_pushes（确保已在）
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'card_pushes'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.card_pushes;
  END IF;
END $$;
