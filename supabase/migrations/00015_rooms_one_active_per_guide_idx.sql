
-- 部分唯一索引：同一导游最多一个 pending 或 live 房间
-- 幂等：已存在则跳过，不影响 ended 历史房间
CREATE UNIQUE INDEX IF NOT EXISTS rooms_one_active_per_guide_idx
  ON public.rooms (guide_id)
  WHERE status IN ('pending', 'live');
