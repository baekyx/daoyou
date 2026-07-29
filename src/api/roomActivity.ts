import { supabase } from "@/db/supabase";
import type { Subtitle, Question, RoomMember, Room, Barrage, RoomAccessResult } from "@/types/types";
import { readLocalSubtitles, translateText } from "@/lib/voiceApi";

// ===== 成员 =====

/**
 * checkRoomAccess: 调用 check_room_access RPC
 * 所有入口进入房间前必须先调用此函数决定路由
 * 返回 { authorized, room_status, reason }
 */
export async function checkRoomAccess(roomId: string): Promise<RoomAccessResult> {
  const { data, error } = await supabase.rpc("check_room_access", { p_room_id: roomId });
  if (error) return { authorized: false, room_status: null, reason: error.message };
  return data as RoomAccessResult;
}

/**
 * enterRoom: 统一入口路由决策（纯逻辑，不负责 setCurrentRoom）
 * 调用方需先 setCurrentRoom(room)，再调用 enterRoom 决定跳转目标
 * 返回：'listening' | 'password' | 'subtitle-history' | 'room-list'
 */
export async function resolveRoomEntry(roomId: string): Promise<{
  target: 'listening' | 'password' | 'subtitle-history' | 'room-list';
  reason: string;
}> {
  const access = await checkRoomAccess(roomId);
  if (access.reason === 'room_not_found' || access.reason === 'not_authenticated') {
    return { target: 'room-list', reason: access.reason };
  }
  if (access.room_status === 'ended' || access.room_status === 'archived') {
    return { target: 'subtitle-history', reason: 'room_ended' };
  }
  if (access.authorized) {
    // 有效授权 + pending/live → 恢复 left_at=NULL 并进入
    await joinRoom(roomId);
    return { target: 'listening', reason: 'authorized' };
  }
  // 未授权 + pending/live → 密码页
  return { target: 'password', reason: 'no_access' };
}

/**
 * joinRoom: 调用 resume_room_membership（仅已有有效授权的成员恢复，服务端校验）
 * 首次加入请使用 joinRoomWithPassword；此函数仅用于已有有效授权的会话恢复路径
 */
export async function joinRoom(roomId: string, _userId?: string, _role?: string): Promise<{ error: string | null }> {
  const { data, error } = await supabase.rpc("resume_room_membership", { p_room_id: roomId });
  if (error) return { error: error.message };
  const result = data as { ok: boolean; code: string };
  if (!result?.ok) {
    return { error: result?.code === "not_authorized" ? "无有效授权，请先验证密码" : (result?.code ?? "操作失败") };
  }
  return { error: null };
}



/**
 * verifyRoomPasswordOnly: A2 预置版 — 仅服务端校验密码 + 限流，绝不写 room_members/memberships
 * 摄影师申请时使用：验证通过后由调用方自行处理 memberships 写入
 * 返回：{ ok, code, attemptsRemaining, retryAfterSeconds }
 */
export async function verifyRoomPasswordOnly(
  roomId: string,
  password: string
): Promise<{
  ok: boolean;
  code: string;
  attemptsRemaining?: number;
  retryAfterSeconds?: number;
}> {
  const { data, error } = await supabase.rpc("verify_room_password_only", {
    p_room_id: roomId,
    p_password: password,
  });
  if (error) return { ok: false, code: error.message };
  const result = data as {
    ok: boolean;
    code: string;
    attempts_remaining?: number;
    retry_after_seconds?: number;
  };
  return {
    ok:                result.ok,
    code:              result.code,
    attemptsRemaining: result.attempts_remaining,
    retryAfterSeconds: result.retry_after_seconds,
  };
}

/**
 * joinRoomWithPassword: A2 预置版 — 服务端 bcrypt 校验 + 限流
 * 首次加入（游客）或重新验证密码时使用；成功后写入 room_members tourist 角色
 * 摄影师禁止调用此函数，请使用 verifyRoomPasswordOnly
 * 返回：{ ok, code, attemptsRemaining, retryAfterSeconds }
 */
export async function joinRoomWithPassword(
  roomId: string,
  password: string
): Promise<{
  ok: boolean;
  code: string;
  attemptsRemaining?: number;
  retryAfterSeconds?: number;
}> {
  const { data, error } = await supabase.rpc("join_room_with_password", {
    p_room_id: roomId,
    p_password: password,
  });
  if (error) return { ok: false, code: error.message };
  const result = data as {
    ok: boolean;
    code: string;
    attempts_remaining?: number;
    retry_after_seconds?: number;
  };
  return {
    ok:                 result.ok,
    code:               result.code,
    attemptsRemaining:  result.attempts_remaining,
    retryAfterSeconds:  result.retry_after_seconds,
  };
}

