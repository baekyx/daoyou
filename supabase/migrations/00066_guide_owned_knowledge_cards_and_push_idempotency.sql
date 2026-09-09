-- 导游知识卡改为“仅本人可见、可写、可推送”，并保证同一房间同一卡片只推送一次。

DROP POLICY IF EXISTS kc_select ON public.knowledge_cards;
DROP POLICY IF EXISTS kc_insert ON public.knowledge_cards;
DROP POLICY IF EXISTS kc_update ON public.knowledge_cards;
DROP POLICY IF EXISTS kc_delete ON public.knowledge_cards;

CREATE POLICY kc_select ON public.knowledge_cards
  FOR SELECT TO authenticated
  USING (created_by = auth.uid());

CREATE POLICY kc_insert ON public.knowledge_cards
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by = auth.uid()
    AND EXISTS (
      SELECT 1
      FROM public.profiles
      WHERE id = auth.uid() AND role = 'guide'
    )
  );

CREATE POLICY kc_update ON public.knowledge_cards
  FOR UPDATE TO authenticated
  USING (created_by = auth.uid())
  WITH CHECK (created_by = auth.uid());

CREATE POLICY kc_delete ON public.knowledge_cards
  FOR DELETE TO authenticated
  USING (created_by = auth.uid());

DROP POLICY IF EXISTS cp_strict_insert ON public.card_pushes;
CREATE POLICY cp_strict_insert ON public.card_pushes
  FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1
      FROM public.rooms r
      WHERE r.id = card_pushes.room_id
        AND r.guide_id = auth.uid()
    )
    AND (
      card_pushes.kc_card_id IS NOT NULL
      OR card_pushes.room_card_id IS NOT NULL
      OR card_pushes.card_id IS NOT NULL
    )
    AND (
      card_pushes.kc_card_id IS NULL
      OR EXISTS (
        SELECT 1
        FROM public.knowledge_cards kc
        WHERE kc.id = card_pushes.kc_card_id
          AND kc.created_by = auth.uid()
          AND kc.deleted_at IS NULL
      )
    )
  );

CREATE OR REPLACE FUNCTION public.prevent_duplicate_kc_push()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.kc_card_id IS NULL THEN
    RETURN NEW;
  END IF;

  -- 同一房间、同一卡片的并发插入串行化；不删除任何既有业务数据。
  PERFORM pg_advisory_xact_lock(
    hashtextextended(NEW.room_id::text || ':' || NEW.kc_card_id::text, 0)
  );

  IF EXISTS (
    SELECT 1
    FROM public.card_pushes
    WHERE room_id = NEW.room_id
      AND kc_card_id = NEW.kc_card_id
  ) THEN
    RETURN NULL;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_card_push_dedupe ON public.card_pushes;
CREATE TRIGGER trg_card_push_dedupe
  BEFORE INSERT ON public.card_pushes
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_duplicate_kc_push();

