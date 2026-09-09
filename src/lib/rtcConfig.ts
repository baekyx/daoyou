/**
 * rtcConfig.ts — WebRTC ICE 服务器配置
 *
 * TURN 凭据来源：Vite 环境变量（.env.local / 外部 CI 注入）
 *   VITE_TURN_URLS     逗号分隔的 TURN URL 列表
 *                      例：turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349
 *   VITE_TURN_USERNAME TURN 用户名（测试临时凭据，不得写死真实密钥）
 *   VITE_TURN_CREDENTIAL TURN 密码（测试临时凭据，不得写死真实密钥）
 *
 * 未配置 TURN 时应用仍可运行，但仅限局域网/可直连测试。
 * URL 参数 rtcRelay=1 时强制 relay 模式（iceTransportPolicy:'relay'）。
 */

export type CandidateKind = 'host' | 'srflx' | 'relay' | 'baidu' | 'unknown';

/** 解析单个 RTCIceCandidate 的候选类型 */
export function parseCandidateKind(candidate: RTCIceCandidate | null | undefined): CandidateKind {
  if (!candidate?.candidate) return 'unknown';
  const parts = candidate.candidate.split(' ');
  // RFC 8839 格式：foundation component protocol priority address port type ...
  const typ = parts[7] ?? '';
  if (typ === 'host') return 'host';
  if (typ === 'srflx') return 'srflx';
  if (typ === 'relay') return 'relay';
  return 'unknown';
}

/** TURN 是否已配置（URL+USERNAME+CREDENTIAL 均非空） */
export function isTurnConfigured(): boolean {
  const urls = import.meta.env.VITE_TURN_URLS ?? '';
  const user = import.meta.env.VITE_TURN_USERNAME ?? '';
  const cred = import.meta.env.VITE_TURN_CREDENTIAL ?? '';
  return urls.trim() !== '' && user.trim() !== '' && cred.trim() !== '';
}

/** 是否已配置百度 RTC。AppID 可公开，AppKey 只在本地/云端令牌服务使用。 */
export function isBaiduRtcConfigured(): boolean {
  return Boolean(
    String(import.meta.env.VITE_BAIDU_RTC_APP_ID ?? '').trim()
  );
}

/** 当前是否为 relay 强制模式（URL 参数 rtcRelay=1） */
export function isRelayForced(): boolean {
  return new URLSearchParams(window.location.search).get('rtcRelay') === '1';
}

/** 构建 RTCConfiguration */
export function buildRtcConfig(): RTCConfiguration {
  const stun: RTCIceServer[] = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ];

  const iceServers: RTCIceServer[] = [...stun];

  if (isTurnConfigured()) {
    const rawUrls = import.meta.env.VITE_TURN_URLS as string;
    const urls = rawUrls.split(',').map(u => u.trim()).filter(Boolean);
    iceServers.push({
      urls,
      username: import.meta.env.VITE_TURN_USERNAME as string,
      credential: import.meta.env.VITE_TURN_CREDENTIAL as string,
    });
  } else {
    // 开发日志：明确告知 TURN 未配置
    console.warn('[RTC] TURN 未配置（VITE_TURN_URLS/USERNAME/CREDENTIAL 缺失），仅可进行局域网/可直连测试。');
  }

  return {
    iceServers,
    iceTransportPolicy: isRelayForced() ? 'relay' : 'all',
  };
}
