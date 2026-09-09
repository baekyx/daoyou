import React from "react";
import { useEffect, useState, useRef } from "react";

import { useAuth } from "@/contexts/AuthContext";
import { fetchRoomByNumber } from "@/api/rooms";
import { resolveRoomEntry } from "@/api/roomActivity";
import { Login, RoleSelect } from "@/pages/auth/AuthScreens";
import { IdentityAccount } from "@/pages/auth/IdentityAccount";
import { Profile, MyPage } from "@/pages/auth/ProfileScreen";
import { RecordDetailScreen, RecordsScreen } from "@/pages/records/RecordsScreen";
import { GuideHome, CreateRoom, RoomSuccess, GuideLive, type GuideLiveSnapshot } from "@/pages/guide/GuideScreens";
import { GuestList, GuideSubtitleRecord, KnowledgeCardLib, KnowledgeCardDetail, EndResult } from "@/pages/guide/GuideExtra";
import { RoomList, Password, Listening, Question, SubtitleSettings } from "@/pages/tourist/TouristScreens";
import { RecentRooms, SubtitleTab, TouristMyPage } from "@/pages/tourist/TouristExtra";
import { RoomRtcProvider } from "@/hooks/use-room-rtc";
import { RoomPresenceProvider } from "@/hooks/use-room-presence";
import { RoomAlbumTab, RoomPhotoDetail } from "@/pages/tourist/RoomAlbumScreens";
import {
  CardAlert,
  CardLibrary,
  TouristCardLibrary,
  CardDetail,
  RoomCardDetail,
  SubtitleHistory,
} from "@/pages/cards/CardScreens";
import { Album, PhotoDetail, PhotographerHome, Upload } from "@/pages/photos/PhotoScreens";
import { PhotographerTasks, PhotographerJoin, PhotographerWait, PhotographerAlbum, PhotoDeleteRequest } from "@/pages/photographer/PhotographerScreens";
import { PhotographerStoragePage, PhotographerPrivacyPage, PhotographerHelpPage } from "@/pages/photographer/PhotographerSettingsScreens";
import { HelpFeedbackScreen, NotificationsScreen } from "@/pages/settings/SupportScreens";

/** sessionStorage key：待处理邀请房间号（不含密码） */
export const PENDING_INVITE_KEY = 'shiguang-pending-invite';

/** 从 URL 读取 invite 参数，合法则返回 6 位房间号，否则 null */
function readInviteParam(): string | null {
  const raw = new URLSearchParams(window.location.search).get('invite') ?? '';
  return /^\d{6}$/.test(raw) ? raw : null;
}

/** 移除 URL 中的 pwd/password 参数（旧链接兼容），不新增历史记录 */
function sanitizeUrlPassword(): void {
  const params = new URLSearchParams(window.location.search);
  if (params.has('pwd') || params.has('password')) {
    params.delete('pwd');
    params.delete('password');
    const search = params.toString() ? `?${params.toString()}` : '';
    history.replaceState(null, '', `${window.location.pathname}${search}${window.location.hash}`);
  }
}

const PAGE_IDS = [
  // auth
  "login","role","profile","my","identity-account",
  // guide
  "guide-home","create-room","room-success","guide-live","end-result",
  "guest-list","guide-subtitle-record","kc-library","kc-detail","records","record-detail",
  "guide-subtitle-settings",
  // shared settings
  "notifications","help-feedback",
  // tourist pre-room
  "room-list","recent-rooms","password","tourist-my",
  // tourist in-room
  "listening","subtitle-tab","room-album","room-photo-detail","question","subtitle-settings",
  // cards & history
  "card-alert","card-library","card-detail","room-card-detail","subtitle-history",
  // legacy album
  "album","photo",
  // photographer
  "photographer-home","photographer-tasks","photo-join","photo-wait","photographer-album","photo-delete","photographer-my","upload",
  "photographer-storage","photographer-privacy","photographer-help",
] as const;

type PageId = typeof PAGE_IDS[number];

