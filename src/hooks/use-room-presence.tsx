/**
 * use-room-presence.tsx — 房间 Presence Context
 *
 * 设计目标：
 *   - 纯 Presence channel（room-presence-{roomId}），不附加 postgres_changes，
 *     避免额外数据库复制连接；
 *   - 游客进入实际收听页且房间授权有效后 track({ user_id, role: 'tourist' })；
 *   - 导游可订阅但不计入游客人数（role 过滤）；
 *   - 按 user_id 去重，同一游客多标签页/多设备只计 1 人；
 *   - effect cleanup 中 untrack + removeChannel，确保每个房间实例只创建一次；
 *   - 游客主动退出先 untrack，再执行 leaveRoom 更新 left_at；
 *   - 断网/关闭由 Presence 自动 leave，不依赖 beforeunload。
 *
 * track 竞态修复（v375）：
 *   - 新增 wantsTracked ref 记录"调用意图"；
 *   - trackPresence() 只写意图；仅在 channel SUBSCRIBED 时真正 ch.track()；
 *   - SUBSCRIBED 回调（首次 + 重连）检查 wantsTracked，若有意图则补 track；
 *   - track 失败保留 wantsTracked=true，下次 SUBSCRIBED 重试；
 *   - untrackPresence() 先清意图，再 untrack，防止退出后被补 track；
 *   - cleanup 同样清意图、untrack、removeChannel；
 *   - 不用定时轮询。
 */
import {
  createContext, useContext, useRef, useState, useCallback,
  useEffect, type ReactNode,
} from 'react';
import { supabase } from '@/db/supabase';

// ─── Presence payload ────────────────────────────────────────────
export interface PresencePayload {
  user_id: string;
  role: 'tourist' | 'guide' | 'photographer';
}

// ─── Context 对外接口 ─────────────────────────────────────────────
export interface RoomPresenceContextValue {
  /** 当前在线的非导游成员 user_id 集合（游客 + 摄影师，已去重） */
  onlineParticipantIds: Set<string>;
  /** 当前在线非导游成员人数 */
  participantCount: number;
  /** 当前在线的 tourist user_id 集合（已去重） */
  onlineTouristIds: Set<string>;
  /** 当前在线 tourist 人数（去重后） */
  touristCount: number;
  /** 游客侧调用：记录追踪意图；channel 已 SUBSCRIBED 则立即 track，否则等待 SUBSCRIBED 补 track */
  trackPresence: () => void;
  /** 游客侧调用：先清意图，再 untrack（退出房间前调用，先于 leaveRoom） */
  untrackPresence: () => Promise<void>;
}

const RoomPresenceContext = createContext<RoomPresenceContextValue | null>(null);

export function useRoomPresence(): RoomPresenceContextValue {
  const ctx = useContext(RoomPresenceContext);
  if (!ctx) {
    // 安全降级：Provider 未挂载时（HMR 重载中间态、单元测试、导游直接渲染等）
    // 返回零值而不是 throw，避免白屏崩溃
    return {
      onlineParticipantIds: new Set(),
      participantCount: 0,
      onlineTouristIds: new Set(),
      touristCount: 0,
      trackPresence: () => {},
      untrackPresence: async () => {},
    };
  }
  return ctx;
}

// ─── Provider ────────────────────────────────────────────────────
interface ProviderProps {
  children: ReactNode;
  roomId: string;
  userId: string;
  /** 当前用户角色；只有 tourist 才会 track，guide 仅订阅 */
  role: 'tourist' | 'guide' | 'photographer';
}

