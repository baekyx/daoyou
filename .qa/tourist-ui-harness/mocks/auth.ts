const screen = new URLSearchParams(window.location.search).get('screen');
const variant = new URLSearchParams(window.location.search).get('variant');
const roleOverride = new URLSearchParams(window.location.search).get('role');
const isPhotographer = Boolean(screen && (
  screen.startsWith('photographer-')
  || screen === 'photo-join'
  || screen === 'photo-join-password'
  || screen === 'photo-wait'
  || screen === 'photo-delete'
  || screen === 'upload'
  || screen === 'identity-account'
));
const isGuide = Boolean(screen && (
  screen.startsWith('guide-')
  || screen === 'create-room'
  || screen === 'room-success'
  || screen === 'end-result'
  || screen === 'guest-list'
  || screen === 'kc-library'
  || screen === 'kc-detail'
  || screen === 'records'
  || screen === 'record-detail'
));

const profile = {
  id: 'qa-tourist',
  role: roleOverride ?? (isPhotographer ? 'photographer' : isGuide ? 'guide' : 'tourist'),
  nickname: roleOverride === 'tourist' ? '测试游客' : isPhotographer ? '测试摄影师' : isGuide ? '测试导游' : '测试游客',
  username: 'qa-tourist',
  avatar_url: '/avatars/female-tourist.webp',
  phone: '13800138000',
  gender: 'female',
  default_language: 'bilingual',
};

const user = { id: isGuide ? 'qa-guide-1' : 'qa-tourist' };
const noop = () => undefined;
const asyncNoop = async () => undefined;
const asyncOk = async () => ({ error: null });
const switchRole = async (role: string) => ({ role, error: null });

const endedRoomScreens = new Set(['end-result', 'record-detail', 'subtitle-history']);
const successRoomScreens = new Set(['room-success']);

let currentRoom: Record<string, unknown> | null = variant === 'empty' ? null : {
  id: 'qa-room-gate',
  room_number: '401640',
  name: '午门建筑漫游',
  cover_url: '/.qa/tourist-ui-harness/assets/palace-cover.webp',
  guide_id: isGuide ? 'qa-guide-1' : 'qa-guide-1',
  status: endedRoomScreens.has(screen ?? '') ? 'ended' : successRoomScreens.has(screen ?? '') ? 'pending' : 'live',
  online_count: 12,
  created_at: '2026-08-01T02:00:00.000Z',
  started_at: '2026-08-01T02:05:00.000Z',
  ended_at: endedRoomScreens.has(screen ?? '') ? '2026-08-01T03:05:00.000Z' : null,
  actual_duration: endedRoomScreens.has(screen ?? '') ? 60 : 0,
  guide: { nickname: '风芯子', avatar_url: '/avatars/male-guide.webp' },
};

const setCurrentRoom = (room: Record<string, unknown> | null) => {
  currentRoom = room;
};

export function useAuth() {
  const currentVariant = new URLSearchParams(window.location.search).get('variant');
  return {
    user,
    profile,
    loading: false,
    profileLoading: false,
    currentRoom: currentVariant === 'empty' ? null : currentRoom,
    setCurrentRoom,
    subtitlePrefs: { showCn: true, showEn: true, mode: 'bilingual', fontSize: 'medium' },
    setSubtitlePrefs: noop,
    signOut: asyncNoop,
    refreshProfile: asyncNoop,
    sendPhoneOtp: asyncOk,
    updatePhone: asyncOk,
    switchRole,
  };
}
