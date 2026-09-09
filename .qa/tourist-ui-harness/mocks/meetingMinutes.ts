export async function fetchMeetingMinutesCloud() {
  if (new URLSearchParams(window.location.search).get('variant') === 'history-empty') {
    return {
      roomId: 'qa-room-gate',
      roomName: '188888的测试',
      title: '188888的测试讲解纪要',
      keywords: ['讲解主题'],
      overview: '本次讲解没有可用于生成纪要的中文字幕。',
      keyPoints: [],
      startedAt: '2026-08-01T02:05:00.000Z',
      endedAt: '2026-08-01T03:05:00.000Z',
      durationSeconds: 3600,
      subtitleCount: 0,
      generatedAt: '2026-08-01T03:06:00.000Z',
    };
  }
  return {
    roomId: 'qa-room-palace',
    roomName: '故宫文化探索团',
    title: '故宫文化探索讲解纪要',
    keywords: ['太和殿', '中轴线', '礼仪空间'],
    overview: '本次讲解围绕故宫中轴线与太和殿的建筑、礼仪功能展开。',
    keyPoints: ['太和殿位于故宫外朝核心区域。'],
    startedAt: '2026-07-31T02:00:00.000Z',
    endedAt: '2026-07-31T03:00:00.000Z',
    durationSeconds: 3600,
    subtitleCount: 1,
    generatedAt: '2026-07-31T03:01:00.000Z',
  };
}

export async function fetchMeetingMinutesRoomIds() {
  return new Set(['qa-room-palace']);
}

export async function saveMeetingMinutesCloud() {
  return undefined;
}