/**
 * hasJoinedRoom: A2 预置版 — 调用 has_joined_room_secure（服务端）
 * 用于免重复密码判断，换设备/刷新仍有效（依赖数据库记录）
 */
export async function hasJoinedRoom(roomId: string, _userId?: string): Promise<boolean> {
  const { data, error } = await supabase.rpc("has_joined_room_secure", { p_room_id: roomId });
  if (error) return false;
  return data === true;
}

export async function leaveRoom(roomId: string, userId: string): Promise<void> {
  await supabase
    .from("room_members")
    .update({ left_at: new Date().toISOString() })
    .eq("room_id", roomId)
    .eq("user_id", userId);
}

export async function fetchRoomMembers(roomId: string): Promise<RoomMember[]> {
  const { data } = await supabase
    .from("room_members")
    .select("*, profile:profiles!room_members_user_id_fkey(id,username,nickname,avatar_url)")
    .eq("room_id", roomId)
    .is("left_at", null)
    .order("joined_at", { ascending: true })
    .limit(100);
  return Array.isArray(data) ? data : [];
}

// ===== 字幕 =====
export async function insertSubtitle(
  roomId: string,
  contentCn: string,
  contentEn?: string,
  audioUrl?: string,
  chineseAudioUrl?: string
): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from("subtitles")
    .insert({
      room_id: roomId,
      content_cn: contentCn,
      content_en: contentEn ?? null,
      audio_url: audioUrl ?? '',
      chinese_audio_url: chineseAudioUrl ?? '',
    });
  return { error: error?.message ?? null };
}

export async function fetchSubtitles(roomId: string, limit = 50): Promise<Subtitle[]> {
  const { data } = await supabase
    .from("subtitles")
    .select("*")
    .eq("room_id", roomId)
    .order("created_at", { ascending: false })
    .limit(limit);
  const remote = Array.isArray(data) ? data : [];
  const merged = [...remote, ...readLocalSubtitles(roomId)];
  return Array.from(new Map(merged.map(item => [item.id, item])).values())
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(-limit);
}

// ===== 历史房间（游客/摄影师） =====
export async function fetchMyJoinedRooms(_userId?: string): Promise<Room[]> {
  const { data, error } = await supabase.rpc("get_my_joined_rooms_secure");
  if (error || !data) return [];
  const arr = Array.isArray(data) ? data : (data as unknown[]);
  return arr.filter((r): r is Room => r !== null && typeof r === "object");
}

// ===== 提问 =====
export async function sendQuestion(roomId: string, userId: string, content: string): Promise<{ error: string | null }> {
  const originalLanguage = /[\u3400-\u9fff]/.test(content) ? 'zh' : 'en';
  const translatedText = await translateText(
    content,
    originalLanguage === 'zh' ? 'zh' : 'en',
    originalLanguage === 'zh' ? 'en' : 'zh'
  ).catch(() => '');
  const { error } = await supabase
    .from("questions")
    .insert({
      room_id: roomId,
      user_id: userId,
      content,
      original_language: originalLanguage,
      translated_text: translatedText || null,
    });
  return { error: error?.message ?? null };
}

export async function fetchQuestions(roomId: string): Promise<Question[]> {
  const { data } = await supabase
    .from("questions")
    .select("*, profile:profiles!questions_user_id_fkey(id,username,nickname)")
    .eq("room_id", roomId)
    .order("created_at", { ascending: false })
    .limit(50);
  return Array.isArray(data) ? data : [];
}

// ===== 弹幕 =====
/** 发送弹幕（live 状态房间，成员身份），过滤空白，限 30 字 */
export async function sendBarrage(roomId: string, content: string): Promise<{ error: string | null }> {
  const trimmed = content.trim().slice(0, 30);
  if (!trimmed) return { error: '弹幕内容不能为空' };
  const { error } = await supabase
    .from("room_barrages")
    .insert({ room_id: roomId, content: trimmed });
  return { error: error?.message ?? null };
}

export async function fetchBarrages(roomId: string, limit = 50): Promise<Barrage[]> {
  const { data } = await supabase
    .from("room_barrages")
    .select("*, profile:profiles!room_barrages_user_id_fkey(id,username,nickname)")
    .eq("room_id", roomId)
    .order("created_at", { ascending: false })
    .limit(limit);
  return Array.isArray(data) ? (data as Barrage[]) : [];
}

// ===== currentRoom 恢复 =====
/**
 * 按 auth.uid() 恢复最近有效房间（安全版 RPC，不含 password）
 * 优先 pending/live，其次允许最近 ended（以支持只读历史查看）
 * left_at IS NULL，排序 status优先级 + joined_at DESC
 */
export async function restoreCurrentRoom(): Promise<Room | null> {
  const { data, error } = await supabase.rpc("restore_current_room_secure");
  if (error || !data) return null;
  return data as Room;
}
