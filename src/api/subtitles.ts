/**
 * subtitles.ts — 字幕安全读取层（A3-3）
 *
 * fetchSubtitlesSafe()：先通过 RPC get_room_subtitles() 校验房间访问权限，
 *   再读取最近一页字幕。RPC 当前按升序 LIMIT，会在超过 limit 后返回最旧数据，
 *   因此客户端在鉴权成功后用 created_at DESC 获取真正的最新一页。
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
  const normalizedLimit = Math.min(Math.max(limit, 1), 100);
  // 先调用 SECURITY DEFINER RPC 做参与者鉴权；无权访问时不会继续直查表。
  const { error: authError } = await supabase.rpc("get_room_subtitles", {
    p_room_id: roomId,
    p_limit: 1,
    p_before: before ?? null,
  });
  if (authError) return [];

  let query = supabase
    .from("subtitles")
    .select("*")
    .eq("room_id", roomId)
    .order("created_at", { ascending: false })
    .limit(normalizedLimit);
  if (before) query = query.lt("created_at", before);

  const { data, error } = await query;
  if (error) return [];
  const remote: Subtitle[] = Array.isArray(data) ? (data as Subtitle[]) : [];
  // 合并本地未落库字幕（语音识别中间态，不影响安全性）
  const local = readLocalSubtitles(roomId).filter(
    subtitle => !before || new Date(subtitle.created_at).getTime() < new Date(before).getTime(),
  );
  const merged = [...remote, ...local];
  return Array.from(new Map(merged.map(s => [s.id, s])).values())
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(-normalizedLimit);
}

/**
 * 导游控制台专用读取：先确认房间归属，再直接读取最新字幕。
 * 用作 get_room_subtitles RPC 暂时不可用时的安全回退，不对游客端开放。
 */
export async function fetchGuideSubtitles(
  roomId: string,
  guideId: string,
  limit = 100,
  before?: string,
): Promise<Subtitle[]> {
  const normalizedLimit = Math.min(Math.max(limit, 1), 100);
  const { data: ownedRoom, error: roomError } = await supabase
    .from("rooms")
    .select("id")
    .eq("id", roomId)
    .eq("guide_id", guideId)
    .maybeSingle();
  if (roomError || !ownedRoom) return [];

  let query = supabase
    .from("subtitles")
    .select("*")
    .eq("room_id", roomId)
    .order("created_at", { ascending: false })
    .limit(normalizedLimit);
  if (before) query = query.lt("created_at", before);
  const { data, error } = await query;
  if (error || !data) return [];
  return (data as Subtitle[])
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
}

/**
 * 读取一个房间的全部字幕。数据库接口单页最多 100 条，因此使用 created_at
 * 游标逐页读取；导游在 RPC 暂时不可用时，可通过房间归属校验安全回退。
 */
export async function fetchAllSubtitles(
  roomId: string,
  guideId?: string,
): Promise<Subtitle[]> {
  const collected = new Map<string, Subtitle>();
  let before: string | undefined;

  for (let page = 0; page < 100; page += 1) {
    let rows = await fetchSubtitlesSafe(roomId, 100, before);
    if (rows.length === 0 && guideId) {
      rows = await fetchGuideSubtitles(roomId, guideId, 100, before);
    }
    if (rows.length === 0) break;

    rows.forEach(row => collected.set(row.id, row));
    const oldest = [...rows].sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
    )[0];
    if (!oldest || oldest.created_at === before || rows.length < 100) break;
    before = oldest.created_at;
  }

  return [...collected.values()].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
}

/**
 * 严格读取全部字幕：任何鉴权或网络错误都会抛出，不会伪装成“0 条字幕”。
 * 导游在 RPC 暂不可用时仍会先验证房间归属，再使用表查询回退。
 */
export async function fetchAllSubtitlesStrict(
  roomId: string,
  guideId?: string,
): Promise<Subtitle[]> {
  const collected = new Map<string, Subtitle>();
  let before: string | undefined;

  for (let page = 0; page < 100; page += 1) {
    const normalizedLimit = 100;
    const { error: accessError } = await supabase.rpc("get_room_subtitles", {
      p_room_id: roomId,
      p_limit: 1,
      p_before: before ?? null,
    });

    if (accessError) {
      if (!guideId) throw new Error(accessError.message || "没有权限读取该房间字幕");
      const { data: ownedRoom, error: ownerError } = await supabase
        .from("rooms")
        .select("id")
        .eq("id", roomId)
        .eq("guide_id", guideId)
        .maybeSingle();
      if (ownerError) throw new Error(ownerError.message || "房间归属校验失败");
      if (!ownedRoom) throw new Error("没有权限读取该房间字幕");
    }

    let query = supabase
      .from("subtitles")
      .select("*")
      .eq("room_id", roomId)
      .order("created_at", { ascending: false })
      .limit(normalizedLimit);
    if (before) query = query.lt("created_at", before);
    const { data, error } = await query;
    if (error) throw new Error(error.message || "字幕读取失败");

    const remote = Array.isArray(data) ? data as Subtitle[] : [];
    const local = readLocalSubtitles(roomId).filter(
      subtitle => !before || new Date(subtitle.created_at).getTime() < new Date(before).getTime(),
    );
    const rows = Array.from(new Map([...remote, ...local].map(row => [row.id, row])).values())
      .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

    rows.forEach(row => collected.set(row.id, row));
    const oldest = rows[0];
    if (!oldest || oldest.created_at === before || remote.length < normalizedLimit) break;
    before = oldest.created_at;
  }

  return [...collected.values()].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );
}
