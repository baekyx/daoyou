/**
 * subtitles.ts — 字幕安全读取层（A3-3）
 *
 * fetchSubtitlesSafe()：通过 RPC get_room_subtitles() 读取，
 *   仅限该房导游或有效 room_members，支持分页（limit 1-100，游标 before）。
 *
 * Realtime 兼容说明（Cutover 待办）：
 *   subscribeSubtitles() 仍依赖 voiceApi.ts 中的 Supabase Realtime channel，
 *   该订阅使用旧 subtitles SELECT policy（任何已登录可查看），
 *   本轮不贸然关闭，待 A3-4 收紧 policy 后统一迁移。
 *   行动项：A3-4 将 subtitles SELECT 改为房间成员限制后，Realtime 过滤
 *   已有 filter: `room_id=eq.${roomId}`，可直接收益。
 *
 * 字幕写入（insertSubtitle）继续使用 roomActivity.ts，本轮不改。
 */
import { supabase } from "@/db/supabase";
import type { Subtitle } from "@/types/types";
import { readLocalSubtitles } from "@/lib/voiceApi";

/**
 * 安全读取房间字幕（通过 SECURITY DEFINER RPC）
 * @param roomId  房间 ID
 * @param limit   条数上限 1-100，默认 50
 * @param before  游标：只返回此时间戳之前的记录（可选，用于分页）
 */
export async function fetchSubtitlesSafe(
  roomId: string,
  limit = 50,
  before?: string
): Promise<Subtitle[]> {
  const { data, error } = await supabase.rpc("get_room_subtitles", {
    p_room_id: roomId,
    p_limit: Math.min(Math.max(limit, 1), 100),
    p_before: before ?? null,
  });
  if (error || !data) return [];
  const remote: Subtitle[] = Array.isArray(data) ? (data as Subtitle[]) : [];
  // 合并本地未落库字幕（语音识别中间态，不影响安全性）
  const local = readLocalSubtitles(roomId);
  const merged = [...remote, ...local];
  return Array.from(new Map(merged.map(s => [s.id, s])).values())
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(-limit);
}
