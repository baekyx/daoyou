
-- v367: 移除"导游踢出游客"RPC（产品决策：成员列表仅供查看）
-- 保留 room_members.access_granted_at / access_revoked_at 字段及其他授权 RPC
DROP FUNCTION IF EXISTS public.guide_remove_room_member(UUID, UUID);
