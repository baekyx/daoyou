import { useCallback, useEffect, useRef } from 'react';
import type { RtcConnState, RtcStatusInfo } from '@/hooks/use-webrtc';
import { isBaiduRtcConfigured } from '@/lib/rtcConfig';
import { supabase } from '@/db/supabase';

type BaiduRtcRole = 'guide' | 'tourist';

type BaiduRtcTokenResponse = {
  appId: string;
  roomName: string;
  userId: string;
  token: string;
  expiresAt: number;
  error?: string;
};

type UseBaiduRtcOptions = {
  roomId: string;
  participantId: string;
  role: BaiduRtcRole;
  displayName?: string;
  onMicStateChange?: (isOn: boolean) => void;
  onStatusChange?: (info: RtcStatusInfo) => void;
  onPlaybackStateChange?: (isPlaying: boolean) => void;
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return '未知错误';
  }
}

async function loadBaiduRtcSdk() {
  if (window.BRTC_Start) return;
  await import('baidurtc');
  if (!window.BRTC_Start) {
    throw new Error('百度 RTC Web SDK 加载失败');
  }
}

async function requestRtcToken(
  roomName: string,
  userKey: string,
): Promise<BaiduRtcTokenResponse> {
  if (import.meta.env.DEV) {
    const response = await fetch('/api/local/baidu/rtc-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomName, userKey }),
    });
    const data = await response.json() as BaiduRtcTokenResponse;
    if (!response.ok) {
      throw new Error(data.error || `百度 RTC Token 获取失败：HTTP ${response.status}`);
    }
    return data;
  }
  const { data, error } = await supabase.functions.invoke('baidu-rtc-token', {
    body: { roomName, userKey },
  });
  if (error) throw new Error(error.message || '百度 RTC 云端令牌获取失败');
  const result = data as BaiduRtcTokenResponse;
  if (!result?.token) throw new Error(result?.error || '百度 RTC 云端令牌无效');
  return result;
}