/** 各角色专属页集合（双向守卫） */
const GUIDE_ONLY_PAGES = new Set<string>([
  "guide-home","create-room","room-success","guide-live","end-result",
  "guest-list","guide-subtitle-record","kc-library","kc-detail","record-detail",
  "guide-subtitle-settings",
]);
const TOURIST_ONLY_PAGES = new Set<string>([
  "room-list","recent-rooms","password","tourist-my",
  "listening","subtitle-tab","room-album","room-photo-detail","question","subtitle-settings",
  "card-alert","subtitle-history",
]);
const GUIDE_TOURIST_SHARED_PAGES = new Set<string>([
  "card-library","card-detail","room-card-detail",
]);
const PHOTOGRAPHER_ONLY_PAGES = new Set<string>([
  "photographer-home","photographer-tasks","photo-join","photo-wait",
  "photographer-album","photo-delete","photographer-my","upload",
  "photographer-storage","photographer-privacy","photographer-help",
]);
/** 摄影师可只读访问的跨角色归档页。 */
const PHOTOGRAPHER_READONLY_SHARED_PAGES = new Set<string>([
  "subtitle-history",
]);

/**
 * 统一身份双向防御：给定目标页 id 和当前角色，返回安全的落地页。
 * - 导游访问 subtitle-settings → guide-subtitle-settings
 * - 摄影师访问导游/游客专属页 → photographer-tasks
 * - 导游访问摄影师专属页 → guide-home
 * - 游客访问摄影师专属页 → room-list
 * - photographer-home 统一重定向 → photographer-tasks
 * 同时用 history.replaceState 静默替换 hash（不新增历史记录）。
 */
function resolveHashWithRole(
  targetId: PageId,
  role: string | undefined | null,
  authenticated: boolean,
): PageId {
  // 未登录用户只能进入登录页，hash 不能绕过登录态。
  if (!authenticated && targetId !== 'login') {
    history.replaceState(null, '', '#login');
    return 'login';
  }
  // 已登录但尚未选择角色时，只允许完成注册流程。
  if (authenticated && !role && !['role', 'profile', 'login'].includes(targetId)) {
    history.replaceState(null, '', '#role');
    return 'role';
  }
  // photographer-home 已废弃入口，统一重定向到 photographer-tasks
  if (targetId === 'photographer-home') {
    history.replaceState(null, '', '#photographer-tasks');
    return 'photographer-tasks' as PageId;
  }
  // 导游访问游客字幕设置 → 导游字幕设置
  if (targetId === 'subtitle-settings' && role === 'guide') {
    history.replaceState(null, '', '#guide-subtitle-settings');
    return 'guide-subtitle-settings' as PageId;
  }
  // 摄影师访问导游专属页
  if (role === 'photographer' && GUIDE_ONLY_PAGES.has(targetId)) {
    history.replaceState(null, '', '#photographer-tasks');
    return 'photographer-tasks' as PageId;
  }
  // 摄影师访问游客专属页
  if (
    role === 'photographer' &&
    (TOURIST_ONLY_PAGES.has(targetId) || GUIDE_TOURIST_SHARED_PAGES.has(targetId)) &&
    !PHOTOGRAPHER_READONLY_SHARED_PAGES.has(targetId)
  ) {
    history.replaceState(null, '', '#photographer-tasks');
    return 'photographer-tasks' as PageId;
  }
  // 游客访问导游专属页
  if (role === 'tourist' && GUIDE_ONLY_PAGES.has(targetId)) {
    history.replaceState(null, '', '#room-list');
    return 'room-list';
  }
  // 导游访问游客专属页
  if (role === 'guide' && TOURIST_ONLY_PAGES.has(targetId)) {
    history.replaceState(null, '', '#guide-home');
    return 'guide-home';
  }
  // 导游访问摄影师专属页
  if (role === 'guide' && PHOTOGRAPHER_ONLY_PAGES.has(targetId)) {
    history.replaceState(null, '', '#guide-home');
    return 'guide-home' as PageId;
  }
  // 游客访问摄影师专属页
  if (role === 'tourist' && PHOTOGRAPHER_ONLY_PAGES.has(targetId)) {
    history.replaceState(null, '', '#room-list');
    return 'room-list' as PageId;
  }
  return targetId;
}

/** 根据已有的 user + profile 计算应跳转的首页 */
function resolveHomePage(
  user: ReturnType<typeof useAuth>["user"],
  profile: ReturnType<typeof useAuth>["profile"]
): PageId {
  if (!user) return "login";
  // 未选择角色 → 角色选择
  if (!profile?.role) return "role";
  // 未完善昵称（资料页未提交）→ 完善资料
  if (!profile?.nickname) return "profile";
  // 已完成注册 → 直接进首页
  if (profile.role === "guide") return "guide-home";
  if (profile.role === "photographer") return "photographer-tasks";
  return "room-list";
}

