/**
 * use-room-rtc.tsx — 房间级 WebRTC 宿主 Context
 *
 * 设计目标：
 *   - 游客在同一房间内切换子页面（字幕/相册/提问）时，WebRTC 连接、信令 channel
 *     和 <audio> 元素不销毁；
 *   - 只有真正离开房间（go('room-list')、退出、换房）时才 cleanup；
 *   - 音频元素由 React ref 管理，纳入组件生命周期，不散落到 document.body；
 *   - 游客必须通过真实点击手势调用 playAudio()，不使用 muted hack；
 *   - Presence（room-presence-{roomId}）在本层统一挂载，暴露 touristCount / onlineTouristIds；
 *     游客进入收听页后调用 trackPresence()，退出前调用 untrackPresence()。
 */
import {
  createContext, useContext, useRef, useState, useCallback,
  useEffect, type ReactNode, type RefObject,
} from 'react';
import { useWebRTC } from '@/hooks/use-webrtc';
import type { RtcConnState, RtcStatusInfo } from '@/hooks/use-webrtc';
import { useBaiduRtc } from '@/hooks/use-baidu-rtc';
import { useAuth } from '@/contexts/AuthContext';
import { isBaiduRtcConfigured, isTurnConfigured, isRelayForced } from '@/lib/rtcConfig';
import { RoomPresenceProvider, useRoomPresence } from '@/hooks/use-room-presence';
export { useRoomPresence };

// ─── 向游客页面暴露的收听状态 ─────────────────────────────────
export type AudioPlayState = 'idle' | 'playing' | 'blocked';
type ActiveTransport = 'none' | 'baidu' | 'direct';

export interface RoomRtcContextValue {
  /** WebRTC 连接状态 */
  connState: RtcConnState;
  /** 实际 ICE 候选类型（host / srflx / relay / unknown） */
  candidateKind: string;
  /** TURN 是否已配置 */
  turnConfigured: boolean;
  /** 是否强制 relay 模式 */
  relayForced: boolean;
  /** 导游麦克风状态（信令 mic-on/off） */
  guideMicOn: boolean;
  /** 游客端音频播放状态 */
  audioPlayState: AudioPlayState;
  /** 外部 <audio> ref，绑定到 JSX */
  audioRef: RefObject<HTMLAudioElement | null>;
  /** 用户手势触发：开启/恢复收听（等 srcObject 就绪后调用 play()） */
  playAudio: () => Promise<void>;
  /** 按语言模式暂停/恢复中文实时原声，不断开 RTC 连接 */
  setChineseAudioEnabled: (enabled: boolean) => Promise<void>;
  /** 导游端：启动推流 */
  startMic: (stream: MediaStream) => Promise<boolean>;
  /** 导游端：停止推流 */
  stopMic: () => void;
  /** 重新连接（游客侧重发 join） */
  retryConnect: () => void;
  /** 房间 cleanup（真正离开房间时调用） */
  leaveRoom: () => void;
  // ── Presence（单一来源，游客人数） ──────────────────────────
  /** 开始追踪自身 Presence（进入收听页后调用） */
  trackPresence: () => void;
  /** 停止追踪自身 Presence（退出房间前先调用，再调用 leaveRoom） */
  untrackPresence: () => Promise<void>;
}

const RoomRtcContext = createContext<RoomRtcContextValue | null>(null);

export function useRoomRtc(): RoomRtcContextValue {
  const ctx = useContext(RoomRtcContext);
  if (!ctx) throw new Error('useRoomRtc must be used within RoomRtcProvider');
  return ctx;
}

interface ProviderProps { children: ReactNode }

