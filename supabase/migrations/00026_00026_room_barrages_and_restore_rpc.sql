
-- ================================================================
-- Migration 00026: 弹幕表 + RLS + 索引 + Realtime + currentRoom恢复RPC
-- 幂等，保留所有现有业务数据
-- ================================================================

-- 1. 创建弹幕表（幂等）
CREATE TABLE IF NOT EXISTS public.room_barrages (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  room_id     uuid        NOT NULL REFERENCES public.rooms(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL DEFAULT auth.uid() REFERENCES public.profiles(id) ON DELETE CASCADE,
  content     text        NOT NULL CHECK (char_length(content) BETWEEN 1 AND 30),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 2. 索引：按房间+时间查询
CREATE INDEX IF NOT EXISTS idx_barrages_room_time
  ON public.room_barrages(room_id, created_at DESC);

-- 3. RLS
ALTER TABLE public.room_barrages ENABLE ROW LEVEL SECURITY;

-- 有效房间成员（left_at IS NULL）或导游可读
DROP POLICY IF EXISTS "barrages: 成员和导游可查看" ON public.room_barrages;
CREATE POLICY "barrages: 成员和导游可查看" ON public.room_barrages
  FOR SELECT TO authenticated USING (
    user_id = auth.uid()
    OR room_id IN (SELECT id FROM public.rooms WHERE guide_id = auth.uid())
    OR EXISTS (
      SELECT 1 FROM public.room_members rm
      WHERE rm.room_id = room_barrages.room_id
        AND rm.user_id = auth.uid()
        AND rm.left_at IS NULL
    )
  );

-- live 状态下才可创建；只能以自己 uid 写入；不开放匿名写
DROP POLICY IF EXISTS "barrages: live 成员可发送" ON public.room_barrages;
CREATE POLICY "barrages: live 成员可发送" ON public.room_barrages
  FOR INSERT TO authenticated WITH CHECK (
    user_id = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.rooms r
      WHERE r.id = room_barrages.room_id
        AND r.status = 'live'
    )
    AND EXISTS (
      SELECT 1 FROM public.room_members rm
      WHERE rm.room_id = room_barrages.room_id
        AND rm.user_id = auth.uid()
        AND rm.left_at IS NULL
    )
  );

-- 4. 加入 Realtime 发布
DO $$
BEGIN
  ALTER PUBLICATION supabase_realtime ADD TABLE public.room_barrages;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- 5. questions: is_answered 更新权限（仅导游可标记，幂等）
DROP POLICY IF EXISTS "questions: 导游可标记已回答" ON public.questions;
CREATE POLICY "questions: 导游可标记已回答" ON public.questions
  FOR UPDATE TO authenticated
  USING (room_id IN (SELECT id FROM public.rooms WHERE guide_id = auth.uid()))
  WITH CHECK (room_id IN (SELECT id FROM public.rooms WHERE guide_id = auth.uid()));

-- 6. SECURITY DEFINER RPC: 按 user_id 恢复最近有效房间
--    left_at IS NULL 且 room.status != 'ended'，按 joined_at DESC
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
    AND rm.left_at IS NULL
    AND r.status != 'ended'
    AND rm.user_id = auth.uid()   -- 只能查自己
  ORDER BY rm.joined_at DESC
  LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.restore_current_room_for_user(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.restore_current_room_for_user(uuid) TO authenticated;
