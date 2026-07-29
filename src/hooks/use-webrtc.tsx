import { useRef, useCallback, useEffect } from 'react';
import { supabase } from '@/db/supabase';
import { buildRtcConfig, parseCandidateKind, isTurnConfigured, isRelayForced } from '@/lib/rtcConfig';
import type { CandidateKind } from '@/lib/rtcConfig';

// ─── 公开类型 ─────────────────────────────────────────────────
export type RtcConnState = 'idle' | 'connecting' | 'connected' | 'disconnected' | 'failed';

export interface RtcStatusInfo {
  connState: RtcConnState;
  candidateKind: CandidateKind;
  turnConfigured: boolean;
  relayForced: boolean;
}

// ─── 信令消息类型 ─────────────────────────────────────────────
type SignalMessage =
  | { type: 'join'; from: string; nickname: string }
  | { type: 'leave'; from: string }
  | { type: 'offer'; sdp: RTCSessionDescriptionInit; from: string; to: string }
  | { type: 'answer'; sdp: RTCSessionDescriptionInit; from: string; to: string }
  | { type: 'ice-candidate'; candidate: RTCIceCandidateInit; from: string; to: string }
  | { type: 'mic-on'; from: string }
  | { type: 'mic-off'; from: string };

export interface UseWebRTCOptions {
  roomId: string;
  participantId: string;
  isOwner: boolean;
  /** 游客端：外部传入 <audio> ref，由调用方管理 DOM 生命周期 */
  audioRef?: React.RefObject<HTMLAudioElement | null>;
  onMicStateChange?: (isOn: boolean) => void;
  onStatusChange?: (info: RtcStatusInfo) => void;
}