const PrototypePage: React.FC = () => {
  const { user, profile, loading, profileLoading, setCurrentRoom } = useAuth();
  const [current, setCurrent] = useState<PageId | null>(null); // null = 等待初始化
  // invite 初始化异步加载状态：初始为 true 以覆盖首次 useEffect 前的窗口，加载完成后置 false
  const [inviteLoading, setInviteLoading] = useState<boolean>(true);
  // 记录本次初始化是否由 invite 参数驱动（防止闪现其他页面）
  const inviteDriven = useRef(false);

  // 读取 URL hash（用于直接跳转调试）
  const hashPage = (): PageId | null => {
    const id = window.location.hash.replace("#", "") as PageId;
    return (PAGE_IDS as readonly string[]).includes(id) ? id : null;
  };

  // 初始化：等 loading 结束 + profile 加载完毕后决定起始页
  useEffect(() => {
    if (loading) return;          // auth session 还在读取中
    if (profileLoading) return;   // profile 还在异步加载中

    // ── 旧链接安全处理：移除 URL 中的明文密码参数 ──
    sanitizeUrlPassword();

    // ── 优先处理 invite 参数（分享链接深链接）──
    // 分享链接只帮助定位房间号，不绕过密码；统一跳到密码页由用户手动输入
    const urlInviteNumber = readInviteParam();

    // 未登录：保存房间号，跳转登录页，登录后由下面 pendingInvite 逻辑继续
    if (urlInviteNumber && !user) {
      sessionStorage.setItem(PENDING_INVITE_KEY, urlInviteNumber);
      inviteDriven.current = false;
      setInviteLoading(false);
      setCurrent('login');
      return;
    }

    const inviteNumber = urlInviteNumber ?? sessionStorage.getItem(PENDING_INVITE_KEY);

    if (inviteNumber) {
      // 摄影师身份：不进入游客流程，清理 pending 并跳自己首页
      if (profile?.role === 'photographer') {
        sessionStorage.removeItem(PENDING_INVITE_KEY);
        inviteDriven.current = false;
        setInviteLoading(false);
        setCurrent('photographer-tasks');
        return;
      }
      // 导游身份：不进入游客流程，清理 pending 并跳导游首页
      if (profile?.role === 'guide') {
        sessionStorage.removeItem(PENDING_INVITE_KEY);
        inviteDriven.current = false;
        setInviteLoading(false);
        setCurrent('guide-home');
        return;
      }
      // 已登录游客：查询房间，走统一入口路由（check_room_access）
      inviteDriven.current = true;
      setInviteLoading(true);
      fetchRoomByNumber(inviteNumber).then(async room => {
        setInviteLoading(false);
        sessionStorage.removeItem(PENDING_INVITE_KEY);
        if (!room) {
          setCurrent('room-list');
          return;
        }
        // 预设 currentRoom，resolveRoomEntry 需要 room.id
        setCurrentRoom(room);
        const { target } = await resolveRoomEntry(room.id);
        setCurrent(target);
      }).catch(() => {
        setInviteLoading(false);
        sessionStorage.removeItem(PENDING_INVITE_KEY);
        setCurrent('room-list');
      });
      return;
    }

    inviteDriven.current = false;
    setInviteLoading(false); // 非 invite 路径直接结束 loading
    let fromHash = hashPage();

    // 首次加载身份防御：统一处理导游/摄影师访问越权 hash
    if (fromHash) {
      fromHash = resolveHashWithRole(fromHash, profile?.role, Boolean(user));
    }

    if (fromHash) {
      setCurrent(fromHash);
    } else {
      setCurrent(resolveHomePage(user, profile));
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, profileLoading, user, profile]);

  // 监听 hash 变化（手动改 URL 调试用）
  useEffect(() => {
    const onHash = () => {
      const id = hashPage();
      if (!id) return;
      // 运行时身份防御：统一处理导游/摄影师访问越权 hash
      const safe = resolveHashWithRole(id, profile?.role, Boolean(user));
      // resolveHashWithRole 已用 replaceState 同步 hash，直接 setCurrent
      setCurrent(safe);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.role, user]);

  const go = (
    id: string,
    authOverride?: { authenticated: boolean; role?: string | null },
  ) => {
    // go() 也经过双向身份守卫，与 hash/hashchange 路径统一
    const safe = resolveHashWithRole(
      id as PageId,
      authOverride?.role ?? profile?.role,
      authOverride?.authenticated ?? Boolean(user),
    );
    setCurrent(safe);
    window.location.hash = safe;
  };

  // 等待初始化完成时显示全屏 loading
  if (loading || profileLoading || current === null || inviteLoading) {
    return (
      <main className="mobile-app" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ textAlign: "center", color: "var(--green)" }}>
          <div style={{ width: 40, height: 40, border: "3px solid currentColor", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 12px" }} />
          <span style={{ fontSize: 13, color: "var(--muted)" }}>加载中…</span>
        </div>
      </main>
    );
  }

  return (
    <main className="mobile-app" aria-label="拾光旅伴手机端 H5">
      <ScreenRouter id={current} go={go} />
    </main>
  );
};

/** 游客房间内页面集合：这些页面共享同一个 RoomRtcProvider，切换时不销毁重建 */
const TOURIST_IN_ROOM_PAGES = new Set([
  "listening", "subtitle-tab", "room-album", "room-photo-detail", "question",
  "subtitle-settings", "card-alert", "card-library", "card-detail",
  "room-card-detail", "subtitle-history",
]);

/** 已结束房间的只读内容页：允许游客查看，但不应重新建立 RTC/Presence 会话。 */
const TOURIST_ARCHIVE_PAGES = new Set([
  "subtitle-history", "room-album", "room-photo-detail",
]);

/**
 * 导游讲解中的工具页。
 *
 * GuideLive 在这些页面之间切换时始终保持挂载，避免卸载清理逻辑停止麦克风、
 * 百度 RTC/WebRTC 推流、流式识别与计时。工具页只覆盖显示，不接管讲解生命周期。
 */
const GUIDE_LIVE_TOOL_PAGES = new Set([
  "guide-live", "guest-list", "guide-subtitle-record", "card-library",
]);

function InRoomScreen({ id, go }: { id: string; go: (id: string) => void }) {
  switch (id) {
    case "listening":             return <Listening go={go} />;
    case "subtitle-tab":          return <SubtitleTab go={go} />;
    case "room-album":            return <RoomAlbumTab go={go} />;
    case "room-photo-detail":     return <RoomPhotoDetail go={go} />;
    case "question":              return <Question go={go} />;
    case "subtitle-settings":     return <SubtitleSettings go={go} />;
    case "card-alert":            return <CardAlert go={go} />;
    case "card-library":          return <TouristCardLibrary go={go} />;
    case "card-detail":           return <CardDetail go={go} />;
    case "room-card-detail":      return <RoomCardDetail go={go} />;
    case "subtitle-history":      return <SubtitleHistory go={go} />;
    default:                      return null;
  }
}

function GuideLiveToolScreen({
  id,
  go,
  snapshot,
}: {
  id: string;
  go: (id: string) => void;
  snapshot: GuideLiveSnapshot | null;
}) {
  switch (id) {
    case "guest-list":            return <GuestList go={go} initialMembers={snapshot?.members} presenceProvided />;
    case "guide-subtitle-record": return <GuideSubtitleRecord go={go} initialSubtitles={snapshot?.subtitles} />;
    case "card-library":          return <CardLibrary go={go} />;
    default:                      return null;
  }
}

/**
 * RoomRtcProvider 被提升到 switch 外层，与游客房间内页面生命周期解耦：
 * - 游客在房间内页面间切换时，Provider 不销毁重建，room-signal channel 保持稳定
 * - 离开游客房间内页面（go('room-list') 等）时，Provider unmount，channel 正常清理
 */
function ScreenRouter({ id, go }: { id: string; go: (id: string) => void }) {
  const { profile, currentRoom, user } = useAuth();
  const [guideLiveSnapshot, setGuideLiveSnapshot] = useState<GuideLiveSnapshot | null>(null);
  const handleGuideLiveSnapshot = React.useCallback((snapshot: GuideLiveSnapshot) => {
    setGuideLiveSnapshot(snapshot);
  }, []);
  const guideLiveTool = profile?.role === "guide" && GUIDE_LIVE_TOOL_PAGES.has(id);
  // 只有游客的房间内页面需要保持 RTC 容器；摄影师查看已结束房间的
  // 字幕/纪要属于只读归档链路，不应创建游客 RTC 会话。
  const touristRoomPage = profile?.role === "tourist" && TOURIST_IN_ROOM_PAGES.has(id);
  const archivedRoom = currentRoom?.status === "ended" || currentRoom?.status === "archived";
  const archivePage = touristRoomPage && archivedRoom && TOURIST_ARCHIVE_PAGES.has(id);
  const inRoom = touristRoomPage && !archivePage;

  if (guideLiveTool) {
    return (
      <RoomPresenceProvider
        roomId={currentRoom?.id ?? ""}
        userId={user?.id ?? ""}
        role="guide"
      >
        <GuideLive
          go={go}
          visible={id === "guide-live"}
          onSnapshot={handleGuideLiveSnapshot}
          presenceProvided
        />
        {id !== "guide-live" && (
          <GuideLiveToolScreen id={id} go={go} snapshot={guideLiveSnapshot} />
        )}
      </RoomPresenceProvider>
    );
  }

  if (profile?.role === "photographer" && id === "upload") {
    return (
      <RoomPresenceProvider
        roomId={currentRoom?.id ?? ""}
        userId={user?.id ?? ""}
        role="photographer"
      >
        <NonRoomScreen id={id} go={go} />
      </RoomPresenceProvider>
    );
  }

  return (
    <>
      {/* RoomRtcProvider 仅在游客房间内时挂载，且子页面切换时保持稳定不重建 */}
      {inRoom && (
        <RoomRtcProvider>
          <InRoomScreen id={id} go={go} />
        </RoomRtcProvider>
      )}
      {archivePage && <InRoomScreen id={id} go={go} />}
      {!inRoom && !archivePage && <NonRoomScreen id={id} go={go} />}
    </>
  );
}

function NonRoomScreen({ id, go }: { id: string; go: (id: string) => void }) {
  switch (id) {
    // ── 认证 ──
    case "login":                  return <Login go={go} />;
    case "role":                   return <RoleSelect go={go} />;
    case "identity-account":       return <IdentityAccount go={go} />;
    case "profile":                return <Profile go={go} />;
    case "my":                     return <MyPage go={go} />;
    // ── 导游端 ──
    case "guide-home":             return <GuideHome go={go} />;
    case "create-room":            return <CreateRoom go={go} />;
    case "room-success":           return <RoomSuccess go={go} />;
    case "guide-live":             return <GuideLive go={go} />;
    case "end-result":             return <EndResult go={go} />;
    case "guest-list":             return <GuestList go={go} />;
    case "guide-subtitle-record":  return <GuideSubtitleRecord go={go} />;
    case "kc-library":             return <KnowledgeCardLib go={go} />;
    case "kc-detail":              return <KnowledgeCardDetail go={go} />;
    case "records":                return <RecordsScreen go={go} />;
    case "record-detail":          return <RecordDetailScreen go={go} />;
    case "guide-subtitle-settings": return <SubtitleSettings go={go} returnTo="my" />;
    case "notifications":          return <NotificationsScreen go={go} />;
    case "help-feedback":          return <HelpFeedbackScreen go={go} />;
    // ── 游客入房前 ──
    case "room-list":              return <RoomList go={go} />;
    case "recent-rooms":           return <RecentRooms go={go} />;
    case "invite":
    case "invite-expired":
    case "password":               return <Password go={go} returnTo="room-list" />;
    case "tourist-my":             return <TouristMyPage go={go} />;
    // ── 跨角色只读归档 ──
    case "subtitle-history":       return <SubtitleHistory go={go} />;
    // ── 旧版相册兼容 ──
    case "album":                  return <Album go={go} />;
    case "photo":                  return <PhotoDetail go={go} />;
    // ── 摄影师端 ──
    case "photographer-home":      return <PhotographerTasks go={go} />;
    case "photographer-tasks":     return <PhotographerTasks go={go} />;
    case "photo-join":             return <PhotographerJoin go={go} />;
    case "photo-wait":             return <PhotographerWait go={go} />;
    case "photographer-album":     return <PhotographerAlbum go={go} />;
    case "photo-delete":           return <PhotoDeleteRequest go={go} />;
    case "photographer-my":        return <MyPage go={go} />;
    case "upload":                 return <Upload go={go} />;
    case "photographer-storage":   return <PhotographerStoragePage go={go} />;
    case "photographer-privacy":   return <PhotographerPrivacyPage go={go} />;
    case "photographer-help":      return <PhotographerHelpPage go={go} />;
    default:                       return null;
  }
}

export default PrototypePage;
