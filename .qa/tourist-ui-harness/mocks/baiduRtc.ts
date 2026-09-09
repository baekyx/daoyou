export function useBaiduRtc() {
  return {
    configured: true,
    startPublisher: async () => true,
    stop: () => undefined,
  };
}
