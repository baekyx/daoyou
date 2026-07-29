/**
 * 游客端扩展页面：
 * - RecentRooms  (V06/V07)  最近加入的房间 Tab
 * - TouristMyPage (V08)      游客「我的」
 * - SubtitleTab  (R02)       字幕 Tab（独立）
 * - WeakNetModal  (R08)       弱网重连
 * - RoomEndedOverlay (R09)   讲解已结束覆盖
 */
import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Landmark, Clock3, ChevronRight, Headphones, Languages, Radio,
  Star, Settings2, HelpCircle, LogOut, Shield, BookOpen, Edit3,
  Camera, Check, X, Bell, History, UserRound, Wifi, WifiOff,
  RefreshCw, AlignLeft, ChevronDown, ChevronUp,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/db/supabase';
import { fetchSubtitlesSafe } from '@/api/subtitles';
// joinRoom / hasJoinedRoom 已随邀请落地页一同移除，不再需要
import { resolveRoomEntry } from '@/api/roomActivity';
import type { Room, Subtitle, LanguageMode } from '@/types/types';
import { toast } from 'sonner';
import { BottomNav } from '@/pages/guide/GuideScreens';
import { AvatarCropModal } from '@/components/AvatarCropModal';
import { useAvatarUploadFlow, AVATAR_ACCEPT } from '@/hooks/useAvatarUploadFlow';
import { useTouristRoomCleanup } from '@/hooks/useTouristRoomCleanup';

interface Props { go: (id: string) => void }

// ─── 格式化日期 ───────────────────────────────────────
function fmtDate(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
}

// ─── 头像 ─────────────────────────────────────────────
function Avatar({ url, className = '' }: { url?: string | null; className?: string }) {
  if (url) return <img src={url} className={`avatar ${className}`} alt="头像" style={{ objectFit: 'cover' }} />;
  return <div className={`avatar ${className}`} />;
}

// ─── V06/V07 最近加入的房间 ───────────────────────────
export function RecentRooms({ go }: Props) {
  const { user, setCurrentRoom } = useAuth();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [enteringId, setEnteringId] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    supabase
      .from('memberships')
      .select('room_id, joined_at, rooms(*)')
      .eq('user_id', user.id)
      .order('joined_at', { ascending: false })
      .limit(20)
      .then(({ data }) => {
        const list = (data ?? []).map((m: Record<string, unknown>) => m.rooms as Room).filter(Boolean);
        setRooms(list);
        setLoading(false);
      });
  }, [user]);

  const handleEnter = async (room: Room) => {
    if (enteringId) return;
    setEnteringId(room.id);
    setCurrentRoom(room);
    const { target } = await resolveRoomEntry(room.id);
    setEnteringId(null);
    go(target);
  };

  return (
    <div className="screen padded-screen has-tabbar">
      <div className="section-heading">
        <span><History />最近记录</span>
        <h2>加入的房间</h2>
        <p>可重新进入有效房间，或回看字幕历史</p>
      </div>

      {loading ? (
        <div className="loading-state"><div className="spinner" /><span>加载中…</span></div>
      ) : rooms.length === 0 ? (
        <div className="empty-state">
          <Landmark size={40} className="empty-icon" />
          <p className="empty-title">还没有加入过房间</p>
          <small className="empty-desc">加入讲解房间后，历史记录会显示在这里</small>
          <button className="empty-action-btn" onClick={() => go('room-list')}>去找讲解房</button>
        </div>
      ) : (
        <div className="recent-room-list">
          {rooms.map(room => (
            <div key={room.id} className="recent-room-card">
              <div className="rec-room-cover-small">
                {room.cover_url
                  ? <img src={room.cover_url} alt={room.name} />
                  : <Landmark size={18} />
                }
              </div>
              <div className="recent-room-info">
                <span className="recent-room-name">{room.name}</span>
                <span className="recent-room-meta">
                  房间号 {room.room_number}
                </span>
                <span className="recent-room-status">
                  {room.status === 'live' ? <><Radio size={10} />讲解中</> : room.status === 'ended' ? '已结束' : '等待开始'}
                </span>
              </div>
              <button className="recent-enter-btn" disabled={!!enteringId} onClick={() => handleEnter(room)}>
                {enteringId === room.id
                  ? <span className="spinner-sm" />
                  : room.status === 'ended' ? <><BookOpen size={12} />回看</> : <><ChevronRight size={12} />进入</>}
              </button>
            </div>
          ))}
        </div>
      )}

      <BottomNav active="最近" go={go} variant="visitorHome" />
    </div>
  );
}

