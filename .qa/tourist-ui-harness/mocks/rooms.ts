export const qaRooms = [
  {
    id: 'qa-room-palace',
    room_number: '978525',
    name: '故宫文化探索团',
    cover_url: '/.qa/tourist-ui-harness/assets/palace-cover.webp',
    guide_id: 'qa-guide-1',
    status: 'ended',
    online_count: 12,
    started_at: '2026-07-31T01:30:00.000Z',
    ended_at: '2026-07-31T03:10:00.000Z',
    created_at: '2026-07-30T10:00:00.000Z',
    guide: { nickname: '风芯子', avatar_url: '/avatars/male-guide.webp' },
  },
  {
    id: 'qa-room-gate',
    room_number: '401640',
    name: '午门建筑漫游',
    cover_url: '/.qa/tourist-ui-harness/assets/gate-cover.webp',
    guide_id: 'qa-guide-2',
    status: 'live',
    online_count: 6,
    started_at: '2026-08-03T01:20:00.000Z',
    ended_at: null,
    created_at: '2026-08-02T10:00:00.000Z',
    guide: { nickname: '薛少杰', avatar_url: '/avatars/male-guide.webp' },
  },
  {
    id: 'qa-room-garden',
    room_number: '625807',
    name: '御花园午后跟拍',
    cover_url: '/.qa/tourist-ui-harness/assets/gate-cover.webp',
    guide_id: 'qa-guide-3',
    status: 'live',
    discoverable: true,
    online_count: 9,
    started_at: '2026-08-03T00:40:00.000Z',
    ended_at: null,
    created_at: '2026-08-02T08:00:00.000Z',
    guide: { nickname: '林秋', avatar_url: '/avatars/male-guide.webp' },
  },
];

export const qaPendingRoom = {
  id: 'qa-room-pending',
  room_number: '703440',
  name: '故宫晨间讲解',
  cover_url: '/.qa/tourist-ui-harness/assets/palace-cover.webp',
  guide_id: 'qa-guide-1',
  status: 'pending',
  online_count: 0,
  started_at: null,
  ended_at: null,
  created_at: '2026-08-03T00:10:00.000Z',
  guide: { nickname: '测试导游', avatar_url: '/avatars/male-guide.webp' },
};

function guideRoomsForQa() {
  const variant = new URLSearchParams(window.location.search).get('variant');
  return variant === 'pending' || variant === 'mixed-status'
    ? [qaPendingRoom, ...qaRooms]
    : qaRooms;
}

export async function fetchActiveRoomsStrict() {
  return qaRooms;
}

export async function fetchActiveRooms() {
  return qaRooms;
}

export async function fetchRoomByNumber() {
  return qaRooms[0];
}

export async function fetchRoomById(roomId: string) {
  const room = qaRooms.find(item => item.id === roomId) ?? null;
  if (!room) return null;
  const screen = new URLSearchParams(window.location.search).get('screen');
  if (screen === 'room-success') {
    return { ...room, guide_id: 'qa-guide-1', status: 'pending' };
  }
  return room;
}

export async function fetchGuideRooms() {
  return guideRoomsForQa();
}

export async function fetchGuideRoomsStrict() {
  return guideRoomsForQa();
}

export async function createRoom() {
  return qaRooms[0];
}

export async function updateRoomStatus() {
  return qaRooms[0];
}

export async function updateRoomDuration() {
  return qaRooms[0];
}

export function genPassword() {
  return '123456';
}

export async function fetchMyRoomPassword() {
  return '123456';
}
