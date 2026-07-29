
-- ================================================================
-- Migration 00024: sequence 服务端自动生成 + 安全 RPC 补查
-- 不删除任何数据，不改旧列
-- ================================================================

-- 1. 数据库函数：在 card_pushes INSERT 时自动计算 sequence
--    同一 room_id 内单调递增，覆盖客户端传入值（BEFORE trigger）
CREATE OR REPLACE FUNCTION public.set_card_push_sequence()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- 取该 room 内已有最大 sequence，+1；首条记录为 1
  SELECT COALESCE(MAX(sequence), 0) + 1
    INTO NEW.sequence
    FROM public.card_pushes
   WHERE room_id = NEW.room_id;
  RETURN NEW;
END;
$$;

-- 2. 绑定 BEFORE INSERT 触发器（幂等：先删再建）
DROP TRIGGER IF EXISTS trg_card_push_sequence ON public.card_pushes;
CREATE TRIGGER trg_card_push_sequence
  BEFORE INSERT ON public.card_pushes
  FOR EACH ROW
  EXECUTE FUNCTION public.set_card_push_sequence();

-- 3. SECURITY DEFINER RPC：游客补查——返回该房间最近一张推送 KC
--    权限边界：调用者必须是该房间 guide 或 room_members 成员
--    排序：sequence DESC NULLS LAST, pushed_at DESC
--    只返回最近一条（单行，非 SETOF）
CREATE OR REPLACE FUNCTION public.get_latest_pushed_kc_for_room(p_room_id uuid)
RETURNS public.knowledge_cards
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT kc.*
  FROM public.knowledge_cards kc
  JOIN public.card_pushes cp ON cp.kc_card_id = kc.id
  WHERE cp.room_id = p_room_id
    -- 权限校验：导游或成员
    AND (
      EXISTS (
        SELECT 1 FROM public.rooms r
        WHERE r.id = p_room_id AND r.guide_id = auth.uid()
      )
      OR EXISTS (
        SELECT 1 FROM public.room_members rm
        WHERE rm.room_id = p_room_id
          AND rm.user_id = auth.uid()
          AND rm.left_at IS NULL
      )
    )
  ORDER BY cp.sequence DESC NULLS LAST, cp.pushed_at DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.get_latest_pushed_kc_for_room(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_latest_pushed_kc_for_room(uuid) TO authenticated;
