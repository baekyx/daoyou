/**
 * profiles.ts — 个人资料安全读取层（A3-3 / A3-3p）
 *
 * - fetchMyProfile()：通过 RPC get_my_profile_private() 读取本人资料
 *   永不使用 select('*')，永不返回 wechat_openid/wechat_pwd 等认证字段。
 * - fetchRoomPublicProfiles()：通过 RPC get_room_public_profiles() 读取指定房间成员公开信息
 *   调用方须为该房导游或有效成员，禁止传任意 user_id 枚举。
 * - fetchRoomMembersSafe()：通过 RPC get_room_members_safe() 读取房间成员列表（left_at IS NULL）
 *   与旧 fetchRoomMembers 返回结构兼容，替换 GuideScreens/GuideExtra 运行时调用。
 * - fetchRoomMemberHistory()：通过 RPC get_room_member_history_safe() 读取全部 tourist 历史成员
 *   不过滤 left_at，仅导游可调用；GuestList 历史列表数据源。
 *
 * Cutover 待撤销清单：
 *   - roomActivity.ts fetchRoomMembers 定义（暂保留，页面已切换到 fetchRoomMembersSafe）
 *   - roomActivity.ts fetchQuestions/fetchBarrages 内的 profiles join（字段已限定，后续 Cutover）
 *   - photos.ts fetchPhotos（已被 get_room_photos RPC 替换）
 */
import { supabase } from "@/db/supabase";
import type { Profile, RoomMember } from "@/types/types";

/** 本人资料安全读取（通过 SECURITY DEFINER RPC，永不含微信凭据）
 *  - RPC 网络/权限错误：抛出 Error，让调用方 catch 生效（不吞成 null）
 *  - 确实无资料（data 为空数组）：返回 null（正常新用户状态）
 */
export async function fetchMyProfile(): Promise<Profile | null> {
  const { data, error } = await supabase.rpc("get_my_profile_private");
  if (error) throw new Error(error.message);
  if (!data || !Array.isArray(data) || data.length === 0) return null;
  return data[0] as Profile;
}

export interface RoomPublicProfile {
  id: string;
  username: string | null;
  nickname: string | null;
  avatar_url: string | null;
  member_role: string; // 'guide' | 'tourist'
}

/** 房间成员公开资料（仅导游或有效成员可调用，禁止传任意 user_id） */
export async function fetchRoomPublicProfiles(roomId: string): Promise<RoomPublicProfile[]> {
  const { data, error } = await supabase.rpc("get_room_public_profiles", {
    p_room_id: roomId,
  });
  if (error || !data) return [];
  return Array.isArray(data) ? (data as RoomPublicProfile[]) : [];
}

/**
 * 房间成员列表安全读取（通过 SECURITY DEFINER RPC get_room_members_safe）
 * 调用者必须是该房导游或有效成员，返回结构与旧 RoomMember 兼容。
 * 注意：仅返回 left_at IS NULL 的当前成员（旧口径）。
 * 历史成员（含已退出）请使用 fetchRoomMemberHistory。
 */
export async function fetchRoomMembersSafe(roomId: string): Promise<RoomMember[]> {
  const { data, error } = await supabase.rpc("get_room_members_safe", {
    p_room_id: roomId,
  });
  if (error || !data) return [];
  // RPC 返回扁平行，前端还原为 { ...rm, profile: { id, username, nickname, avatar_url } }
  return (data as Array<{
    id: string; room_id: string; user_id: string; role: string;
    joined_at: string; left_at: string | null;
    profile_id: string | null; profile_username: string | null;
    profile_nickname: string | null; profile_avatar_url: string | null;
  }>).map(row => ({
    id: row.id,
    room_id: row.room_id,
    user_id: row.user_id,
    role: row.role as RoomMember["role"],
    joined_at: row.joined_at,
    left_at: row.left_at,
    profile: row.profile_id ? {
      id: row.profile_id,
      username: row.profile_username ?? '',   // Profile.username は string（非 nullable）に合わせる
      nickname: row.profile_nickname,
      avatar_url: row.profile_avatar_url,
    } : undefined,
  }));
}

/**
 * 房间全量历史成员读取（通过 SECURITY DEFINER RPC get_room_member_history_safe）
 * 仅该房导游可调用；返回全部 role=tourist 成员，不按 left_at 过滤，按 joined_at ASC。
 * 用于 GuestList 历史列表——在线状态由 Presence 单独提供，不依赖 left_at 判断。
 *
 * 错误策略（v379）：
 *   - RPC error 必须抛出，不伪装为 []，让调用方区分"真正 0 条"和"查询失败"；
 *   - data 为 null/empty 时正常返回 []。
 */
export async function fetchRoomMemberHistory(roomId: string): Promise<RoomMember[]> {
  const { data, error } = await supabase.rpc("get_room_member_history_safe", {
    p_room_id: roomId,
  });
  if (error) {
    // 输出完整诊断信息（不含敏感字段），让调用方决策重试还是终止
    console.error('[GuestListHistory] RPC error', {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
    throw error;
  }
  if (!data) return [];
  return (data as Array<{
    id: string; room_id: string; user_id: string; role: string;
    joined_at: string; left_at: string | null;
    profile_id: string | null; profile_username: string | null;
    profile_nickname: string | null; profile_avatar_url: string | null;
  }>).map(row => ({
    id: row.id,
    room_id: row.room_id,
    user_id: row.user_id,
    role: row.role as RoomMember["role"],
    joined_at: row.joined_at,
    left_at: row.left_at,
    profile: row.profile_id ? {
      id: row.profile_id,
      username: row.profile_username ?? '',
      nickname: row.profile_nickname,
      avatar_url: row.profile_avatar_url,
    } : undefined,
  }));
}
