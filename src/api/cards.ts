import { supabase } from "@/db/supabase";
import type { Card, CardPush, RoomCard, KnowledgeCard } from "@/types/types";

// ================================================================
// 旧 cards 表接口（兼容保留，不在新流程中使用）
// ================================================================
export async function fetchCards(category?: string): Promise<Card[]> {
  let query = supabase
    .from("cards")
    .select("*")
    .order("created_at", { ascending: false })
    .limit(100);
  if (category && category !== "全部") {
    query = query.eq("category", category);
  }
  const { data } = await query;
  return Array.isArray(data) ? data : [];
}

/** 旧流程兼容：按旧 cards.id 查卡片（游客端旧推送降级使用） */
export async function fetchCardById(cardId: string): Promise<Card | null> {
  const { data } = await supabase
    .from("cards")
    .select("*")
    .eq("id", cardId)
    .maybeSingle();
  return data;
}

export async function createCard(card: Omit<Card, "id" | "created_at"> & { created_by: string }): Promise<{ card: Card | null; error: string | null }> {
  const { data, error } = await supabase
    .from("cards")
    .insert(card)
    .select()
    .maybeSingle();
  return { card: data, error: error?.message ?? null };
}

/** 旧流程推送（已废弃，新流程用 pushKcCard） */
export async function pushCard(roomId: string, cardId: string, pushedBy: string): Promise<{ push: CardPush | null; error: string | null }> {
  const { data, error } = await supabase
    .from("card_pushes")
    .insert({ room_id: roomId, card_id: cardId, pushed_by: pushedBy })
    .select()
    .maybeSingle();
  return { push: data, error: error?.message ?? null };
}

export async function fetchCardPushesForRoom(roomId: string): Promise<CardPush[]> {
  const { data } = await supabase
    .from("card_pushes")
    .select("*, card:cards(*)")
    .eq("room_id", roomId)
    .order("pushed_at", { ascending: false })
    .limit(50);
  return Array.isArray(data) ? data : [];
}

// ================================================================
// 旧中间层：room_cards（保留只读，不再新建记录）
// ================================================================

const ROOM_CARD_SELECT = "*, knowledge_card:knowledge_cards(*)";

/** 加载当前房间已导入的卡片关联列表（旧中间层，只读兼容） */
export async function fetchRoomCards(roomId: string): Promise<RoomCard[]> {
  const { data } = await supabase
    .from("room_cards")
    .select(ROOM_CARD_SELECT)
    .eq("room_id", roomId)
    .order("imported_at", { ascending: false });
  return Array.isArray(data) ? data : [];
}

/** 按 id 查单条 room_cards 关联（旧中间层兼容） */
export async function fetchRoomCardById(roomCardId: string): Promise<RoomCard | null> {
  const { data } = await supabase
    .from("room_cards")
    .select(ROOM_CARD_SELECT)
    .eq("id", roomCardId)
    .maybeSingle();
  return data;
}

/** 已导入的 source_card_id 集合（旧中间层，只读兼容） */
export async function fetchImportedSourceIds(roomId: string): Promise<Set<string>> {
  const { data } = await supabase
    .from("room_cards")
    .select("source_card_id")
    .eq("room_id", roomId);
  return new Set((data ?? []).map((r: { source_card_id: string | null }) => r.source_card_id ?? "").filter(Boolean));
}

/** 旧中间层推送（已废弃，新流程用 pushKcCard） */
export async function pushRoomCard(
  roomId: string,
  roomCardId: string,
  pushedBy: string
): Promise<{ push: CardPush | null; error: string | null }> {
  const { data, error } = await supabase
    .from("card_pushes")
    .insert({ room_id: roomId, room_card_id: roomCardId, pushed_by: pushedBy })
    .select()
    .maybeSingle();
  return { push: data, error: error?.message ?? null };
}

