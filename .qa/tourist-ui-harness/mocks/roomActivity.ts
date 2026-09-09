import { qaRooms } from './rooms';

export async function resolveRoomEntry(roomId: string) {
  const room = qaRooms.find(item => item.id === roomId);
  return {
    target: room?.status === 'ended' ? 'subtitle-history' : 'listening',
    reason: room?.status === 'ended' ? 'room_ended' : 'authorized',
  };
}

export async function leaveRoom() {
  return undefined;
}

export async function joinRoomWithPassword() {
  return { ok: true };
}

export async function joinPhotographerRoomWithPassword() {
  return { ok: true };
}

export async function fetchBarrages() {
  return [];
}

export async function fetchQuestions() {
  return [];
}

export async function sendQuestion() {
  return undefined;
}

export async function restoreCurrentRoom() {
  return null;
}

export async function fetchMyJoinedRooms() {
  return qaRooms;
}

export async function fetchMyJoinedRoomsStrict() {
  return qaRooms;
}
