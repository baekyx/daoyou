export async function fetchPhotosSafe() {
  return buildPhotos();
}

export async function fetchPhotosSafeStrict() {
  return buildPhotos();
}

function buildPhotos() {
  const variant = new URLSearchParams(window.location.search).get('variant');
  if (variant !== 'album-long') return [];
  const roomId = 'qa-room-gate';
  return Array.from({ length: 18 }, (_, index) => ({
    id: `qa-photo-${index + 1}`,
    room_id: roomId,
    photographer_id: 'qa-tourist',
    url: index % 2 === 0
      ? '/.qa/tourist-ui-harness/assets/gate-cover.webp'
      : '/.qa/tourist-ui-harness/assets/palace-cover.webp',
    taken_at: null,
    uploaded_at: new Date(Date.now() - index * 60000).toISOString(),
  }));
}