/** 旧流程兼容：查旧推送数 */
export async function fetchRoomPushCount(roomId: string): Promise<number> {
  const { count } = await supabase
    .from("card_pushes")
    .select("id", { count: "exact", head: true })
    .eq("room_id", roomId)
    .not("room_card_id", "is", null);
  return count ?? 0;
}

/** 旧流程兼容：查最近推送的 room_cards（游客补查降级） */
export async function fetchRecentPushedRoomCards(roomId: string, limit = 10): Promise<RoomCard[]> {
  const { data } = await supabase
    .from("card_pushes")
    .select("room_card:room_cards(*, knowledge_card:knowledge_cards(*))")
    .eq("room_id", roomId)
    .not("room_card_id", "is", null)
    .order("pushed_at", { ascending: false })
    .limit(limit);
  if (!Array.isArray(data)) return [];
  return (data as Array<{ room_card: RoomCard | RoomCard[] | null }>)
    .map(p => Array.isArray(p.room_card) ? p.room_card[0] ?? null : p.room_card)
    .filter((c): c is RoomCard => c !== null);
}

// ================================================================
// Task2 新流程：KC 直接推送（knowledge_cards 单一数据源）
// ================================================================

const PAGE_SIZE = 6;

export interface FetchKcPageResult {
  cards: KnowledgeCard[];
  total: number;
}

/**
 * 分页查询 KC 卡片（仅返回未软删除 + 已发布），后端 range 分页
 * pageIndex 从 0 开始
 */
export async function fetchKcPage(
  pageIndex: number,
  category?: string,
  search?: string
): Promise<FetchKcPageResult> {
  const from = pageIndex * PAGE_SIZE;
  const to = from + PAGE_SIZE - 1;

  let query = supabase
    .from("knowledge_cards")
    .select("*", { count: "exact" })
    .eq("status", "published")
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .range(from, to);

  if (category && category !== "全部") query = query.eq("category", category);
  if (search) query = query.ilike("title_cn", `%${search}%`);

  const { data, count, error } = await query;
  if (error) return { cards: [], total: 0 };
  return { cards: (data ?? []) as KnowledgeCard[], total: count ?? 0 };
}

// ── 推送选择页专用分页（无限滚动，稳定排序） ──────────────────────────────
const PUSH_PAGE_SIZE = 10;