export function useBaiduRtc({
  roomId,
  participantId,
  role,
  displayName = role === 'guide' ? '导游' : '游客',
  onMicStateChange,
  onStatusChange,
  onPlaybackStateChange,
}: UseBaiduRtcOptions) {
  const configured = isBaiduRtcConfigured();
  const activeRef = useRef(false);
  const sdkStartedRef = useRef(false);
  const pendingCancelRef = useRef<(() => void) | null>(null);
  const generationRef = useRef(0);
  const playUnlockedRef = useRef(false);
  const playbackEnabledRef = useRef(true);
  const roomIdRef = useRef(roomId);
  const participantIdRef = useRef(participantId);
  const onMicStateChangeRef = useRef(onMicStateChange);
  const onStatusChangeRef = useRef(onStatusChange);
  const onPlaybackStateChangeRef = useRef(onPlaybackStateChange);
  const instanceIdRef = useRef(crypto.randomUUID().replace(/-/g, ''));
  const remoteContainerId = `baidu-rtc-remote-${instanceIdRef.current}`;
  const localContainerId = `baidu-rtc-local-${instanceIdRef.current}`;

  useEffect(() => { roomIdRef.current = roomId; }, [roomId]);
  useEffect(() => { participantIdRef.current = participantId; }, [participantId]);
  useEffect(() => { onMicStateChangeRef.current = onMicStateChange; }, [onMicStateChange]);
  useEffect(() => { onStatusChangeRef.current = onStatusChange; }, [onStatusChange]);
  useEffect(() => { onPlaybackStateChangeRef.current = onPlaybackStateChange; }, [onPlaybackStateChange]);

  const emitStatus = useCallback((connState: RtcConnState) => {
    onStatusChangeRef.current?.({
      connState,
      candidateKind: 'baidu',
      turnConfigured: true,
      relayForced: false,
    });
  }, []);

  const ensureContainer = useCallback((id: string) => {
    let element = document.getElementById(id);
    if (!element) {
      element = document.createElement('div');
      element.id = id;
      element.style.position = 'fixed';
      element.style.width = '1px';
      element.style.height = '1px';
      element.style.overflow = 'hidden';
      element.style.opacity = '0';
      element.style.pointerEvents = 'none';
      document.body.appendChild(element);
    }
    return element;
  }, []);

  const playRemoteAudio = useCallback(async (): Promise<boolean> => {
    playUnlockedRef.current = true;
    if (!playbackEnabledRef.current) return false;
    const container = ensureContainer(remoteContainerId);
    const media = Array.from(container.querySelectorAll<HTMLMediaElement>('audio,video'));
    if (media.length === 0) {
      onPlaybackStateChangeRef.current?.(false);
      return false;
    }
    const results = await Promise.allSettled(media.map(async element => {
      element.muted = false;
      element.volume = 1;
      await element.play();
    }));
    const didPlay = results.some(result => result.status === 'fulfilled');
    onPlaybackStateChangeRef.current?.(didPlay);
    return didPlay;
  }, [ensureContainer, remoteContainerId]);

  const setRemoteAudioEnabled = useCallback(async (enabled: boolean): Promise<boolean> => {
    playbackEnabledRef.current = enabled;
    const container = ensureContainer(remoteContainerId);
    const media = Array.from(container.querySelectorAll<HTMLMediaElement>('audio,video'));
    if (!enabled) {
      media.forEach(element => {
        element.pause();
        element.muted = true;
      });
      return true;
    }
    if (!playUnlockedRef.current) return false;
    return playRemoteAudio();
  }, [ensureContainer, playRemoteAudio, remoteContainerId]);

  const stop = useCallback(() => {
    generationRef.current += 1;
    pendingCancelRef.current?.();
    pendingCancelRef.current = null;
    if (sdkStartedRef.current) {
      try { window.BRTC_Stop?.(); } catch { /* SDK 已结束 */ }
    }
    sdkStartedRef.current = false;
    activeRef.current = false;
    onMicStateChangeRef.current?.(false);
    emitStatus('idle');
  }, [emitStatus]);

  const start = useCallback(async (
    startRole: BaiduRtcRole,
    stream?: MediaStream,
  ): Promise<boolean> => {
    if (!configured) throw new Error('百度 RTC 尚未配置');
    const currentRoom = roomIdRef.current.trim();
    const participant = participantIdRef.current.trim();
    if (!currentRoom || !participant) throw new Error('百度 RTC 缺少房间或用户信息');

    stop();
    const generation = generationRef.current;
    emitStatus('connecting');
    ensureContainer(remoteContainerId);
    ensureContainer(localContainerId);
    await loadBaiduRtcSdk();
    const token = await requestRtcToken(
      currentRoom,
      `${startRole}:${participant}`,
    );

    return new Promise<boolean>((resolve, reject) => {
      if (generation !== generationRef.current) {
        reject(new Error('百度 RTC 连接已取消'));
        return;
      }
      let settled = false;
      let timer: number | null = null;
      const clearPending = () => {
        if (timer) window.clearTimeout(timer);
        timer = null;
        pendingCancelRef.current = null;
      };
      const cancelPending = () => {
        if (settled) return;
        settled = true;
        clearPending();
        reject(new Error('百度 RTC 连接已取消'));
      };
      pendingCancelRef.current = cancelPending;
      const finishResolve = () => {
        if (settled) return;
        if (generation !== generationRef.current) {
          cancelPending();
          return;
        }
        settled = true;
        clearPending();
        activeRef.current = true;
        emitStatus('connected');
        if (startRole === 'guide') onMicStateChangeRef.current?.(true);
        resolve(true);
      };
      const finishReject = (error: unknown) => {
        if (settled) return;
        if (generation !== generationRef.current) {
          cancelPending();
          return;
        }
        settled = true;
        clearPending();
        activeRef.current = false;
        sdkStartedRef.current = false;
        emitStatus('failed');
        generationRef.current += 1;
        try { window.BRTC_Stop?.(); } catch { /* SDK 已结束 */ }
        reject(new Error(`百度 RTC 连接失败：${errorMessage(error)}`));
      };
      const markRemoteAudio = () => {
        if (generation !== generationRef.current) return;
        onMicStateChangeRef.current?.(true);
        emitStatus('connected');
        if (playUnlockedRef.current && playbackEnabledRef.current) void playRemoteAudio();
      };

      timer = window.setTimeout(() => {
        finishReject('连接超时');
      }, 15_000);

      try {
        sdkStartedRef.current = true;
        window.BRTC_Start?.({
          appid: token.appId,
          token: token.token,
          roomname: token.roomName,
          userid: token.userId,
          displayname: displayName,
          stream,
          aspublisher: startRole === 'guide',
          usingdatachannel: false,
          usingvideo: false,
          usingaudio: startRole === 'guide',
          receivingvideo: false,
          receivingaudio: startRole === 'tourist',
          autosubscribe: startRole === 'tourist',
          autopublish: startRole === 'guide',
          remotevideoviewid: remoteContainerId,
          localvideoviewid: localContainerId,
          shownovideo: false,
          showspinner: false,
          debuglevel: ['error'],
          userevent: true,
          success: () => {
            finishResolve();
          },
          error: error => {
            if (!settled) {
              finishReject(error);
            } else if (generation === generationRef.current) {
              activeRef.current = false;
              sdkStartedRef.current = false;
              onMicStateChangeRef.current?.(false);
              emitStatus('failed');
            }
          },
          destroyed: error => {
            if (generation !== generationRef.current) return;
            activeRef.current = false;
            sdkStartedRef.current = false;
            onMicStateChangeRef.current?.(false);
            emitStatus(error ? 'failed' : 'disconnected');
          },
          linkdownevent: () => {
            if (generation === generationRef.current) emitStatus('disconnected');
          },
          linkupevent: () => {
            if (generation === generationRef.current) emitStatus('connected');
          },
          mediastate: (medium, on) => {
            if (medium.toLowerCase().includes('audio')) {
              onMicStateChangeRef.current?.(on);
            }
          },
          remotevideoon: markRemoteAudio,
          remotevideocoming: markRemoteAudio,
          remotevideooff: () => onMicStateChangeRef.current?.(false),
          remotevideoleaving: () => onMicStateChangeRef.current?.(false),
          remotevideounpublished: () => onMicStateChangeRef.current?.(false),
          localvideopublished_ok: () => onMicStateChangeRef.current?.(true),
        });
      } catch (error) {
        finishReject(error);
      }
    });
  }, [
    configured,
    displayName,
    emitStatus,
    ensureContainer,
    localContainerId,
    playRemoteAudio,
    remoteContainerId,
    stop,
  ]);

  const startPublisher = useCallback(
    (stream: MediaStream) => start('guide', stream),
    [start],
  );
  const startSubscriber = useCallback(
    () => start('tourist'),
    [start],
  );

  useEffect(() => () => {
    generationRef.current += 1;
    pendingCancelRef.current?.();
    pendingCancelRef.current = null;
    if (sdkStartedRef.current) {
      try { window.BRTC_Stop?.(); } catch { /* SDK 已结束 */ }
    }
    sdkStartedRef.current = false;
    activeRef.current = false;
    document.getElementById(remoteContainerId)?.remove();
    document.getElementById(localContainerId)?.remove();
  }, [localContainerId, remoteContainerId]);

  return {
    configured,
    activeRef,
    startPublisher,
    startSubscriber,
    playRemoteAudio,
    setRemoteAudioEnabled,
    stop,
  };
}
