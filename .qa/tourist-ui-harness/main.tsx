import { useState, type CSSProperties } from 'react';
import { createRoot } from 'react-dom/client';
import { Listening, Password, Question, RoomList, SubtitleSettings } from '../../src/pages/tourist/TouristScreens';
import { RecentRooms, RoomEndedOverlay, SubtitleTab, TouristMyPage, WeakNetModal } from '../../src/pages/tourist/TouristExtra';
import { RoomAlbumTab, RoomPhotoDetail } from '../../src/pages/tourist/RoomAlbumScreens';
import { HelpFeedbackScreen, NotificationsScreen } from '../../src/pages/settings/SupportScreens';
import {
  CardAlert, CardDetail, CardLibrary, RoomCardDetail, SubtitleHistory, TouristCardLibrary,
} from '../../src/pages/cards/CardScreens';
import { MyPage, Profile } from '../../src/pages/auth/ProfileScreen';
import { IdentityAccount } from '../../src/pages/auth/IdentityAccount';
import {
  PhotoDeleteRequest,
  PhotographerAlbum,
  PhotographerJoin,
  PhotographerTasks,
  PhotographerWait,
} from '../../src/pages/photographer/PhotographerScreens';
import {
  PhotographerHelpPage,
  PhotographerPrivacyPage,
  PhotographerStoragePage,
} from '../../src/pages/photographer/PhotographerSettingsScreens';
import { Album, PhotoDetail, Upload } from '../../src/pages/photos/PhotoScreens';
import { CreateRoom, GuideHome, GuideLive, RoomSuccess } from '../../src/pages/guide/GuideScreens';
import {
  EndResult, GuestList, GuideSubtitleRecord, KnowledgeCardDetail, KnowledgeCardLib,
} from '../../src/pages/guide/GuideExtra';
import { RecordDetailScreen, RecordsScreen } from '../../src/pages/records/RecordsScreen';
import '../../src/index.css';
import './harness.css';

type MainScreen =
  | 'room-list' | 'recent-rooms' | 'password' | 'tourist-my' | 'listening' | 'subtitle-tab'
  | 'subtitle-history' | 'room-album' | 'room-photo-detail' | 'question' | 'subtitle-settings'
  | 'card-alert' | 'tourist-card-library' | 'tourist-card-detail' | 'tourist-room-card-detail'
  | 'tourist-notifications' | 'tourist-help' | 'tourist-profile-edit' | 'tourist-identity-account'
  | 'tourist-weak-net' | 'tourist-room-ended' | 'album' | 'photo'
  | 'photographer-tasks' | 'photo-join' | 'photo-join-password' | 'photo-wait' | 'upload'
  | 'photographer-album' | 'photo-delete' | 'photographer-my' | 'identity-account'
  | 'photographer-storage' | 'photographer-privacy' | 'photographer-help'
  | 'guide-home' | 'create-room' | 'room-success' | 'guide-live' | 'end-result' | 'guest-list'
  | 'guide-subtitle-record' | 'kc-library' | 'kc-detail' | 'records' | 'record-detail'
  | 'guide-subtitle-settings' | 'guide-notifications' | 'guide-help' | 'guide-my';

const initialScreen = new URLSearchParams(window.location.search).get('screen');
if (initialScreen === 'photo-join-password') {
  sessionStorage.setItem('photographer-reverify-room', JSON.stringify({
    id: 'qa-room-gate',
    room_number: '401640',
    name: '午门建筑漫游',
    status: 'live',
  }));
}
if (initialScreen === 'photo-delete') {
  sessionStorage.setItem('delete_photo', JSON.stringify({
    id: 'qa-photo-1',
    room_id: 'qa-room-gate',
    url: '/.qa/tourist-ui-harness/assets/gate-cover.webp',
    uploaded_at: new Date().toISOString(),
  }));
}
if (initialScreen === 'room-success') {
  sessionStorage.setItem('shiguang-created-room-id', 'qa-room-gate');
  sessionStorage.setItem('shiguang-room-pwd-qa-room-gate', '123456');
}
if (initialScreen === 'room-photo-detail' || initialScreen === 'photo') {
  sessionStorage.setItem('selected_photo_id', 'qa-photo-1');
  sessionStorage.setItem('selected_room_photo', JSON.stringify({
    id: 'qa-photo-1',
    room_id: 'qa-room-gate',
    url: '/.qa/tourist-ui-harness/assets/gate-cover.webp',
    uploaded_at: new Date().toISOString(),
  }));
}