/** 内层：已在 RoomPresenceProvider 内部，可直接消费 Presence context */
function RoomRtcInner({ children }: ProviderProps) {
  const { user, currentRoom } = useAuth();
  const isOwner = false; // Provider 仅用于游客侧
  const { trackPresence, untrackPresence } = useRoomPresence();

  const [connState, setConnState] = useState<RtcConnState>('idle');
  const [candidateKind, setCandidateKind] = useState('unknown');
  const [turnConfigured] = useState(() => isTurnConfigured() || isBaiduRtcConfigured());
  const [relayForced] = useState(isRelayForced);
  const [guideMicOn, setGuideMicOn] = useState(false);
  const [audioPlayState, setAudioPlayState] = useState<AudioPlayState>('idle');
  const activeTransportRef = useRef<ActiveTransport>('none');
  const chineseAudioEnabledRef = useRef(true);
  const audioUnlockedRef = useRef(false);

  // <audio> 元素 ref：由 RoomRtcProvider render 的隐藏元素持有
  const audioRef = useRef<HTMLAudioElement | null>(null);

  // 每次 initSignaling 返回的 waitSubscribed promise（需在 reconnect 时传给 announceJoin）
  const waitSubscribedRef = useRef<Promise<void>>(Promise.resolve());
  // retrySignaling：重建 channel 订阅（用于 TIMED_OUT 指数退避）
  const retrySignalingRef = useRef<(() => Promise<void>) | undefined>(undefined);

  const handleStatusChange = useCallback((info: RtcStatusInfo) => {
    setConnState(info.connState);
    setCandidateKind(info.candidateKind);
  }, []);

  const { initSignaling, startMic, stopMic, announceJoin, announceLeave, reconnect, cleanup } =
    useWebRTC({
      roomId: currentRoom?.id ?? '',
      participantId: user?.id ?? '',
      isOwner,
      audioRef,
      onMicStateChange: setGuideMicOn,
      onStatusChange: handleStatusChange,
    });
  const baiduRtc = useBaiduRtc({
    roomId: currentRoom?.id ?? '',
    participantId: user?.id ?? '',
    role: 'tourist',
    displayName: (user as any)?.phone ?? user?.id?.slice(0, 6) ?? '游客',
    onMicStateChange: setGuideMicOn,
    onStatusChange: handleStatusChange,
    onPlaybackStateChange: isPlaying => {
      if (chineseAudioEnabledRef.current) {
        setAudioPlayState(isPlaying ? 'playing' : 'blocked');
      }
    },
  });
  const directUnsubRef = useRef<(() => void) | null>(null);

  // 记录 nickname，供 reconnect 使用
  const nicknameRef = useRef('游客');
  useEffect(() => {
    nicknameRef.current = (user as any)?.phone ?? user?.id?.slice(0, 6) ?? '游客';
  }, [user]);

  const startDirectFallback = useCallback(() => {
    activeTransportRef.current = 'direct';
    setAudioPlayState('idle');
    directUnsubRef.current?.();
    const { unsub, waitSubscribed, retrySignaling } = initSignaling();
    directUnsubRef.current = unsub;
    waitSubscribedRef.current = waitSubscribed;
    retrySignalingRef.current = retrySignaling;
    announceJoin(nicknameRef.current, waitSubscribed, retrySignaling);
  }, [announceJoin, initSignaling]);

  // 房间 ready：优先加入百度 RTC；未开通、鉴权失败或 SDK 异常时回退原直连 WebRTC。
  useEffect(() => {
    if (!currentRoom?.id || !user?.id) return;
    let cancelled = false;
    activeTransportRef.current = 'none';
    if (baiduRtc.configured) {
      void baiduRtc.startSubscriber()
        .then(() => {
          if (!cancelled) activeTransportRef.current = 'baidu';
        })
        .catch(error => {
          if (cancelled) return;
          console.warn('[Baidu RTC] 游客加入失败，回退到直连 WebRTC:', error);
          startDirectFallback();
        });
    } else {
      startDirectFallback();
    }
    return () => {
      cancelled = true;
      activeTransportRef.current = 'none';
      baiduRtc.stop();
      directUnsubRef.current?.();
      directUnsubRef.current = null;
      announceLeave();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRoom?.id, user?.id]);

  // 导游麦克风开启时：若 audio 已有 srcObject 且用户曾授权，尝试恢复播放
  useEffect(() => {
    if (!guideMicOn || !chineseAudioEnabledRef.current) return;
    const audio = audioRef.current;
    if (!audio?.srcObject) return;
    if (audioPlayState === 'playing') return;
    // 尝试自动恢复（若 play() 被 policy 拒绝则设 blocked，等用户手势）
    audio.play()
      .then(() => setAudioPlayState('playing'))
      .catch(() => setAudioPlayState('blocked'));
  }, [guideMicOn, audioPlayState]);

  /** 用户手势触发播放 */
  const playAudio = useCallback(async () => {
    audioUnlockedRef.current = true;
    if (!chineseAudioEnabledRef.current) {
      setAudioPlayState('idle');
      return;
    }
    if (activeTransportRef.current === 'baidu') {
      const didPlay = await baiduRtc.playRemoteAudio();
      setAudioPlayState(didPlay ? 'playing' : 'blocked');
      return;
    }
    const audio = audioRef.current;
    if (!audio) return;
    try {
      await audio.play();
      setAudioPlayState('playing');
    } catch {
      setAudioPlayState('blocked');
    }
  }, [baiduRtc.configured, baiduRtc.playRemoteAudio]);

  /** 切换语言模式时只暂停/恢复远端中文原声，RTC 连接继续保持。 */
  const setChineseAudioEnabled = useCallback(async (enabled: boolean) => {
    chineseAudioEnabledRef.current = enabled;
    if (!enabled) {
      if (activeTransportRef.current === 'baidu') {
        await baiduRtc.setRemoteAudioEnabled(false);
      } else {
        audioRef.current?.pause();
      }
      setAudioPlayState('idle');
      return;
    }

    if (!audioUnlockedRef.current) {
      setAudioPlayState('idle');
      return;
    }
    if (activeTransportRef.current === 'baidu') {
      const didPlay = await baiduRtc.setRemoteAudioEnabled(true);
      setAudioPlayState(didPlay ? 'playing' : 'blocked');
      return;
    }
    const audio = audioRef.current;
    if (!audio) {
      setAudioPlayState('idle');
      return;
    }
    try {
      await audio.play();
      setAudioPlayState('playing');
    } catch {
      setAudioPlayState('blocked');
    }
  }, [baiduRtc.setRemoteAudioEnabled]);

  /** 游客端重连 */
  const retryConnect = useCallback(() => {
    if (baiduRtc.configured) {
      activeTransportRef.current = 'none';
      baiduRtc.stop();
      void baiduRtc.startSubscriber()
        .then(() => {
          activeTransportRef.current = 'baidu';
        })
        .catch(error => {
          console.warn('[Baidu RTC] 重连失败，回退到直连 WebRTC:', error);
          startDirectFallback();
        });
      return;
    }
    reconnect(nicknameRef.current, waitSubscribedRef.current, retrySignalingRef.current);
  }, [baiduRtc.configured, baiduRtc.startSubscriber, baiduRtc.stop, reconnect, startDirectFallback]);

  /** 真正离开房间 */
  const leaveRoom = useCallback(() => {
    activeTransportRef.current = 'none';
    baiduRtc.stop();
    announceLeave();
    cleanup();
    setConnState('idle');
    setGuideMicOn(false);
    setAudioPlayState('idle');
  }, [announceLeave, baiduRtc.stop, cleanup]);

  return (
    <RoomRtcContext.Provider value={{
      connState, candidateKind, turnConfigured, relayForced,
      guideMicOn, audioPlayState,
      audioRef,
      playAudio, setChineseAudioEnabled, startMic, stopMic, retryConnect, leaveRoom,
      trackPresence, untrackPresence,
    }}>
      {/* 隐藏的音频元素：纳入 React 树，随 Provider unmount 自动释放 */}
      <audio
        ref={audioRef}
        style={{ display: 'none' }}
        playsInline
        aria-hidden="true"
      />
      {children}
    </RoomRtcContext.Provider>
  );
}

/**
 * RoomRtcProvider — 外层：先挂载 RoomPresenceProvider（纯 Presence channel），
 * 再在内层渲染 RoomRtcInner（WebRTC + 信令），保证 Presence 生命周期包含 WebRTC。
 * 游客侧专用，isOwner 固定为 false。
 */
export function RoomRtcProvider({ children }: ProviderProps) {
  const { user, currentRoom } = useAuth();
  return (
    <RoomPresenceProvider
      roomId={currentRoom?.id ?? ''}
      userId={user?.id ?? ''}
      role="tourist"
    >
      <RoomRtcInner>{children}</RoomRtcInner>
    </RoomPresenceProvider>
  );
}