export function useWebRTC({
  roomId,
  participantId,
  isOwner,
  audioRef,
  onMicStateChange,
  onStatusChange,
}: UseWebRTCOptions) {
  const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
  // 在 remoteDescription 设置之前到达的 ICE candidate 按 peerId 缓存
  const pendingCandidatesRef = useRef<Map<string, RTCIceCandidateInit[]>>(new Map());
  const pendingListenersRef = useRef<Map<string, string>>(new Map());
  const localStreamRef = useRef<MediaStream | null>(null);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);
  const isOwnerRef = useRef(isOwner);
  const participantIdRef = useRef(participantId);
  const micOnRef = useRef(false);
  const sendMessageRef = useRef<(msg: SignalMessage) => void>(() => undefined);
  const receivedOfferRef = useRef(false);
  const retryTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const subscribedRef = useRef(false);
  // cleanup 标志：unsub/cleanup 调用后置 true，防止 CLOSED 回调被误判为异常
  const signalingCleanupRef = useRef(false);
  // 当前主连接状态（游客侧取第一个 PC）
  const connStateRef = useRef<RtcConnState>('idle');
  const candidateKindRef = useRef<CandidateKind>('unknown');
  const onStatusChangeRef = useRef(onStatusChange);
  const audioRefInternal = useRef<HTMLAudioElement | null>(null);

  useEffect(() => { isOwnerRef.current = isOwner; }, [isOwner]);
  useEffect(() => { participantIdRef.current = participantId; }, [participantId]);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);

  // 发出状态更新
  const emitStatus = useCallback((connState: RtcConnState, candidateKind?: CandidateKind) => {
    connStateRef.current = connState;
    if (candidateKind !== undefined) candidateKindRef.current = candidateKind;
    onStatusChangeRef.current?.({
      connState,
      candidateKind: candidateKindRef.current,
      turnConfigured: isTurnConfigured(),
      relayForced: isRelayForced(),
    });
  }, []);

  const sendMessage = useCallback((msg: SignalMessage) => {
    channelRef.current?.send({ type: 'broadcast', event: 'signal', payload: msg });
  }, []);
  useEffect(() => { sendMessageRef.current = sendMessage; }, [sendMessage]);

  // 获取音频元素（优先外部 ref，否则用内部 ref）
  const getAudio = useCallback((): HTMLAudioElement | null => {
    if (audioRef) return audioRef.current;
    return audioRefInternal.current;
  }, [audioRef]);

  const createPeerConnection = useCallback((remoteId: string): RTCPeerConnection => {
    const pc = new RTCPeerConnection(buildRtcConfig());

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        sendMessageRef.current({
          type: 'ice-candidate',
          candidate: event.candidate.toJSON(),
          from: participantIdRef.current,
          to: remoteId,
        });
        // 记录本地候选类型（可观察，不输出 credential）
        const kind = parseCandidateKind(event.candidate);
        if (kind === 'relay' || candidateKindRef.current === 'unknown') {
          candidateKindRef.current = kind;
        }
      }
    };

    if (!isOwnerRef.current) {
      pc.ontrack = (event) => {
        const audio = getAudio();
        if (!audio) return;
        audio.srcObject = event.streams[0];
        // 不使用 autoplay，由 RoomRtcProvider/Listening 通过真实用户手势调用 play()
      };
    }

    if (isOwnerRef.current) {
      pc.onnegotiationneeded = async () => {
        if (pc.signalingState !== 'stable') return;
        try {
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sendMessageRef.current({ type: 'offer', sdp: pc.localDescription!, from: participantIdRef.current, to: remoteId });
        } catch (e) { console.error('[WebRTC] 重协商失败:', e); }
      };
    }

    // 连接状态监听（导游侧用于调试；游客侧用于状态机）
    pc.onconnectionstatechange = () => {
      const s = pc.connectionState;
      if (s === 'connected') emitStatus('connected', candidateKindRef.current);
      else if (s === 'connecting') emitStatus('connecting');
      else if (s === 'disconnected') emitStatus('disconnected');
      else if (s === 'failed') emitStatus('failed');
    };

    peerConnectionsRef.current.set(remoteId, pc);
    return pc;
  }, [getAudio, emitStatus]);

  // 将缓存的 candidate 全部 flush 进 pc
  const flushPendingCandidates = useCallback(async (remoteId: string, pc: RTCPeerConnection) => {
    const queue = pendingCandidatesRef.current.get(remoteId) ?? [];
    pendingCandidatesRef.current.delete(remoteId);
    for (const c of queue) {
      try { await pc.addIceCandidate(new RTCIceCandidate(c)); }
      catch (e) { console.error('[WebRTC] flush candidate 失败:', e); }
    }
  }, []);

  const createOfferForListener = useCallback(async (remoteId: string) => {
    const oldPc = peerConnectionsRef.current.get(remoteId);
    if (oldPc && (oldPc.connectionState === 'connected' || oldPc.connectionState === 'connecting')) return;
    if (oldPc) { oldPc.close(); peerConnectionsRef.current.delete(remoteId); }

    const pc = createPeerConnection(remoteId);
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) pc.addTrack(track, localStreamRef.current);
    }
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      sendMessageRef.current({ type: 'offer', sdp: pc.localDescription!, from: participantIdRef.current, to: remoteId });
    } catch (e) { console.error('[WebRTC] 创建 offer 失败:', e); }
  }, [createPeerConnection]);

  const handleOffer = useCallback(async (msg: Extract<SignalMessage, { type: 'offer' }>) => {
    if (msg.to !== participantIdRef.current) return;
    receivedOfferRef.current = true;
    for (const t of retryTimersRef.current) clearTimeout(t);
    retryTimersRef.current = [];

    let pc = peerConnectionsRef.current.get(msg.from);
    if (pc) {
      if (pc.signalingState !== 'stable') await pc.setLocalDescription({ type: 'rollback' });
    } else {
      pc = createPeerConnection(msg.from);
    }
    emitStatus('connecting');
    await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
    // flush 在 remoteDescription 之前积压的 candidate
    await flushPendingCandidates(msg.from, pc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    sendMessageRef.current({ type: 'answer', sdp: pc.localDescription!, from: participantIdRef.current, to: msg.from });
  }, [createPeerConnection, flushPendingCandidates, emitStatus]);

  const handleAnswer = useCallback(async (msg: Extract<SignalMessage, { type: 'answer' }>) => {
    if (msg.to !== participantIdRef.current) return;
    const pc = peerConnectionsRef.current.get(msg.from);
    if (pc?.signalingState === 'have-local-offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
      // flush 在 remoteDescription 之前积压的 candidate
      await flushPendingCandidates(msg.from, pc);
    }
  }, [flushPendingCandidates]);

  const handleIceCandidate = useCallback(async (msg: Extract<SignalMessage, { type: 'ice-candidate' }>) => {
    if (msg.to !== participantIdRef.current) return;
    const pc = peerConnectionsRef.current.get(msg.from);
    if (pc?.remoteDescription) {
      try { await pc.addIceCandidate(new RTCIceCandidate(msg.candidate)); }
      catch (e) { console.error('[WebRTC] addIceCandidate 失败:', e); }
    } else {
      // remoteDescription 尚未就绪：按 peerId 缓存，等待 flush
      const q = pendingCandidatesRef.current.get(msg.from) ?? [];
      q.push(msg.candidate);
      pendingCandidatesRef.current.set(msg.from, q);
    }
  }, []);

  /**
   * initSignaling — 必须在 Supabase channel 回调确认 SUBSCRIBED 后再允许 announceJoin；
   * 返回 { unsub, waitSubscribed: Promise<void>, retrySignaling: () => Promise<void> }
   * retrySignaling：重新建立频道订阅（用于 TIMED_OUT 退避重试）
   */
  const initSignaling = useCallback(() => {
    if (!roomId) return {
      unsub: () => undefined,
      waitSubscribed: Promise.resolve(),
      retrySignaling: () => Promise.resolve(),
    };
    if (channelRef.current) { signalingCleanupRef.current = true; supabase.removeChannel(channelRef.current); channelRef.current = null; }
    subscribedRef.current = false;

    /** 创建一个新的订阅 Promise，不重建 JS 闭包 */
    const createSubscription = () => {
      // removeChannel 同时发送 LEAVE 并从 SDK 内部连接池移除该 channel 对象，
      // 仅调 unsubscribe() 会留下僵尸连接占用数据库连接配额。
      signalingCleanupRef.current = false; // 新订阅开始前复位，重新接受错误检测
      if (channelRef.current) { signalingCleanupRef.current = true; supabase.removeChannel(channelRef.current); channelRef.current = null; }
      subscribedRef.current = false;

      let resolveSubscribed!: () => void;
      let rejectSubscribed!: (e: unknown) => void;
      let promiseSettled = false;
      const waitSub = new Promise<void>((res, rej) => {
        resolveSubscribed = () => { if (!promiseSettled) { promiseSettled = true; res(); } };
        rejectSubscribed = (e) => { if (!promiseSettled) { promiseSettled = true; rej(e); } };
      });

      const ch = supabase.channel(`room-signal-${roomId}`, { config: { broadcast: { self: false } } });
      ch
        .on('broadcast', { event: 'signal' }, ({ payload }: { payload: SignalMessage }) => {
          switch (payload.type) {
            case 'join':
              if (isOwnerRef.current) {
                if (micOnRef.current) createOfferForListener(payload.from);
                else pendingListenersRef.current.set(payload.from, payload.nickname);
              }
              break;
            case 'leave': {
              pendingListenersRef.current.delete(payload.from);
              const pc = peerConnectionsRef.current.get(payload.from);
              if (pc) { pc.close(); peerConnectionsRef.current.delete(payload.from); }
              break;
            }
            case 'offer': handleOffer(payload); break;
            case 'answer': handleAnswer(payload); break;
            case 'ice-candidate': handleIceCandidate(payload); break;
            case 'mic-on': onMicStateChange?.(true); break;
            case 'mic-off': onMicStateChange?.(false); break;
          }
        })
        .subscribe((status, err) => {
          if (status === 'SUBSCRIBED') {
            subscribedRef.current = true;
            resolveSubscribed();
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            // 真实错误：订阅失败（TIMED_OUT 由 announceJoin 层做指数退避重试）
            rejectSubscribed(err ?? new Error(`信令频道订阅失败: ${status}`));
          } else if (status === 'CLOSED') {
            // CLOSED 通常由主动 unsubscribe 触发（组件卸载/cleanup），
            // signalingCleanupRef 已置 true 时属正常流程，无条件忽略；
            // 仅在既未订阅成功、也非主动清理时才视为异常
            if (!subscribedRef.current && !signalingCleanupRef.current) {
              rejectSubscribed(err ?? new Error(`信令频道订阅失败: ${status}`));
            }
          }
        });

      channelRef.current = ch;
      return waitSub;
    };

    const waitSubscribed = createSubscription();
    const unsub = () => {
      signalingCleanupRef.current = true;
      if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null; }
      subscribedRef.current = false;
    };
    // retrySignaling：重新建立 channel（用于 TIMED_OUT 退避）
    const retrySignaling = () => createSubscription();

    return { unsub, waitSubscribed, retrySignaling };
  }, [roomId, createOfferForListener, handleOffer, handleAnswer, handleIceCandidate, onMicStateChange]);

  const startMic = useCallback(async (providedStream?: MediaStream): Promise<boolean> => {
    try {
      if (!providedStream && localStreamRef.current && localStreamRef.current.getAudioTracks().some(t => t.readyState === 'live')) {
        for (const track of localStreamRef.current.getTracks()) track.enabled = true;
        micOnRef.current = true;
        sendMessageRef.current({ type: 'mic-on', from: participantIdRef.current });
        return true;
      }
      const stream = providedStream ?? await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (localStreamRef.current && localStreamRef.current !== stream) {
        for (const track of localStreamRef.current.getTracks()) track.stop();
      }
      localStreamRef.current = stream;
      micOnRef.current = true;

      for (const [listenerId] of pendingListenersRef.current) await createOfferForListener(listenerId);
      pendingListenersRef.current.clear();

      for (const [, pc] of peerConnectionsRef.current) {
        if (pc.getSenders().length === 0) {
          for (const track of stream.getTracks()) pc.addTrack(track, stream);
        } else {
          const sender = pc.getSenders().find((s) => s.track?.kind === 'audio');
          if (sender) await sender.replaceTrack(stream.getAudioTracks()[0]);
        }
      }

      sendMessageRef.current({ type: 'mic-on', from: participantIdRef.current });
      return true;
    } catch (e) { console.error('[WebRTC] 麦克风失败:', e); return false; }
  }, [createOfferForListener]);

  const stopMic = useCallback(() => {
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) track.enabled = false;
    }
    micOnRef.current = false;
    sendMessageRef.current({ type: 'mic-off', from: participantIdRef.current });
  }, []);

  /**
   * announceJoin — 等 channel SUBSCRIBED 后再发 join；
   * TIMED_OUT 时做指数退避重试（最多 3 次，间隔 2s/4s/8s）；
   * 收到 offer 后停止重试。
   */
  const announceJoin = useCallback(async (
    nickname: string,
    waitSubscribed: Promise<void>,
    retrySignaling?: () => Promise<void>,
    _retryAttempt = 0,
  ) => {
    receivedOfferRef.current = false;
    for (const t of retryTimersRef.current) clearTimeout(t);
    retryTimersRef.current = [];

    try {
      await waitSubscribed;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout = msg.includes('TIMED_OUT') || msg.includes('DatabaseLack');
      const MAX_RETRY = 3;

      if (isTimeout && retrySignaling && _retryAttempt < MAX_RETRY) {
        const delay = 2000 * Math.pow(2, _retryAttempt); // 2s → 4s → 8s
        console.warn(`[WebRTC] 信令超时，${delay / 1000}s 后重试 (${_retryAttempt + 1}/${MAX_RETRY})…`);
        const t = setTimeout(() => {
          const nextWait = retrySignaling();
          announceJoin(nickname, nextWait, retrySignaling, _retryAttempt + 1);
        }, delay);
        retryTimersRef.current.push(t);
        return;
      }

      console.error('[WebRTC] 信令频道订阅失败，无法加入:', e);
      emitStatus('failed');
      return;
    }

    const doAnnounce = (attempt: number) => {
      if (receivedOfferRef.current) return;
      sendMessageRef.current({ type: 'join', from: participantIdRef.current, nickname });
      if (attempt < 6) {
        const t = setTimeout(() => doAnnounce(attempt + 1), 2000);
        retryTimersRef.current.push(t);
      }
    };
    doAnnounce(1);
  }, [emitStatus]);

  const announceLeave = useCallback(() => {
    sendMessageRef.current({ type: 'leave', from: participantIdRef.current });
  }, []);

  /** 触发一次受控重连（游客侧：关闭旧 PC + 重发 join） */
  const reconnect = useCallback((nickname: string, waitSubscribed: Promise<void>, retrySignaling?: () => Promise<void>) => {
    for (const [, pc] of peerConnectionsRef.current) pc.close();
    peerConnectionsRef.current.clear();
    pendingCandidatesRef.current.clear();
    candidateKindRef.current = 'unknown';
    emitStatus('idle');
    announceJoin(nickname, waitSubscribed, retrySignaling);
  }, [announceJoin, emitStatus]);

  const cleanup = useCallback(() => {
    for (const t of retryTimersRef.current) clearTimeout(t);
    retryTimersRef.current = [];
    for (const [, pc] of peerConnectionsRef.current) pc.close();
    peerConnectionsRef.current.clear();
    pendingCandidatesRef.current.clear();
    pendingListenersRef.current.clear();
    if (localStreamRef.current) {
      for (const track of localStreamRef.current.getTracks()) track.stop();
      localStreamRef.current = null;
    }
    signalingCleanupRef.current = true;
    if (channelRef.current) { supabase.removeChannel(channelRef.current); channelRef.current = null; }
    subscribedRef.current = false;
    // audio 元素由调用方 ref 管理，不在此处操作 DOM
    const audio = getAudio();
    if (audio) { audio.srcObject = null; }
  }, [getAudio]);

  useEffect(() => () => cleanup(), [cleanup]);

  return { initSignaling, startMic, stopMic, announceJoin, announceLeave, reconnect, cleanup };
}
