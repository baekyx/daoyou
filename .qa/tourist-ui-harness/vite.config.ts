import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const root = process.cwd();
const harness = path.resolve(root, '.qa/tourist-ui-harness');

export default defineConfig({
  root,
  plugins: [react()],
  resolve: {
    alias: [
      { find: '@/contexts/AuthContext', replacement: path.resolve(harness, 'mocks/auth.ts') },
      { find: '@/api/rooms', replacement: path.resolve(harness, 'mocks/rooms.ts') },
      { find: '@/api/roomActivity', replacement: path.resolve(harness, 'mocks/roomActivity.ts') },
      { find: '@/api/subtitles', replacement: path.resolve(harness, 'mocks/subtitles.ts') },
      { find: '@/api/meetingMinutes', replacement: path.resolve(harness, 'mocks/meetingMinutes.ts') },
      { find: '@/api/photos', replacement: path.resolve(harness, 'mocks/photos.ts') },
      { find: '@/api/photosSecure', replacement: path.resolve(harness, 'mocks/photosSecure.ts') },
      { find: '@/api/feedbacks', replacement: path.resolve(harness, 'mocks/feedbacks.ts') },
      { find: '@/hooks/use-room-rtc', replacement: path.resolve(harness, 'mocks/roomRtc.ts') },
      { find: '@/hooks/use-room-presence', replacement: path.resolve(harness, 'mocks/roomPresence.tsx') },
      { find: '@/hooks/use-webrtc', replacement: path.resolve(harness, 'mocks/webrtc.ts') },
      { find: '@/hooks/use-baidu-rtc', replacement: path.resolve(harness, 'mocks/baiduRtc.ts') },
      { find: '@/db/supabase', replacement: path.resolve(harness, 'mocks/supabase.ts') },
      { find: '@/i18n/AppLanguageContext', replacement: path.resolve(harness, 'mocks/appLanguage.ts') },
      { find: '@/pages/guide/GuideScreens', replacement: path.resolve(harness, 'mocks/guideScreens.tsx') },
      { find: '@/hooks/useAvatarUploadFlow', replacement: path.resolve(harness, 'mocks/avatarUpload.ts') },
      { find: '@/hooks/useTouristRoomCleanup', replacement: path.resolve(harness, 'mocks/touristCleanup.ts') },
      { find: '@', replacement: path.resolve(root, 'src') },
    ],
  },
});
