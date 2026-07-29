import { supabase } from "@/db/supabase";
import type { Room } from "@/types/types";

/**
 * A2 预置：生成6位随机密码（仅供 CreateRoom UI 展示用）
 * 密码在本次建房流程中由 sessionStorage 临时持有，不从 DB 读取
 */
export function genPassword() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

/** 解析 RPC 返回的 JSONB room 字段为 Room 类型（不含 password） */
function parseRoomJson(raw: unknown): Room | null {
  if (!raw || typeof raw !== "object") return null;
  return raw as Room;
}

/**
 * 创建讲解房（安全版）
 * 调用 create_room_secure RPC；服务端生成 room_number、校验角色/名称/密码格式、并发安全
 * 过渡期：RPC 内部仍写 rooms.password 供旧线上兼容，触发器同步 hash
 * 返回的 room 对象不含 password
 */
export async function createRoom(params: {
  name: string;
  cover_url?: string | null;
  guide_id?: string;   // 过渡期保留签名兼容，RPC 内部使用 auth.uid()
  estimated_duration?: number;
  password?: string;
}): Promise<{ room: Room | null; error: string | null; existed?: boolean }> {
  const password = params.password ?? genPassword();
  const { data, error } = await supabase.rpc("create_room_secure", {
    p_name:               params.name,
    p_password:           password,
    p_cover_url:          params.cover_url ?? null,
    p_estimated_duration: params.estimated_duration ?? 60,
  });

  if (error) return { room: null, error: error.message };

  const result = data as { ok: boolean; code: string; room?: unknown };
  if (!result.ok) {
    const codeMsg: Record<string, string> = {
      not_authenticated:    "请先登录",
      forbidden:            "仅导游可创建房间",
      invalid_name:         "房间名须为2~30字",
      invalid_password:     "密码须为6位数字",
      room_number_exhausted:"房间号生成冲突，请重试",
      concurrent_conflict:  "并发冲突，请稍后重试",
    };
    return { room: null, error: codeMsg[result.code] ?? result.code };
  }

  const existed = result.code === "existed";
  const room = parseRoomJson(result.room);
  return { room, error: null, existed };
}

/** 获取导游的房间列表（安全版，不含 password） */
export async function fetchGuideRooms(_guideId?: string): Promise<Room[]> {
  const { data, error } = await supabase.rpc("get_guide_rooms_secure");
  if (error || !data) return [];
  const arr = Array.isArray(data) ? data : (data as unknown[]);
  return arr.map(parseRoomJson).filter((r): r is Room => r !== null);
}

/** 获取所有 live/pending 房间（游客查看，安全版，不含 password） */
export async function fetchActiveRooms(): Promise<Room[]> {
  const { data, error } = await supabase.rpc("get_active_rooms_secure");
  if (error || !data) return [];
  const arr = Array.isArray(data) ? data : (data as unknown[]);
  return arr.map(parseRoomJson).filter((r): r is Room => r !== null);
}

/** 按房间号查找房间（安全版，不含 password） */
export async function fetchRoomByNumber(roomNumber: string): Promise<Room | null> {
  const { data, error } = await supabase.rpc("get_room_by_number_secure", {
    p_room_number: roomNumber,
  });
  if (error || !data) return null;
  return parseRoomJson(data);
}

/** 按 ID 获取房间（安全版，不含 password） */
export async function fetchRoomById(roomId: string): Promise<Room | null> {
  const { data, error } = await supabase.rpc("get_room_by_id_secure", {
    p_room_id: roomId,
  });
  if (error || !data) return null;
  return parseRoomJson(data);
}

/** 导游本人安全读取自己房间的明文密码（仅 guide_id = auth.uid() 时返回） */
export async function fetchMyRoomPassword(roomId: string): Promise<string | null> {
  const { data, error } = await supabase.rpc('get_my_room_password', { p_room_id: roomId });
  if (error || !data) return null;
  return String(data);
}
export async function updateRoomStatus(
  roomId: string,
  status: "pending" | "live" | "ended",
  extra?: { started_at?: string; ended_at?: string; actual_duration?: number }
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from("rooms")
    .update({ status, ...extra })
    .eq("id", roomId);
  return { error: error?.message ?? null };
}

/** 更新房间在线人数 */
export async function updateOnlineCount(roomId: string, delta: number): Promise<void> {
  await supabase.rpc("increment_online_count", { room_id: roomId, delta });
}

/** 上传房间封面（保留用于向后兼容；新代码请用 uploadRoomCoverBlob） */
export async function uploadRoomCover(guideId: string, roomId: string, file: File): Promise<string | null> {
  const path = `${guideId}/${roomId}.jpg`;
  const { data, error } = await supabase.storage
    .from("room-covers")
    .upload(path, file, { upsert: true, contentType: file.type });
  if (error || !data) return null;
  const { data: urlData } = supabase.storage.from("room-covers").getPublicUrl(data.path);
  return urlData.publicUrl;
}
