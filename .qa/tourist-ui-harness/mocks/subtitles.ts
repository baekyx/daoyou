export async function fetchSubtitlesSafe() {
  if (new URLSearchParams(window.location.search).get('variant') === 'history-empty') return [];
  return [{
    id: 'qa-subtitle-1',
    room_id: 'qa-room-palace',
    content_cn: '太和殿是故宫外朝三大殿之一，也是重要礼仪空间。',
    content_en: 'The Hall of Supreme Harmony is one of the three main halls.',
    created_at: '2026-07-31T02:15:00.000Z',
  }];
}

export async function fetchAllSubtitles() {
  return [];
}

export async function fetchAllSubtitlesStrict() {
  if (new URLSearchParams(window.location.search).get('variant') === 'history-empty') return [];
  return fetchSubtitlesSafe();
}