async function deterministicPushId(roomId: string, kcCardId: string): Promise<string> {
  const input = new TextEncoder().encode(`${roomId}:${kcCardId}`);
  let bytes: Uint8Array;
  if (globalThis.crypto?.subtle) {
    bytes = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input)).slice(0, 16);
  } else {
    // 非安全上下文兼容：四组 FNV-1a 生成稳定 128 bit；数据库触发器仍是最终防线。
    const out = new Uint8Array(16);
    for (let block = 0; block < 4; block += 1) {
      let hash = (0x811c9dc5 ^ (block * 0x9e3779b9)) >>> 0;
      for (const value of input) {
        hash ^= value;
        hash = Math.imul(hash, 0x01000193) >>> 0;
      }
      new DataView(out.buffer).setUint32(block * 4, hash);
    }
    bytes = out;
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map(value => value.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface FetchKcForPushResult {
  cards: KnowledgeCard[];
  /** 本批实际返回数量 < PUSH_PAGE_SIZE 代表已到末尾 */
  hasMore: boolean;
}

/**
 * 推送选择页分页查询（导游端 CardLibrary 专用）。
 * - 仅返回 status='published' 且 deleted_at IS NULL 的 KC。
 * - 排序：created_at ASC + id ASC 保证跨页稳定（created_at 相同时 id 决定顺序）。
 * - 游标分页：cursor 为上一页最后一条的 created_at；同 created_at 时再用 afterId 排除已取。
 * - 不联查 card_pushes（已推送判断由调用方维护，避免权限边界问题）。
 */
export async function fetchKcPageForPush(
  ownerId: string,
  cursor?: { createdAt: string; id: string },
  category?: string,
  search?: string,
): Promise<FetchKcForPushResult> {
  let query = supabase
    .from("knowledge_cards")
    .select("*")
    .eq("created_by", ownerId)
    .eq("status", "published")
    .is("deleted_at", null)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(PUSH_PAGE_SIZE);

  // 游标过滤：(created_at, id) > (cursor.createdAt, cursor.id)
  if (cursor) {
    query = query.or(
      `created_at.gt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`
    );
  }
  if (category && category !== "全部") query = query.eq("category", category);
  if (search) query = query.ilike("title_cn", `%${search}%`);

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  const cards = (data ?? []) as KnowledgeCard[];
  return { cards, hasMore: cards.length === PUSH_PAGE_SIZE };
}

/** KC 软删除：写入 deleted_at，不物理 DELETE */
export async function softDeleteKc(kcId: string): Promise<{ error: string | null }> {
  const { error } = await supabase
    .from("knowledge_cards")
    .update({ deleted_at: new Date().toISOString() })
    .eq("id", kcId);
  return { error: error?.message ?? null };
}

/**
 * Task2 推送：直接按 kc_card_id 写 card_pushes
 * sequence 由数据库触发器（trg_card_push_sequence）自动计算，客户端不写
 * 不再经过 room_cards 中间层，不写内容副本
 */
export async function pushKcCard(
  roomId: string,
  kcCardId: string,
  pushedBy: string
): Promise<{ push: CardPush | null; error: string | null }> {
  const { data: ownedCard, error: ownerError } = await supabase
    .from("knowledge_cards")
    .select("id")
    .eq("id", kcCardId)
    .eq("created_by", pushedBy)
    .is("deleted_at", null)
    .maybeSingle();
  if (ownerError) return { push: null, error: ownerError.message };
  if (!ownedCard) return { push: null, error: "只能推送当前导游本人创建且未下架的卡片" };

  const { data: previousPush, error: previousError } = await supabase
    .from("card_pushes")
    .select("*")
    .eq("room_id", roomId)
    .eq("kc_card_id", kcCardId)
    .order("pushed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (previousError) return { push: null, error: previousError.message };
  if (previousPush) return { push: previousPush, error: null };

  const pushId = await deterministicPushId(roomId, kcCardId);
  const { data, error } = await supabase
    .from("card_pushes")
    .insert({
      id: pushId,
      room_id: roomId,
      kc_card_id: kcCardId,
      pushed_by: pushedBy,
      // sequence 由 BEFORE INSERT 触发器自动写入，card_id/room_card_id 为 null
    })
    .select()
    .maybeSingle();
  if (error && error.code !== "23505") return { push: null, error: error.message };
  if (data) return { push: data, error: null };

  // 数据库幂等触发器会忽略同一房间的重复推送；返回既有记录作为成功结果。
  const { data: existing, error: existingError } = await supabase
    .from("card_pushes")
    .select("*")
    .eq("room_id", roomId)
    .eq("kc_card_id", kcCardId)
    .order("pushed_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return { push: existing, error: existingError?.message ?? null };
}

/**
 * 游客端：按 kc_card_id + room_id 精确查 KC（通过 SECURITY DEFINER RPC）
 * 确保游客只能读取已推送到其房间的卡片
 */
export async function fetchKcByPush(
  roomId: string,
  kcCardId: string
): Promise<KnowledgeCard | null> {
  const { data } = await supabase
    .rpc("get_kc_by_push", { p_room_id: roomId, p_kc_card_id: kcCardId });
  return (data as KnowledgeCard | null) ?? null;
}

/**
 * 游客补查：返回该房间最近一张已推送 KC（SECURITY DEFINER RPC）
 * 排序：sequence DESC NULLS LAST, pushed_at DESC
 * 权限边界：RPC 内校验 auth.uid() 是该 room 的 guide 或 room_members 成员
 * 不直接 join card_pushes，绝不绕过权限边界
 */
export async function fetchLatestPushedKc(
  roomId: string
): Promise<{ kcCardId: string; kc: KnowledgeCard } | null> {
  const { data, error } = await supabase
    .rpc("get_latest_pushed_kc_for_room", { p_room_id: roomId });
  if (error || !data) return null;
  const kc = data as KnowledgeCard;
  return { kcCardId: kc.id, kc };
}

/** 游客端：读取当前房间已推送的全部 KC，按最新推送在前展示。
 * 卡片正文仍逐条走 get_kc_by_push RPC，确保只能读取本房间已推送内容。 */
export async function fetchPushedKcsForRoom(
  roomId: string,
  limit = 50,
): Promise<Array<{ kcCardId: string; pushedAt: string; kc: KnowledgeCard }>> {
  const { data, error } = await supabase
    .from("card_pushes")
    .select("kc_card_id,pushed_at")
    .eq("room_id", roomId)
    .not("kc_card_id", "is", null)
    .order("pushed_at", { ascending: false })
    .limit(limit);
  if (error) throw new Error(error.message);

  const rows = (data ?? []) as Array<{ kc_card_id: string | null; pushed_at: string }>;
  const uniqueRows = rows.filter(
    (row, index, all) =>
      Boolean(row.kc_card_id)
      && all.findIndex(candidate => candidate.kc_card_id === row.kc_card_id) === index,
  );
  const cards = await Promise.all(
    uniqueRows.map(async row => {
      const kc = await fetchKcByPush(roomId, row.kc_card_id!);
      return kc ? { kcCardId: row.kc_card_id!, pushedAt: row.pushed_at, kc } : null;
    }),
  );
  return cards.filter(
    (item): item is { kcCardId: string; pushedAt: string; kc: KnowledgeCard } => item !== null,
  );
}

/**
 * 查询房间最近推送的 KC 卡片（含完整内容，游客初始化/补查用）
 * @deprecated 请使用 fetchLatestPushedKc，此函数直接 join 绕过权限边界，已废弃
 * 保留签名供旧调用兼容，内部改走 RPC
 */
export async function fetchRecentPushedKc(
  roomId: string,
  _limit = 1
): Promise<Array<{ pushId: string; kcCardId: string; pushedAt: string; kc: KnowledgeCard }>> {
  const result = await fetchLatestPushedKc(roomId);
  if (!result) return [];
  return [{
    pushId: "",       // RPC 不返回 push.id，保持接口兼容
    kcCardId: result.kcCardId,
    pushedAt: result.kc.created_at, // 近似值，排序由 RPC 保证
    kc: result.kc,
  }];
}

/** 查询导游当前房间已推送过的 kc_card_id 集合（用于去重标记）
 *  失败时静默降级返回空 Set，不中断卡片加载链 */
export async function fetchPushedKcIds(roomId: string): Promise<Set<string>> {
  const { data, error } = await supabase
    .from("card_pushes")
    .select("kc_card_id")
    .eq("room_id", roomId)
    .not("kc_card_id", "is", null);
  if (error) {
    console.warn('[CardLibrary] fetchPushedKcIds 失败，降级使用空 Set:', error.message);
    return new Set();
  }
  return new Set(
    (data ?? []).map((r: { kc_card_id: string | null }) => r.kc_card_id ?? "").filter(Boolean)
  );
}

/** 旧中间层：将 KC 导入 room_cards（仅导游素材库管理，新推送流程不再需要此步骤） */
export async function importKcToRoom(
  roomId: string,
  kc: { id: string },
  importedBy: string
): Promise<{ roomCard: RoomCard | null; error: string | null }> {
  const { data, error } = await supabase
    .from("room_cards")
    .insert({ room_id: roomId, source_card_id: kc.id, imported_by: importedBy })
    .select(ROOM_CARD_SELECT)
    .maybeSingle();
  if (error) {
    const msg = error.code === "23505" ? "该卡片已导入当前房间" : error.message;
    return { roomCard: null, error: msg };
  }
  return { roomCard: data, error: null };
}
