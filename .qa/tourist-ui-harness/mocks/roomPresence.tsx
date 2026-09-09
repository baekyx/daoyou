import type { PropsWithChildren } from 'react';

export function RoomPresenceProvider({ children }: PropsWithChildren<Record<string, unknown>>) {
  return children;
}

export function useRoomPresence() {
  return {
    onlineParticipantIds: new Set(['qa-tourist-1', 'qa-tourist-2', 'qa-photographer-1']),
    participantCount: 3,
    trackPresence: async () => undefined,
    untrackPresence: async () => undefined,
  };
}
