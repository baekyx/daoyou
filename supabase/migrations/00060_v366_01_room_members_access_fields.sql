
-- ══════════════════════════════════════════════════════════════════
-- v366 Migration 01: room_members 增加授权字段 + 回填现有数据
-- ══════════════════════════════════════════════════════════════════

-- 1. 增加两个授权字段
ALTER TABLE public.room_members
  ADD COLUMN IF NOT EXISTS access_granted_at  timestamptz,
  ADD COLUMN IF NOT EXISTS access_revoked_at  timestamptz;

-- 2. 回填规则：
--    - left_at IS NULL（当前有效在线成员）→ 视为已授权，回填 access_granted_at
--    - left_at IS NOT NULL（曾经离开的历史成员）→ 不自动授权，等下次正确输密码再获得授权
--    这样被移出的账号不会在此 migration 中获得免密进入权

UPDATE public.room_members
SET
  access_granted_at = COALESCE(joined_at, NOW()),
  access_revoked_at = NULL
WHERE left_at IS NULL
  AND access_granted_at IS NULL;

-- 3. 验证（信息性）
DO $$
DECLARE
  v_granted INT;
  v_total   INT;
BEGIN
  SELECT COUNT(*) INTO v_granted FROM public.room_members WHERE access_granted_at IS NOT NULL;
  SELECT COUNT(*) INTO v_total   FROM public.room_members;
  RAISE NOTICE 'v366_01: total=%, granted=%', v_total, v_granted;
END;
$$;