// ─── InviteLanding / InviteExpired 已废弃 ──────────────
// 邀请落地页已移除，所有分享链接统一跳密码页（Prototype.tsx 处理）。
// 保留空导出壳防止旧 import 引用编译报错（Prototype.tsx 已不再 import 这两个组件）。

// ─── R02 字幕 Tab（独立页面） ─────────────────────────
type FontSize = 'small' | 'medium' | 'large';
const fontSizeMap: Record<FontSize, number> = { small: 14, medium: 18, large: 22 };

export function SubtitleTab({ go }: Props) {
  const { currentRoom, subtitlePrefs } = useAuth();
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [mode, setMode] = useState<LanguageMode>(subtitlePrefs?.mode ?? 'bilingual');
  const [fontSize, setFontSize] = useState<FontSize>(subtitlePrefs?.fontSize ?? 'medium');
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = React.useRef<HTMLDivElement>(null);
  const scrollContainerRef = React.useRef<HTMLDivElement>(null);
  const userScrolledRef = React.useRef(false);

  useEffect(() => {
    if (!currentRoom) return;
    fetchSubtitlesSafe(currentRoom.id, 100).then(setSubtitles);
    // 复用 Listening 页面已有的 listening-cards channel 通过 shiguang-local-subtitle
    // CustomEvent 广播的字幕，不再单独开 subtitles Realtime channel，
    // 避免额外占用数据库连接配额（修复 DatabaseLackOfConnections）
    const onLocal = (e: Event) => {
      const subtitle = (e as CustomEvent<Subtitle>).detail;
      if (!subtitle || subtitle.room_id !== currentRoom.id) return;
      setSubtitles(prev => {
        const merged = [...prev.filter(item => item.id !== subtitle.id), subtitle];
        merged.sort((a, b) => {
          if (a.sequence != null && b.sequence != null) return a.sequence - b.sequence;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });
        return merged;
      });
    };
    window.addEventListener('shiguang-local-subtitle', onLocal);
    return () => { window.removeEventListener('shiguang-local-subtitle', onLocal); };
  }, [currentRoom?.id]);

  // 用户滚动检测：离底部 > 60px 视为主动上滑，暂停自动跟随
  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distFromBottom > 60) {
      userScrolledRef.current = true;
      setAutoScroll(false);
    } else {
      userScrolledRef.current = false;
      setAutoScroll(true);
    }
  }, []);

  // 新字幕到达时，只有 autoScroll 开启才滚到底
  useEffect(() => {
    if (autoScroll) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [subtitles, autoScroll]);

  const modeItems: [LanguageMode, string][] = [['cn', '中'], ['en', 'EN'], ['bilingual', '双语']];

  return (
    <div className="screen subtitle-tab-screen">
      {/* 顶栏 */}
      <div className="subtitle-tab-header">
        <span className="subtitle-tab-title">字幕</span>
        <div className="lang-seg-ctrl">
          {modeItems.map(([m, label]) => (
            <button key={m} className={mode === m ? 'active' : ''} onClick={() => setMode(m)}>{label}</button>
          ))}
        </div>
        <div className="subtitle-font-ctrl">
          {(['small', 'medium', 'large'] as FontSize[]).map((s, i) => (
            <button key={s} className={fontSize === s ? 'active' : ''} onClick={() => setFontSize(s)}
              style={{ fontSize: 10 + i * 2 }}>A</button>
          ))}
        </div>
      </div>

      {/* 字幕流 */}
      <div
        className="subtitle-tab-body"
        ref={scrollContainerRef}
        onScroll={handleScroll}
      >
        {subtitles.length === 0 ? (
          <div className="empty-state" style={{ paddingTop: 60 }}>
            <AlignLeft size={40} className="empty-icon" />
            <p className="empty-title">等待字幕</p>
            <small className="empty-desc">导游开始讲解后，字幕将实时出现在这里</small>
          </div>
        ) : subtitles.map(s => (
          <div key={s.id} className="subtitle-block">
            {(mode === 'cn' || mode === 'bilingual') && (
              <p className="st-cn" style={{ fontSize: fontSizeMap[fontSize] }}>{s.content_cn}</p>
            )}
            {(mode === 'en' || mode === 'bilingual') && (
              <p className="st-en" style={{ fontSize: fontSizeMap[fontSize] - 2 }}>
                {s.content_en ?? <span className="st-translating">Translating…</span>}
              </p>
            )}
            <span className="st-time">{new Date(s.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* 回到最新 按钮 */}
      {!autoScroll && (
        <button
          className="back-to-latest-btn"
          onClick={() => {
            setAutoScroll(true);
            userScrolledRef.current = false;
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
          }}
        >
          <ChevronDown size={14} />回到最新
        </button>
      )}

      {/* 自动滚动切换（保留原有按钮，用于强制切换） */}
      <button className="auto-scroll-btn" onClick={() => {
        setAutoScroll(p => {
          if (!p) bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
          return !p;
        });
      }}>
        {autoScroll ? <ChevronDown size={14} /> : <ChevronDown size={14} style={{ transform: 'rotate(180deg)' }} />}
        {autoScroll ? '自动滚动中' : '已暂停滚动'}
      </button>

      {/* 底部 Tab */}
      <BottomNav active="字幕" go={go} variant="room" />
    </div>
  );
}

// ─── R08 弱网重连 Modal ────────────────────────────────
interface WeakNetProps {
  onRetry: () => void;
  onSubtitleOnly: () => void;
  onClose: () => void;
}
export function WeakNetModal({ onRetry, onSubtitleOnly, onClose }: WeakNetProps) {
  return (
    <div className="modal-overlay">
      <div className="weaknet-modal">
        <WifiOff size={40} className="weaknet-icon" />
        <h3>语音连接不稳定</h3>
        <p>网络信号较弱，音频传输受影响。字幕和相册仍可正常查看。</p>
        <button className="primary-button green" onClick={onRetry}><RefreshCw size={14} />立即重试</button>
        <button className="text-button" onClick={onSubtitleOnly}>仅查看字幕</button>
        <button className="modal-close-small" onClick={onClose}>×</button>
      </div>
    </div>
  );
}

// ─── R09 讲解已结束覆盖（覆盖在语音Tab上方） ──────────
interface RoomEndedProps { go: (id: string) => void; endedAt?: string | null; }
export function RoomEndedOverlay({ go, endedAt }: RoomEndedProps) {
  return (
    <div className="room-ended-overlay">
      <div className="room-ended-card">
        <Headphones size={40} className="ended-icon" />
        <h3>讲解已结束</h3>
        {endedAt && <p className="ended-time">结束时间：{fmtDate(endedAt)}</p>}
        <p className="ended-desc">语音已停止，字幕记录和相册仍可查看</p>
        <button className="primary-button green" onClick={() => go('subtitle-history')}>
          <BookOpen size={14} />查看字幕回放
        </button>
        <button className="text-button" onClick={() => go('room-list')}>退出房间</button>
      </div>
    </div>
  );
}

// ─── V08 游客「我的」 ─────────────────────────────────
export function TouristMyPage({ go }: Props) {
  const { user, profile, signOut } = useAuth();
  const { performTouristCleanup } = useTouristRoomCleanup();
  const [showSignOut, setShowSignOut] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);

  // 头像上传共用 hook
  const { cropSrc, fileRef, handleFileChange, handleCropConfirm, handleCropClose } =
    useAvatarUploadFlow({ userId: user?.id });

  const handleSignOut = async () => {
    // 顺序：untrack Presence → leaveRoom(left_at) → setCurrentRoom(null) → signOut
    await performTouristCleanup();
    await signOut();
    go('login');
  };

  // 通用硬注销：复用 delete-account EF，不传 user_id
  const handleDeleteAccount = async () => {
    if (deleteBusy) return;
    setDeleteBusy(true);
    try {
      // 账号删除前先完成离线清理，确保 left_at 有值、Presence 人数立即归零
      await performTouristCleanup();

      const { error } = await supabase.functions.invoke('delete-account', { method: 'POST' });
      if (error) {
        const msg = await error?.context?.text?.();
        const parsed = (() => { try { return JSON.parse(msg ?? ''); } catch { return null; } })();
        toast.error(parsed?.error ?? '注销失败，请稍后重试');
        setDeleteBusy(false);
        return;
      }
      toast.success('账号已永久注销');
      [
        'shiguang-current-room',
        'shiguang-role',
        'shiguang-draft-feedback',
        'shiguang-upload-quality',
        'shiguang-wifi-only',
        'shiguang-cache-hint',
      ].forEach(k => { localStorage.removeItem(k); sessionStorage.removeItem(k); });
      await signOut();
      go('login');
    } catch {
      toast.error('注销请求失败，请检查网络后重试');
      setDeleteBusy(false);
    }
  };

  const langLabel: Record<string, string> = { cn: '中文', en: 'English', bilingual: '中英双语' };
  const defaultLang = (profile as unknown as Record<string,string>)?.default_language ?? 'bilingual';

  return (
    <div className="screen padded-screen has-tabbar my-page">
      <div className="mini-header"><span /><strong>我的</strong><span /></div>

      <div className="my-hero">
        <div className="my-avatar-wrap">
          <Avatar url={profile?.avatar_url} className="my-avatar" />
          <button className="my-avatar-edit" onClick={() => fileRef.current?.click()} aria-label="更换头像">
            <Camera size={14} />
          </button>
          <input ref={fileRef} type="file" accept={AVATAR_ACCEPT} hidden onChange={handleFileChange} />
        </div>
        <h2 className="my-name">{profile?.nickname ?? '游客'}</h2>
        <span className="my-role-tag tourist-tag"><UserRound size={13} />游客</span>
      </div>

      <div className="my-section-card">
        <button className="my-menu-item" onClick={() => go('subtitle-settings')}>
          <span className="my-menu-icon blue"><AlignLeft size={16} /></span>
          <span className="my-menu-label">字幕与翻译设置</span>
          <span className="my-menu-value">{langLabel[defaultLang]}</span>
          <ChevronRight size={16} className="my-menu-arrow" />
        </button>
        <button className="my-menu-item" onClick={() => go('subtitle-history')}>
          <span className="my-menu-icon green"><Star size={16} /></span>
          <span className="my-menu-label">我的收藏</span>
          <ChevronRight size={16} className="my-menu-arrow" />
        </button>
        <button className="my-menu-item" onClick={() => go('identity-account')}>
          <span className="my-menu-icon amber"><Settings2 size={16} /></span>
          <span className="my-menu-label">身份与账号</span>
          <ChevronRight size={16} className="my-menu-arrow" />
        </button>
        <button className="my-menu-item">
          <span className="my-menu-icon muted"><HelpCircle size={16} /></span>
          <span className="my-menu-label">帮助与反馈</span>
          <ChevronRight size={16} className="my-menu-arrow" />
        </button>
      </div>

      <button className="my-signout-btn" onClick={() => setShowSignOut(true)}>
        <LogOut size={16} />退出登录
      </button>

      {/* 注销账号：退出登录正下方，弱化红色文字入口 */}
      <div className="my-deactivate-area">
        <button
          className="my-deactivate-btn"
          onClick={() => setShowDeleteConfirm(true)}
        >
          注销账号
        </button>
      </div>

      <BottomNav active="我的" go={go} variant="visitorHome" />

      {showSignOut && (
        <div className="my-modal-overlay" onClick={() => setShowSignOut(false)}>
          <div className="my-confirm-modal" onClick={e => e.stopPropagation()}>
            <LogOut size={32} className="my-confirm-icon" />
            <h3>确认退出登录？</h3>
            <p>退出后需重新登录才能使用完整功能</p>
            <div className="my-confirm-actions">
              <button className="my-confirm-cancel" onClick={() => setShowSignOut(false)}>取消</button>
              <button className="my-confirm-ok" onClick={handleSignOut}>确认退出</button>
            </div>
          </div>
        </div>
      )}

      {/* 注销账号确认弹窗（游客，调用 delete-account EF 真实删除） */}
      {showDeleteConfirm && (
        <div className="my-modal-overlay" onClick={() => !deleteBusy && setShowDeleteConfirm(false)}>
          <div className="my-confirm-modal" onClick={e => e.stopPropagation()}>
            <History size={32} className="my-confirm-icon" />
            <h3>注销账号</h3>
            <p>注销后，账号、个人资料、房间记录和已上传内容将永久删除且无法恢复。</p>
            <div className="my-confirm-actions">
              <button
                className="my-confirm-cancel"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleteBusy}
              >取消</button>
              <button
                className="my-confirm-ok danger"
                onClick={handleDeleteAccount}
                disabled={deleteBusy}
              >{deleteBusy ? '注销中…' : '永久注销'}</button>
            </div>
          </div>
        </div>
      )}

      {/* 头像裁剪弹窗 */}
      {cropSrc && (
        <AvatarCropModal
          src={cropSrc}
          onConfirm={handleCropConfirm}
          onCancel={handleCropClose}
        />
      )}
    </div>
  );
}
