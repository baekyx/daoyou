export function useRoomRtc() {
  return {
    connState: 'connected',
    candidateKind: 'host',
    turnConfigured: true,
    relayForced: false,
    guideMicOn: false,
    audioPlayState: 'blocked',
    playAudio: async () => undefined,
    setChineseAudioEnabled: () => undefined,
    retryConnect: () => undefined,
    trackPresence: () => undefined,
    untrackPresence: async () => undefined,
  };
}
