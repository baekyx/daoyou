export function useWebRTC() {
  return {
    initSignaling: () => ({ unsub: () => undefined, waitSubscribed: Promise.resolve() }),
    startMic: async () => true,
    stopMic: () => undefined,
  };
}