export function RoomPresenceProvider({ children, roomId, userId, role }: ProviderProps) {
  const [onlineParticipantIds, setOnlineParticipantIds] = useState<Set<string>>(new Set());
  const [onlineTouristIds, setOnlineTouristIds] = useState<Set<string>>(new Set());

  // channel ref — 确保每个 Provider 实例只创建一次
  const channelRef    = useRef<ReturnType<typeof supabase.channel> | null>(null);
  // trackedRef：ch.track() 已成功，服务端有记录
  const trackedRef    = useRef(false);
  // wantsTracked：游客已调用 trackPresence()，但可能尚未 SUBSCRIBED；清意图后不再补 track
  const wantsTracked  = useRef(false);
  // subscribedRef：当前 channel 已进入 SUBSCRIBED 状态
  const subscribedRef = useRef(false);

  // ── 解析 Presence state → 游客 user_id 去重集合 ───────────────
  const syncState = useCallback((presenceState: Record<string, PresencePayload[]>) => {
    const participantIds = new Set<string>();
    const touristIds = new Set<string>();
    Object.values(presenceState).forEach(presences => {
      presences.forEach(p => {
        if (p.role !== 'guide' && p.user_id) participantIds.add(p.user_id);
        if (p.role === 'tourist' && p.user_id) touristIds.add(p.user_id);
      });
    });
    setOnlineParticipantIds(participantIds);
    setOnlineTouristIds(touristIds);
  }, []);

  // ── 内部：真正执行 ch.track()（仅供 SUBSCRIBED 回调和 trackPresence 调用）──
  const doTrack = useCallback((ch: ReturnType<typeof supabase.channel>) => {
    ch.track({ user_id: userId, role } satisfies PresencePayload)
      .then(() => {
        trackedRef.current = true;
        console.log('[Presence] track 成功');
      })
      .catch(err => {
        // 失败保留 wantsTracked=true，下次 SUBSCRIBED 重试
        console.warn('[Presence] track 失败，将在重连后重试:', err);
      });
  }, [userId, role]);

  // ── 挂载时创建 channel，离开时清理 ───────────────────────────
  useEffect(() => {
    if (!roomId || !userId) return;

    // 新 channel 重置所有状态
    trackedRef.current    = false;
    subscribedRef.current = false;
    // 注意：wantsTracked 不在此重置——换房间时意图由上层重新 track；
    // 但 roomId 变化说明是换房间，意图对新房间无效，清除
    wantsTracked.current  = false;

    const ch = supabase.channel(`room-presence-${roomId}`, {
      config: { presence: { key: userId } },
    });

    ch.on('presence', { event: 'sync' }, () => {
      syncState(ch.presenceState<PresencePayload>());
    });

    ch.subscribe(status => {
      if (status === 'SUBSCRIBED') {
        subscribedRef.current = true;
        // 同步初始状态
        syncState(ch.presenceState<PresencePayload>());
        // 补 track：首次订阅或重连后，若游客已表达意图但尚未 track，立即补上
        if (wantsTracked.current && !trackedRef.current) {
          doTrack(ch);
        }
      } else {
        // channel 断开/重连中：重置 subscribed 和 tracked 状态
        // wantsTracked 保持不变，重连后 SUBSCRIBED 回调会再次补 track
        subscribedRef.current = false;
        trackedRef.current    = false;
      }
    });

    channelRef.current = ch;

    return () => {
      // cleanup：先清意图，再 untrack（静默失败），再 removeChannel
      wantsTracked.current  = false;
      subscribedRef.current = false;
      const cleanup = async () => {
        if (trackedRef.current) {
          try { await ch.untrack(); } catch { /* 忽略断线错误 */ }
          trackedRef.current = false;
        }
        await supabase.removeChannel(ch);
      };
      cleanup();
    };
    // roomId / userId 变化时重建（换房间或重新登录）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, userId]);

  // ── 游客/摄影师进入房间业务页后调用：记录意图 ──
  const trackPresence = useCallback(() => {
    if (role === 'guide') return;     // 导游不计入成员在线人数
    if (wantsTracked.current) return; // 已记录意图，防重入
    wantsTracked.current = true;

    // channel 已 SUBSCRIBED 且未 track：立即执行
    if (subscribedRef.current && !trackedRef.current) {
      const ch = channelRef.current;
      if (ch) doTrack(ch);
    }
    // 否则：等 SUBSCRIBED 回调触发补 track（竞态安全）
  }, [role, doTrack]);

  // ── 游客退出房间前调用 untrack（先于 leaveRoom/left_at）───────
  const untrackPresence = useCallback(async () => {
    // 先清意图，防止 SUBSCRIBED 回调补 track
    wantsTracked.current = false;

    if (!trackedRef.current) return;
    const ch = channelRef.current;
    if (!ch) return;
    try { await ch.untrack(); } catch { /* 忽略断线错误 */ }
    trackedRef.current = false;
  }, []);

  const touristCount = onlineTouristIds.size;
  const participantCount = onlineParticipantIds.size;

  return (
    <RoomPresenceContext.Provider value={{
      onlineParticipantIds, participantCount,
      onlineTouristIds, touristCount, trackPresence, untrackPresence,
    }}>
      {children}
    </RoomPresenceContext.Provider>
  );
}