function Harness() {
  const params = new URLSearchParams(window.location.search);
  const initial = params.get('screen');
  const qaWidth = Math.min(430, Math.max(280, Number(params.get('width')) || 390));
  const qaHeight = Math.min(1000, Math.max(520, Number(params.get('height')) || 844));
  const qaSize = {
    '--qa-width': `${qaWidth}px`,
    '--qa-height': `${qaHeight}px`,
  } as CSSProperties;
  const supportedScreens: MainScreen[] = [
    'room-list', 'recent-rooms', 'password', 'tourist-my', 'listening', 'subtitle-tab',
    'subtitle-history', 'room-album', 'room-photo-detail', 'question', 'subtitle-settings',
    'card-alert', 'tourist-card-library', 'tourist-card-detail', 'tourist-room-card-detail',
    'tourist-notifications', 'tourist-help', 'tourist-profile-edit', 'tourist-identity-account',
    'tourist-weak-net', 'tourist-room-ended', 'album', 'photo',
    'photographer-tasks', 'photo-join', 'photo-join-password', 'photo-wait', 'upload',
    'photographer-album', 'photo-delete', 'photographer-my', 'identity-account',
    'photographer-storage', 'photographer-privacy', 'photographer-help',
    'guide-home', 'create-room', 'room-success', 'guide-live', 'end-result', 'guest-list',
    'guide-subtitle-record', 'kc-library', 'kc-detail', 'records', 'record-detail',
    'guide-subtitle-settings', 'guide-notifications', 'guide-help', 'guide-my',
  ];
  const [screen, setScreen] = useState<MainScreen>(
    initial && supportedScreens.includes(initial as MainScreen)
      ? initial as MainScreen
      : 'room-list',
  );
  const [lastGo, setLastGo] = useState('');

  const go = (target: string) => {
    const qaTarget = target === 'help-feedback'
      ? (screen.startsWith('guide-') || screen === 'guide-my' ? 'guide-help' : 'tourist-help')
      : target === 'notifications'
        ? (screen.startsWith('guide-') || screen === 'guide-my' ? 'guide-notifications' : 'tourist-notifications')
        : target;
    if (supportedScreens.includes(qaTarget as MainScreen)) {
      setScreen(qaTarget as MainScreen);
      return;
    }
    setLastGo(target);
  };

  return (
    <main className="mobile-app qa-mobile-size" style={qaSize} aria-label="游客端正式组件视觉验收">
      {screen === 'room-list' && <RoomList go={go} />}
      {screen === 'recent-rooms' && <RecentRooms go={go} />}
      {screen === 'password' && <Password go={go} />}
      {screen === 'tourist-my' && <TouristMyPage go={go} />}
      {screen === 'listening' && <Listening go={go} />}
      {screen === 'subtitle-tab' && <SubtitleTab go={go} />}
      {screen === 'subtitle-history' && <SubtitleHistory go={go} />}
      {screen === 'room-album' && <RoomAlbumTab go={go} />}
      {screen === 'room-photo-detail' && <RoomPhotoDetail go={go} />}
      {screen === 'question' && <Question go={go} />}
      {screen === 'subtitle-settings' && <SubtitleSettings go={go} />}
      {screen === 'card-alert' && <CardAlert go={go} />}
      {screen === 'tourist-card-library' && <TouristCardLibrary go={go} />}
      {screen === 'tourist-card-detail' && <CardDetail go={go} />}
      {screen === 'tourist-room-card-detail' && <RoomCardDetail go={go} />}
      {screen === 'tourist-notifications' && <NotificationsScreen go={go} />}
      {screen === 'tourist-help' && <HelpFeedbackScreen go={go} />}
      {screen === 'tourist-profile-edit' && <Profile go={go} />}
      {screen === 'tourist-identity-account' && <IdentityAccount go={go} />}
      {screen === 'tourist-weak-net' && <><Listening go={go} /><WeakNetModal onRetry={() => undefined} onSubtitleOnly={() => undefined} onClose={() => undefined} /></>}
      {screen === 'tourist-room-ended' && <><Listening go={go} /><RoomEndedOverlay go={go} endedAt="2026-08-03T10:20:00.000Z" /></>}
      {screen === 'album' && <Album go={go} />}
      {screen === 'photo' && <PhotoDetail go={go} />}
      {screen === 'photographer-tasks' && <PhotographerTasks go={go} />}
      {(screen === 'photo-join' || screen === 'photo-join-password') && <PhotographerJoin go={go} />}
      {screen === 'photo-wait' && <PhotographerWait go={go} />}
      {screen === 'upload' && <Upload go={go} />}
      {screen === 'photographer-album' && <PhotographerAlbum go={go} />}
      {screen === 'photo-delete' && <PhotoDeleteRequest go={go} />}
      {screen === 'photographer-my' && <MyPage go={go} />}
      {screen === 'identity-account' && <IdentityAccount go={go} />}
      {screen === 'photographer-storage' && <PhotographerStoragePage go={go} />}
      {screen === 'photographer-privacy' && <PhotographerPrivacyPage go={go} />}
      {screen === 'photographer-help' && <PhotographerHelpPage go={go} />}
      {screen === 'guide-home' && <GuideHome go={go} />}
      {screen === 'create-room' && <CreateRoom go={go} />}
      {screen === 'room-success' && <RoomSuccess go={go} />}
      {screen === 'guide-live' && <GuideLive go={go} />}
      {screen === 'end-result' && <EndResult go={go} />}
      {screen === 'guest-list' && <GuestList go={go} />}
      {screen === 'guide-subtitle-record' && <GuideSubtitleRecord go={go} />}
      {screen === 'kc-library' && <KnowledgeCardLib go={go} />}
      {screen === 'kc-detail' && <KnowledgeCardDetail go={go} />}
      {screen === 'records' && <RecordsScreen go={go} />}
      {screen === 'record-detail' && <RecordDetailScreen go={go} />}
      {screen === 'guide-subtitle-settings' && <SubtitleSettings go={go} returnTo="guide-my" />}
      {screen === 'guide-notifications' && <NotificationsScreen go={go} />}
      {screen === 'guide-help' && <HelpFeedbackScreen go={go} />}
      {screen === 'guide-my' && <MyPage go={go} />}
      <output className="qa-last-go" hidden>{lastGo}</output>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<Harness />);
