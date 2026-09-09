/**
 * profiles.ts — 个人资料安全读取层（A3-3 / A3-3p）
 *
 * - fetchMyProfile()：通过 RPC get_my_profile_private() 读取本人资料
 *   永不使用 select('*')，永不返回 wechat_openid/wechat_pwd 等认证字段。
 * - fetchRoomPublicProfiles()：通过 RPC get_room_public_profiles() 读取指定房间成员公开信息
 *   调用方须为该房导游或有效成员，禁止传任意 user_id 枚举。
 * - fetchRoomMembersSafe()：通过 RPC get_room_members_safe() 读取房间成员列表（left_at IS NULL）
 *   与旧 fetchRoomMembers 返回结构兼容，替换 GuideScreens/GuideExtra 运行时调用。
 * - fetchRoomMemberHistory()：读取除导游外所有进入过房间的成员，
 *   合并 room_members 与 approved memberships，并按 user_id 去重。
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

type HistoryRow = {
  id: string;
  room_id: string;
  user_id: string;
  role: string;
  joined_at: string;
  left_at: string | null;
  profile_id?: string | null;
  profile_username?: string | null;
  profile_nickname?: string | null;
  profile_avatar_url?: string | null;
  profile?: {
    id: string;
    username: string | null;
    nickname: string | null;
    avatar_url: string | null;
  } | null;
};

function mapHistoryRow(row: HistoryRow): RoomMember {
  const profile = row.profile ?? (row.profile_id ? {
    id: row.profile_id,
    username: row.profile_username ?? '',
    nickname: row.profile_nickname ?? null,
    avatar_url: row.profile_avatar_url ?? null,
  } : null);
  return {
    id: row.id,
    room_id: row.room_id,
    user_id: row.user_id,
    role: row.role as RoomMember["role"],
    joined_at: row.joined_at,
    left_at: row.left_at,
    profile: profile ? {
      id: profile.id,
      username: profile.username ?? '',
      nickname: profile.nickname,
      avatar_url: profile.avatar_url,
    } : undefined,
  };
}

async function fetchRoomMembersHistoryDirect(roomId: string): Promise<RoomMember[]> {
  const { data, error } = await supabase
    .from("room_members")
    .select("id, room_id, user_id, role, joined_at, left_at")
    .eq("room_id", roomId)
    .neq("role", "guide")
    .order("joined_at", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as HistoryRow[];
  const ids = [...new Set(rows.map(row => row.user_id))];
  if (ids.length === 0) return [];

  // 不使用跨表嵌套查询：不同 Supabase schema cache 版本可能无法解析
  // room_members_user_id_fkey，导致整个游客列表直接失败。
  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id,username,nickname,avatar_url")
    .in("id", ids);
  if (profilesError) {
    console.warn("[GuestListHistory] profile lookup failed", profilesError.message);
  }
  const profileById = new Map((profiles ?? []).map(profile => [profile.id, profile]));
  return rows.map(row => mapHistoryRow({
    ...row,
    profile: profileById.get(row.user_id) ?? null,
  }));
}

async function fetchPhotographerHistoryDirect(roomId: string): Promise<RoomMember[]> {
  const { data, error } = await supabase
    .from("memberships")
    .select("id, room_id, user_id, role, joined_at, left_at")
    .eq("room_id", roomId)
    .eq("approval_status", "approved")
    .neq("role", "guide")
    .order("joined_at", { ascending: true });
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as HistoryRow[];
  const ids = [...new Set(rows.map(row => row.user_id))];
  if (ids.length === 0) return [];
  const { data: profiles, error: profilesError } = await supabase
    .from("profiles")
    .select("id,username,nickname,avatar_url")
    .in("id", ids);
  if (profilesError) {
    // 摄影师身份仍可展示；昵称缺失不能阻断全部历史游客。
    console.warn("[GuestListHistory] photographer profile lookup failed", profilesError.message);
  }
  const profileById = new Map((profiles ?? []).map(profile => [profile.id, profile]));
  return rows.map(row => mapHistoryRow({
    ...row,
    profile: profileById.get(row.user_id) ?? null,
  }));
}

/**
 * 房间全量历史成员读取。
 * - room_members：游客等常规房间成员；
 * - memberships：已通过密码加入的摄影师；
 * - 排除 guide，并以 user_id 去重；
 * - 在线状态由 Presence 单独提供，不依赖 left_at。
 *
 * 兼容策略：
 *   - 优先调用历史成员 RPC；
 *   - 当前数据库尚未部署/授权 RPC 时，回退到受 RLS 保护的表查询；
 *   - 摄影师历史读取失败不阻断游客历史显示；
 *   - 所有历史来源均失败时才抛错，避免把查询失败伪装成 0 人。
 */
export async function fetchRoomMemberHistory(roomId: string): Promise<RoomMember[]> {
  const { data, error } = await supabase.rpc("get_room_member_history_safe", {
    p_room_id: roomId,
  });
  if (error) {
    console.warn("[GuestListHistory] RPC unavailable, using RLS fallback", {
      code: error.code,
      message: error.message,
      details: error.details,
      hint: error.hint,
    });
  }

  let roomMembers: RoomMember[];
  if (!error) {
    roomMembers = ((data ?? []) as HistoryRow[]).map(mapHistoryRow);
  } else {
    roomMembers = await fetchRoomMembersHistoryDirect(roomId);
  }

  let photographers: RoomMember[] = [];
  try {
    photographers = await fetchPhotographerHistoryDirect(roomId);
  } catch (photographerError) {
    console.warn(
      "[GuestListHistory] photographer history unavailable",
      photographerError instanceof Error ? photographerError.message : photographerError,
    );
  }

  const byUserId = new Map<string, RoomMember>();
  [...roomMembers, ...photographers]
    .filter(member => member.role !== "guide")
    .sort((a, b) => new Date(a.joined_at).getTime() - new Date(b.joined_at).getTime())
    .forEach(member => {
      const existing = byUserId.get(member.user_id);
      if (!existing) {
        byUserId.set(member.user_id, member);
        return;
      }
      if (member.role === "photographer" && existing.role !== "photographer") {
        byUserId.set(member.user_id, { ...member, joined_at: existing.joined_at });
      }
    });
  return [...byUserId.values()];
}
