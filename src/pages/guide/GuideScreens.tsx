import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { buildInviteUrl } from '@/lib/inviteUrl';
import {
  UsersRound, Clock3, Landmark, CircleDot, ChevronRight, Plus,
  Languages, Share2, Check,
  Copy, LockKeyhole,
  Mic, MicOff, Square, Loader2, Radio, History, ImagePlus,
  Images, Headphones, LogOut, RefreshCw,
  AlertCircle, Eye, EyeOff, ChevronDown, Camera, CircleUserRound,
  DoorOpen, Captions,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import {
  fetchGuideRooms, fetchRoomById, createRoom, updateRoomStatus,
  updateRoomDuration, genPassword, fetchMyRoomPassword,
} from '@/api/rooms';
import { uploadRoomCoverBlob } from '@/api/roomCover';
import { RoomCoverCropModal } from '@/components/RoomCoverCropModal';
import { fetchBarrages, fetchQuestions } from '@/api/roomActivity';
import { fetchAllSubtitles, fetchSubtitlesSafe } from '@/api/subtitles';
import { fetchRoomMembersSafe } from '@/api/profiles';
import {
  processAudioChunk, processDemoAudioChunk, saveRecognizedText,
  attachSubtitleListener, subscribeWithFallback, waitForSubtitleEnrichment,
  type SubtitleChangeSource,
} from '@/lib/voiceApi';
import {
  startStreamingSpeech,
  type StreamingSpeechSession,
  type StreamingSpeechResult,
} from '@/lib/streamingSpeech';
import { useWebRTC } from '@/hooks/use-webrtc';
import { useBaiduRtc } from '@/hooks/use-baidu-rtc';
import { RoomPresenceProvider, useRoomPresence } from '@/hooks/use-room-presence';
import type { Barrage, Room, Question, RoomMember, Subtitle } from '@/types/types';
import { toast } from 'sonner';
import { supabase } from '@/db/supabase';
import { generateMeetingMinutes, saveMeetingMinutes } from '@/lib/meetingMinutes';
import { useAppLanguage } from '@/i18n/AppLanguageContext';
import { saveMeetingMinutesCloud } from '@/api/meetingMinutes';

interface Props { go: (id: string) => void }

const DEFAULT_ROOM_COVER_URL = 'https://miaoda-site-img.cdn.bcebos.com/images/baidu_image_search_1a8b8a77-d487-4258-b258-c6732fb5bac3.jpg';

export interface GuideLiveSnapshot {
  roomId: string;
  subtitles: Subtitle[];
  members: RoomMember[];
}

function normalizeStreamingText(text: string) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/([。！？!?，,；;：:])\1+/g, '$1')
    .trim();
}

function mergeStreamingText(previous: string, next: string) {
  const left = normalizeStreamingText(previous);
  const right = normalizeStreamingText(next);
  if (!left) return right;
  if (!right || left === right || left.endsWith(right)) return left;
  if (right.startsWith(left)) return right;

  const maxOverlap = Math.min(left.length, right.length);
  for (let size = maxOverlap; size >= 2; size -= 1) {
    if (left.slice(-size) === right.slice(0, size)) {
      return `${left}${right.slice(size)}`;
    }
  }
  const needsSpace = /[A-Za-z0-9]$/.test(left) && /^[A-Za-z0-9]/.test(right);
  return `${left}${needsSpace ? ' ' : ''}${right}`;
}

/** 讲解控制台只展示最新 50 条；完整记录由记录页分页读取。 */
function mergeLatestLiveSubtitles(current: Subtitle[], incoming: Subtitle[]): Subtitle[] {
  return Array.from(
    new Map([...current, ...incoming].map(item => [item.id, item])).values(),
  )
    .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    .slice(-50);
}

function formatToolBadgeCount(count: number): string {
  return count > 99 ? '99+' : String(Math.max(0, count));
}

function guideSubtitleSeenKey(roomId: string): string {
  return `shiguang-guide-subtitle-seen-${roomId}`;
}

function readGuideSubtitleSeenAt(roomId: string): number {
  try {
    return Math.max(0, Number(localStorage.getItem(guideSubtitleSeenKey(roomId)) ?? 0));
  } catch {
    return 0;
  }
}

// ─── 共享：当前导游活跃房间查询 Hook ──────────────────────
type ActiveRoomState =
  | { status: 'loading' }
  | { status: 'error'; retry: () => void }
  | { status: 'none' }
  | { status: 'active'; room: Room };

function useActiveRoom(guideId: string | undefined): ActiveRoomState {
  const [state, setState] = useState<ActiveRoomState>({ status: 'loading' });

  const load = useCallback(() => {
    if (!guideId) { setState({ status: 'none' }); return; }
    setState({ status: 'loading' });
    supabase
      .from('rooms')
      .select('*')
      .eq('guide_id', guideId)
      .in('status', ['pending', 'live'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data, error }) => {
        if (error) {
          setState({ status: 'error', retry: load });
        } else if (data) {
          setState({ status: 'active', room: data as Room });
        } else {
          setState({ status: 'none' });
        }
      });
  }, [guideId]);

  useEffect(() => { load(); }, [load]);

  return state;
}

// ─── 通用头像组件 ──────────────────────────────────────
function Avatar({ url, className = '' }: { url?: string | null; className?: string }) {
  if (url) {
    return <img src={url} className={`avatar ${className}`} alt="头像" style={{ objectFit: 'cover' }} />;
  }
  return <div className={`avatar ${className}`} />;
}
function Wave({ active = false }: { active?: boolean }) {
  const bars = [6, 13, 22, 12, 27, 17, 9, 20, 30, 18, 11, 24, 14, 7];
  return (
    <svg className={`wave ${active ? 'is-active' : ''}`} viewBox="0 0 96 32" fill="none" aria-hidden="true">
      {bars.map((h, i) => (
        <line key={i} x1={5 + i * 6.6} x2={5 + i * 6.6} y1={16 - h / 2} y2={16 + h / 2}
          stroke="currentColor" strokeWidth="3" strokeLinecap="round"
          style={{ animationDelay: `${i * -0.07}s`, animationDuration: `${0.58 + (i % 4) * 0.09}s` }} />
      ))}
    </svg>
  );
}

// ─── 导游首页 ─────────────────────────────────────────
/**
 * GuideHome 内层：已在 RoomPresenceProvider 内，可消费非导游在线成员数。
 * 当前活跃房间的"在线游客"统计来自 Presence，不再使用 rooms.online_count。
 */
function GuideHomeInner({ go }: Props) {
  const { user, profile, setCurrentRoom } = useAuth();
  const { participantCount } = useRoomPresence();
  const [rooms, setRooms] = useState<Room[]>([]);
  const [roomsLoading, setRoomsLoading] = useState(true);
  const activeRoomState = useActiveRoom(user?.id);

  useEffect(() => {
    if (!user) return;
    fetchGuideRooms(user.id).then(r => { setRooms(r); setRoomsLoading(false); });
  }, [user]);

  // 从共享 hook 得到活跃房间（单一来源）
  const activeRoom = activeRoomState.status === 'active' ? activeRoomState.room : null;
  const liveRoom = activeRoom?.status === 'live' ? activeRoom : null;
  const pendingRoom = activeRoom?.status === 'pending' ? activeRoom : null;
  const historyRooms = rooms.filter(r => r.status === 'ended' || r.status === 'archived').slice(0, 3);

  const isCheckingActive = activeRoomState.status === 'loading';
  const isActiveError = activeRoomState.status === 'error';

  // 两个入口共用：加载中禁用；有活跃房间则进控制台；否则去建房页
  const handleEnterOrCreate = () => {
    if (isCheckingActive || isActiveError) return;
    if (activeRoom) {
      setCurrentRoom(activeRoom);
      go('guide-live');
    } else {
      go('create-room');
    }
  };

  return (
    <div className="screen padded-screen has-tabbar guide-home-screen" style={{ paddingTop: 16 }}>
      <div className="guide-page-scroll">
      <div className="guide-hero">
        <div>
          <p>你好，{profile?.nickname ?? profile?.username ?? '导游'} 👋</p>
          <h1>我的讲解房</h1>
          <span>用声音传递文化，让旅程更有温度</span>
        </div>
        <div className="guide-portrait-crop" />
      </div>

      {/* 统计：在线游客来自 Presence（唯一真值），历史数据保留 */}
      <div className="stats-grid guide-stats">
        <div><span><UsersRound /></span><b>{activeRoom ? participantCount : 0}</b><small>在线成员</small></div>
        <div><span><Clock3 /></span><b>{rooms.filter(r => r.status !== 'pending').length}</b><small>历史房间</small></div>
        <div><span><Landmark /></span><b>{rooms.length}</b><small>累计创建</small></div>
      </div>

      {/* 当前房间 —— 加载中骨架 */}
      {isCheckingActive ? (
        <div className="current-room" style={{ opacity: 0.6 }}>
          <div className="guide-current-heading">
            <div className="guide-current-heading-copy">
              <span>当前房间</span>
              <h3>正在检查讲解状态</h3>
              <p>马上为你恢复最近的讲解进度。</p>
            </div>
            <b className="guide-room-state is-checking"><Loader2 size={13} className="spin-icon" />检查中</b>
          </div>
          <button className="primary-button green" disabled style={{ opacity: 0.5 }}>
            检查房间中…
          </button>
        </div>
      ) : isActiveError ? (
        <div className="current-room" style={{ textAlign: 'center', padding: '24px 0' }}>
          <p style={{ color: 'var(--muted)', marginBottom: 12 }}>
            <AlertCircle size={14} style={{ marginRight: 4, verticalAlign: 'middle' }} />
            房间状态加载失败
          </p>
          <button className="primary-button green" onClick={() => (activeRoomState as { retry: () => void }).retry()}>
            点击重试
          </button>
        </div>
      ) : liveRoom ? (
        <div className="current-room">
          <div className="guide-current-heading">
            <div className="guide-current-heading-copy">
              <span>当前房间</span>
              <h3>正在讲解的房间</h3>
              <p>房间正在进行，返回控制台继续本场讲解。</p>
            </div>
            <b className="guide-room-state is-live"><CircleDot />讲解中</b>
          </div>
          <div className="current-room-main">
            <div className="guide-room-photo" />
            <div>
              <h2>{liveRoom.name}</h2>
              <span>房间号</span><strong>{liveRoom.room_number}</strong>
              {/* 在线人数来自 Presence，不使用 online_count */}
              <p><UsersRound />{participantCount} 人在线</p>
            </div>
          </div>
          <button className="primary-button green" onClick={handleEnterOrCreate}>
            继续讲解<ChevronRight />
          </button>
        </div>
      ) : pendingRoom ? (
        <div className="current-room">
          <div className="guide-current-heading">
            <div className="guide-current-heading-copy">
              <span>当前房间</span>
              <h3>待开始的讲解房</h3>
              <p>房间已创建，准备好后即可开始本场讲解。</p>
            </div>
            <b className="guide-room-state is-pending">待开始</b>
          </div>
          <div className="current-room-main">
            <div className="guide-room-photo" />
            <div>
              <h2>{pendingRoom.name}</h2>
              <span>房间号</span><strong>{pendingRoom.room_number}</strong>
              {/* 在线人数来自 Presence，不使用 online_count */}
              <p><UsersRound />{participantCount} 人在线</p>
            </div>
          </div>
          <button className="primary-button green" onClick={handleEnterOrCreate}>
            开始讲解<ChevronRight />
          </button>
        </div>
      ) : !roomsLoading ? (
        <div className="current-room" style={{ textAlign: 'center', padding: '24px 0' }}>
          <p style={{ color: 'var(--muted)', marginBottom: 12 }}>暂无进行中的讲解房</p>
          <button className="primary-button green" onClick={handleEnterOrCreate}>
            <Plus />创建讲解房
          </button>
        </div>
      ) : null}

      {/* 历史记录 */}
      {historyRooms.length > 0 && (
        <>
          <div className="guide-history-heading">
            <div>
              <h3>历史讲解房</h3>
              <p>回顾已结束房间与会议纪要</p>
            </div>
            <button className="all-records-btn" onClick={() => go('records')}>查看全部 <ChevronRight size={14} /></button>
          </div>
          <div className="history-room-list">
            {historyRooms.map(r => (
              <div key={r.id}>
                <span className="history-photo history-photo-a" />
                <p>
                  <strong>{r.name}</strong>
                  <small>{r.room_number} · {r.online_count} 人</small>
                  {r.ended_at && <small><Clock3 />{new Date(r.ended_at).toLocaleString('zh-CN')}</small>}
                </p>
                <b>已结束</b>
              </div>
            ))}
          </div>
        </>
      )}
      </div>

      <BottomNav active="房间" go={go} variant="guide" />
    </div>
  );
}

/**
 * GuideHome 外层：挂载导游侧 Presence 订阅，仅订阅活跃房间的 tourist 人数，导游不 track。
 *
 * 关键修复（v375）：
 *   - 旧版传 currentRoom?.id，但 GuideHome 首次渲染时 currentRoom 通常为 null
 *     （导游尚未点击"进入"，setCurrentRoom 未调用），导致 Presence 一直订阅空 roomId，
 *     touristCount 永远为 0。
 *   - 新版：GuideHome 外层自行查询 activeRoom（共享 useActiveRoom hook），
 *     直接传 activeRoom.id，与内层 activeRoom 来源一致（单一 DB 查询，不重复）。
 *   - 无活跃房间时传 ''，Provider 内部 guard 跳过 channel 创建，零开销。
 *   - GuideLive / GuestList 的路由互斥性不变。
 */
export function GuideHome({ go }: Props) {
  const { user } = useAuth();
  const activeRoomState = useActiveRoom(user?.id);
  const activeRoom = activeRoomState.status === 'active' ? activeRoomState.room : null;
  return (
    <RoomPresenceProvider
      roomId={activeRoom?.id ?? ''}
      userId={user?.id ?? ''}
      role="guide"
    >
      <GuideHomeInner go={go} />
    </RoomPresenceProvider>
  );
}

// ─── 创建房间 ─────────────────────────────────────────
export function CreateRoom({ go }: Props) {
  const { user, setCurrentRoom } = useAuth();
  const [name, setName] = useState('');
  const [nameError, setNameError] = useState('');
  const [busy, setBusy] = useState(false);
  const [password, setPassword] = useState(() => genPassword());
  const [passwordVisible, setPasswordVisible] = useState(false);
  // 入口防御：复用共享 hook，不重复写业务判断
  const activeRoomState = useActiveRoom(user?.id);
  const [pwdError, setPwdError] = useState('');
  // 封面：已压缩的 JPEG Blob（由 RoomCoverCropModal 完成裁剪+压缩后交回）
  const [coverBlob, setCoverBlob] = useState<Blob | null>(null);
  const [coverPreview, setCoverPreview] = useState<string | null>(null);  // ObjectURL
  const [coverStatus, setCoverStatus] = useState<'idle' | 'uploading' | 'error'>('idle');
  const [coverErrorMsg, setCoverErrorMsg] = useState('');
  // 裁剪弹窗
  const [cropSrc, setCropSrc] = useState<string | null>(null);  // 原图 ObjectURL
  const coverInputRef = useRef<HTMLInputElement>(null);
  const pwdInputRef = useRef<HTMLInputElement>(null);

  // 卸载时 revoke 预览 ObjectURL
  useEffect(() => {
    return () => {
      if (coverPreview) URL.revokeObjectURL(coverPreview);
    };
  }, [coverPreview]);

  const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

  const handleCoverChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';  // 允许重复选同一文件
    if (!file) return;
    // 只校验类型是否可解码，不限制原图字节大小
    if (!ACCEPTED_TYPES.includes(file.type)) {
      if (file.type === 'image/heic' || file.type === 'image/heif' || file.name.toLowerCase().endsWith('.heic')) {
        setCoverErrorMsg('当前浏览器不支持 HEIC 格式，请转换为 JPG 或 PNG 后重试');
      } else {
        setCoverErrorMsg('仅支持 JPG、PNG、WebP 格式');
      }
      setCoverStatus('error');
      return;
    }
    setCoverErrorMsg('');
    setCoverStatus('idle');
    // 旧原图 ObjectURL 先 revoke，再创建新的
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(URL.createObjectURL(file));
  };

  // 裁剪完成回调：收到已压缩 JPEG Blob（< 4.8 MiB）
  const handleCropConfirm = useCallback((blob: Blob) => {
    // revoke 旧预览
    if (coverPreview) URL.revokeObjectURL(coverPreview);
    const preview = URL.createObjectURL(blob);
    setCoverBlob(blob);
    setCoverPreview(preview);
    setCoverStatus('idle');
    // 裁剪完成后 revoke 原图 ObjectURL
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(null);
  }, [coverPreview, cropSrc]);

  // 裁剪取消回调
  const handleCropCancel = useCallback(() => {
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    setCropSrc(null);
  }, [cropSrc]);

  const validateName = (val: string) => {
    const trimmed = val.trim();
    if (!trimmed) return '房间名称不能为空';
    if (trimmed.length > 20) return '房间名称最多20个字符';
    return '';
  };

  const handleCreate = async () => {
    const trimmedName = name.trim();
    const err = validateName(trimmedName);
    if (err) { setNameError(err); return; }
    if (!/^\d{6}$/.test(password)) { setPwdError('密码须为6位数字'); return; }
    if (!user) return;
    if (busy) return; // 防双击
    setBusy(true);
    const { room, error, existed } = await createRoom({ name: trimmedName, guide_id: user.id, password });
    if (error || !room) {
      setBusy(false);
      toast.error('创建失败：' + (error ?? '未知错误'));
      return;
    }
    // existed=true：已有活跃房间（并发穿透/边界情况），直接进控制台，不显示成功页
    if (existed) {
      setBusy(false);
      toast('你已有待开始或进行中的讲解房，已为你跳转', { icon: '💡' });
      setCurrentRoom(room);
      go('guide-live');
      return;
    }
    // existed=false：真正新建成功，上传封面后 → 成功页
    let finalRoom = room;
    if (coverBlob) {
      setCoverStatus('uploading');
      const coverUrl = await uploadRoomCoverBlob(user.id, room.id, coverBlob);
      if (coverUrl) {
        const persistCover = () => supabase
          .from('rooms')
          .update({ cover_url: coverUrl })
          .eq('id', room.id)
          .eq('guide_id', user.id)
          .select('id,cover_url')
          .maybeSingle();
        let { data: coverRoom, error: coverDbError } = await persistCover();
        if (coverDbError || !coverRoom) {
          // 网络瞬时失败只重试一次；仍失败则保持数据库返回的默认封面状态。
          ({ data: coverRoom, error: coverDbError } = await persistCover());
        }
        if (coverDbError || !coverRoom?.cover_url) {
          setCoverStatus('error');
          setCoverErrorMsg('房间已创建，但封面保存失败，已使用默认封面');
          toast.warning('房间已创建，但封面未保存成功');
        } else {
          finalRoom = { ...room, cover_url: coverRoom.cover_url };
          setCoverStatus('idle');
        }
      } else {
        setCoverStatus('error');
        setCoverErrorMsg('封面上传失败，已使用默认封面');
      }
    }
    setBusy(false);
    setCurrentRoom(finalRoom);
    // 记录本次新建标记，供成功页守卫验证
    sessionStorage.setItem('shiguang-created-room-id', finalRoom.id);
    // A2 预置：密码只在本次创建流程的 sessionStorage 中临时保存（绑定 room_id）
    // 不从 DB 读取；成功页离开时清理
    sessionStorage.setItem(`shiguang-room-pwd-${finalRoom.id}`, password);
    go('room-success');
  };

  // ── 加载中 ──
  if (activeRoomState.status === 'loading') {
    return (
      <div className="screen padded-screen">
        <div className="mini-header">
          <button className="back-button" onClick={() => go('guide-home')} aria-label="返回">
            <span className="back-chevron" />
          </button>
          <strong>创建讲解房</strong>
          <span />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 200, color: 'var(--muted)', fontSize: 13 }}>
          <Loader2 size={16} className="spin-icon" style={{ marginRight: 8 }} />检查房间中…
        </div>
      </div>
    );
  }

  // ── 加载失败 ──
  if (activeRoomState.status === 'error') {
    return (
      <div className="screen padded-screen">
        <div className="mini-header">
          <button className="back-button" onClick={() => go('guide-home')} aria-label="返回">
            <span className="back-chevron" />
          </button>
          <strong>创建讲解房</strong>
          <span />
        </div>
        <div style={{ margin: '60px 0', textAlign: 'center' }}>
          <AlertCircle size={32} style={{ color: 'var(--muted)', marginBottom: 12 }} />
          <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 20 }}>房间状态加载失败，请重试</p>
          <button className="primary-button green" style={{ width: '100%' }} onClick={activeRoomState.retry}>
            重新加载
          </button>
          <button className="primary-button" style={{ width: '100%', marginTop: 10, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--line)' }} onClick={() => go('guide-home')}>
            返回首页
          </button>
        </div>
      </div>
    );
  }

  // ── 已有活跃房间拦截 ──
  if (activeRoomState.status === 'active') {
    const existingRoom = activeRoomState.room;
    const isLive = existingRoom.status === 'live';
    return (
      <div className="screen padded-screen">
        <div className="mini-header">
          <button className="back-button" onClick={() => go('guide-home')} aria-label="返回">
            <span className="back-chevron" />
          </button>
          <strong>创建讲解房</strong>
          <span />
        </div>
        <div style={{ margin: '40px 0', textAlign: 'center' }}>
          <div className="success-mark" style={{ margin: '0 auto 16px', background: isLive ? 'var(--green)' : 'var(--amber)' }}>
            {isLive ? <CircleDot size={28} /> : <Clock3 size={28} />}
          </div>
          <h2 style={{ fontSize: 18, margin: '0 0 8px' }}>
            {isLive ? '你有一个讲解中的房间' : '你有一个待开始的房间'}
          </h2>
          <p style={{ color: 'var(--muted)', fontSize: 13, margin: '0 0 24px' }}>
            同一时间只能有一个进行中的讲解房。<br />
            请先进入现有房间，或结束后再新建。
          </p>
          <div className="success-room-card" style={{ textAlign: 'left', marginBottom: 16 }}>
            <div className="success-room-info" style={{ padding: '14px 16px' }}>
              <div style={{ flex: 1 }}>
                <p style={{ margin: '0 0 4px', fontSize: 12, color: 'var(--muted)' }}>
                  {isLive ? '讲解中' : '待开始'} · 房间号 {existingRoom.room_number}
                </p>
                <h3 style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>{existingRoom.name}</h3>
              </div>
            </div>
          </div>
          <button
            className="primary-button green"
            style={{ width: '100%' }}
            onClick={() => { setCurrentRoom(existingRoom); go('guide-live'); }}
          >
            {isLive ? '继续讲解' : '开始讲解'}<ChevronRight size={16} />
          </button>
          <button
            className="primary-button"
            style={{ width: '100%', marginTop: 10, background: 'var(--surface)', color: 'var(--text)', border: '1px solid var(--line)' }}
            onClick={() => go('guide-home')}
          >
            返回首页
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen padded-screen guide-create-screen">
      <div className="mini-header">
        <button className="back-button" onClick={() => go('guide-home')} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>创建讲解房</strong>
        <span />
      </div>

      {/* ── 1. 房间封面（唯一入口，16:9 横向预览）── */}
      <div className="cr-section-card">
        <b className="cr-label">房间封面<span className="cr-optional">选填</span></b>
        <div className="cr-cover-area" onClick={() => !busy && coverInputRef.current?.click()}>
          {coverPreview
            ? <img src={coverPreview} className="cr-cover-img" alt="封面预览" />
            : <div className="cr-cover-default">
                <div className="cr-cover-default-overlay">
                  <ImagePlus size={20} />
                  <span>点击上传封面</span>
                </div>
              </div>
          }
          {/* 右下角融合按钮 */}
          <button
            className="cr-cover-btn"
            type="button"
            onClick={e => { e.stopPropagation(); if (!busy) coverInputRef.current?.click(); }}
          >
            {coverStatus === 'uploading'
              ? <><Loader2 size={12} className="spin" />上传中…</>
              : coverPreview ? '更换封面' : '上传封面'
            }
          </button>
          <input
            ref={coverInputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            style={{ display: 'none' }}
            onChange={handleCoverChange}
          />
        </div>
        {coverStatus === 'error' && (
          <p className="cr-field-error">
            {coverErrorMsg}
            {coverErrorMsg.includes('失败') && (
              <button className="cr-retry-btn" onClick={() => { setCoverStatus('idle'); setCoverErrorMsg(''); coverInputRef.current?.click(); }}>
                重试
              </button>
            )}
          </p>
        )}
        <p className="cr-field-hint">支持 JPG、PNG、WebP；未上传时使用默认封面</p>
      </div>

      {/* ── 2. 房间名称 ── */}
      <div className="cr-section-card">
        <b className="cr-label">房间名称<span className="cr-required">必填</span></b>
        <div className="cr-input-wrap">
          <input
            className={`cr-input${nameError ? ' cr-input-error' : ''}`}
            placeholder="请输入房间名称，最多20个字符"
            value={name}
            maxLength={20}
            onChange={e => { setName(e.target.value); if (nameError) setNameError(validateName(e.target.value.trim())); }}
            onBlur={() => setNameError(validateName(name.trim()))}
          />
          <span className={`cr-counter${name.trim().length >= 20 ? ' cr-counter-max' : ''}`}>{name.trim().length}/20</span>
        </div>
        {nameError && <p className="cr-field-error">{nameError}</p>}
      </div>

      {/* ── 3. 房间密码 ── */}
      <div className="cr-section-card">
        <div className="cr-pwd-label-row">
          <b className="cr-label" style={{ marginBottom: 0 }}>房间密码<span className="cr-required">必填</span></b>
          <div className="cr-pwd-actions">
            <button
              className="cr-pwd-visibility"
              onClick={() => setPasswordVisible(value => !value)}
              type="button"
              aria-label={passwordVisible ? '隐藏房间密码' : '显示房间密码'}
            >
              {passwordVisible ? <EyeOff size={14} /> : <Eye size={14} />}
            </button>
            <button
              className="cr-pwd-refresh-pill"
              onClick={() => { setPassword(genPassword()); setPwdError(''); }}
              type="button"
            ><RefreshCw size={11} />随机生成</button>
          </div>
        </div>
        <div className="create-code-row" style={{ marginTop: 12 }} onClick={() => pwdInputRef.current?.focus()}>
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} className={password[i] ? 'filled' : ''}>
              {password[i] ? (passwordVisible ? password[i] : '•') : ''}
            </span>
          ))}
        </div>
        <input
          ref={pwdInputRef}
          className="create-pwd-real-input"
          value={password}
          maxLength={6}
          inputMode="numeric"
          pattern="\d{6}"
          onChange={e => { setPassword(e.target.value.replace(/\D/g, '')); setPwdError(''); }}
          aria-label="房间密码"
        />
        {pwdError && <p className="cr-field-error">{pwdError}</p>}
        <p className="cr-field-hint">游客需输入六位数字密码进入房间</p>
      </div>

      {/* ── 4. 隐私说明 ── */}
      <div className="cr-privacy-card">
        <div className="cr-privacy-icon"><LockKeyhole size={15} /></div>
        <div className="cr-privacy-body">
          <p>仅持正确密码的游客可进入，房间内容不会公开展示或用于其他用途。</p>
        </div>
      </div>

      {/* ── 5. 创建按钮 ── */}
      <button className="primary-button green" onClick={handleCreate} disabled={busy}>
        {busy ? <><Loader2 size={16} className="spin" />正在创建…</> : '创建房间'}
      </button>

      {/* 裁剪弹窗：选中原图后由 RoomCoverCropModal 完成裁剪+压缩 */}
      {cropSrc && (
        <RoomCoverCropModal
          src={cropSrc}
          onConfirm={handleCropConfirm}
          onCancel={handleCropCancel}
        />
      )}
    </div>
  );
}

// ─── 创建成功 ─────────────────────────────────────────
export function RoomSuccess({ go }: Props) {
  const { user, profile, currentRoom, setCurrentRoom } = useAuth();
  const [roomData, setRoomData] = useState<Room | null>(null);
  const [guardDone, setGuardDone] = useState(false);
  // A2 预置：密码只从 sessionStorage 本次创建流程的临时值读取，不从 room.password 读
  const [displayPwd, setDisplayPwd] = useState('');

  // 路由守卫：验证 createdRoomId 标记 + 登录 + 归属
  useEffect(() => {
    const createdId = sessionStorage.getItem('shiguang-created-room-id');
    if (!createdId || !user) {
      go('guide-home');
      return;
    }
    // fetchRoomById 恢复最新真实数据（支持刷新），返回不含 password
    fetchRoomById(createdId).then(room => {
      if (!room || room.guide_id !== user.id) {
        go('guide-home');
        return;
      }
      setCurrentRoom(room);
      setRoomData(room);
      // 从 sessionStorage 读取本次创建时保存的密码临时值（绑定 room_id）
      const savedPwd = sessionStorage.getItem(`shiguang-room-pwd-${createdId}`) ?? '';
      setDisplayPwd(savedPwd);
      setGuardDone(true);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // 离开成功页时清除标记和密码临时值
  const clearCreatedMark = () => {
    const createdId = sessionStorage.getItem('shiguang-created-room-id');
    if (createdId) sessionStorage.removeItem(`shiguang-room-pwd-${createdId}`);
    sessionStorage.removeItem('shiguang-created-room-id');
    window.location.hash = '';
  };

  const handleGoHome = () => {
    clearCreatedMark();
    go('guide-home');
  };

  const handleEnter = () => {
    clearCreatedMark();
    // 直接进控制台，保持 pending 状态，不调 updateRoomStatus
    go('guide-live');
  };

  // 邀请链接不含密码，游客仍须输入密码；统一使用正式域名
  const inviteUrl = roomData ? buildInviteUrl(roomData.room_number) : '';

  const copyText = (text: string) =>
    navigator.clipboard.writeText(text)
      .then(() => toast.success('已复制'))
      .catch(() => {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        document.execCommand('copy'); document.body.removeChild(ta);
        toast.success('已复制');
      });

  const handleShare = async () => {
    if (!roomData) return;
    const shareText = `我正在「${roomData.name}」进行讲解导览，快来加入吧！\n房间号：${roomData.room_number}\n打开链接后需输入房间密码加入：${inviteUrl}`;
    const shareData = { title: `邀请你加入「${roomData.name}」讲解`, text: shareText, url: inviteUrl };
    if (navigator.share) {
      try {
        await navigator.share(shareData);
        return;
      } catch (e) {
        // 用户取消不提示；其他错误降级
        if (e instanceof Error && e.name === 'AbortError') return;
      }
    }
    // 降级：复制邀请链接
    const fallback = inviteUrl;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(fallback)
        .then(() => toast.success('邀请链接已复制到剪贴板'))
        .catch(() => {
          const ta = document.createElement('textarea');
          ta.value = fallback; document.body.appendChild(ta); ta.select();
          document.execCommand('copy'); document.body.removeChild(ta);
          toast.success('邀请链接已复制');
        });
    } else {
      const ta = document.createElement('textarea');
      ta.value = fallback; document.body.appendChild(ta); ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      if (ok) toast.success('邀请链接已复制');
      else toast.error('复制失败，请手动复制房间号');
    }
  };

  // 守卫未完成时不渲染（useEffect 会跳转，不会停留）
  if (!guardDone || !roomData) return null;

  // 已通过守卫的 currentRoom 与 roomData 同步
  const room = roomData;

  return (
    <div className="screen padded-screen success-screen">
      <div className="mini-header">
        <button className="back-button" onClick={handleGoHome} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>创建成功</strong>
        <span />
      </div>

      <section className="success-intro" aria-labelledby="room-created-title">
        <div className="success-mark-wrap">
          <span className="success-mark"><Check /></span>
          <i /><i /><i />
        </div>
        <h2 id="room-created-title">房间创建成功</h2>
        <p>游客可通过房间号或分享链接加入，对方打开后需输入房间密码</p>
      </section>

      <div className="success-room-card">
        {/* 房间封面 16:9 */}
        <div className="success-room-cover-wrap">
          <img
            src={room.cover_url || DEFAULT_ROOM_COVER_URL}
            className="success-room-cover-img"
            alt={`${room.name}房间封面`}
          />
        </div>
        {/* 导游信息 */}
        <div className="success-room-info">
          <Avatar url={profile?.avatar_url} className="success-guide-avatar" />
          <div>
            <p className="success-guide-name">{profile?.nickname ?? '导游'}</p>
            <h3>{room.name}</h3>
          </div>
        </div>
        {/* 房间号 + 密码（从本次创建流程 sessionStorage 读取，不从 DB 读） */}
        <div className="success-secret">
          <p>
            <span><Landmark size={14} />房间号</span>
            <strong className="success-room-number">{room.room_number}</strong>
          </p>
          <p>
            <span><LockKeyhole size={14} />房间密码</span>
            <strong className="success-pwd-digits">{displayPwd || '——'}</strong>
          </p>
        </div>
      </div>

      {/* 操作按钮组 */}
      <div className="success-actions">
        <button onClick={handleShare}>
          <Share2 size={14} /><span>分享房间链接</span>
        </button>
        {/* 只复制真实 room_number */}
        <button onClick={() => copyText(room.room_number)}>
          <Copy size={14} /><span>复制房间号</span>
        </button>
      </div>

      <button className="primary-button green" onClick={handleEnter}>
        进入讲解控制台
      </button>
    </div>
  );
}

// ─── 讲解控制台 ────────────────────────────────────────
function GuideLiveInner({
  go,
  visible = true,
  onSnapshot,
}: Props & {
  visible?: boolean;
  onSnapshot?: (snapshot: GuideLiveSnapshot) => void;
}) {
  const { user, profile, currentRoom, setCurrentRoom } = useAuth();
  const [members, setMembers] = useState<RoomMember[]>([]);
  // 游客列表包含游客与摄影师，因此控制台统一使用非导游在线人数。
  const { participantCount } = useRoomPresence();
  const [questions, setQuestions] = useState<Question[]>([]);
  const [barrages, setBarrages] = useState<Barrage[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [accumulatedMs, setAccumulatedMs] = useState(0);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [endBusy, setEndBusy] = useState(false);
  const [generateMinutesOnEnd, setGenerateMinutesOnEnd] = useState(true);
  const [pushedCount, setPushedCount] = useState(0);
  // Realtime 同步状态文案（'ok' | 'degraded'）
  const [realtimeSyncStatus, setRealtimeSyncStatus] = useState<'ok' | 'degraded'>('ok');

  // 房间密码：优先 sessionStorage 缓存，缺失时调用 get_my_room_password RPC
  const [roomPwd, setRoomPwd] = useState<string>('');
  const [pwdVisible, setPwdVisible] = useState(false);
  const [pwdStatus, setPwdStatus] = useState<'loading' | 'ok' | 'error'>('loading');

  // ─── 切片时长常量（单一真值，注释/实现保持一致） ───────────────────
  const AUDIO_SLICE_MS = 3000;
  const [isLive, setIsLive] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [processingCount, setProcessingCount] = useState(0);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [unreadSubtitleCount, setUnreadSubtitleCount] = useState(0);
  const knownSubtitleIdsRef = useRef<Set<string>>(new Set());
  const subtitleSeenAtRef = useRef(0);
  const unreadSubtitleRevisionRef = useRef(0);
  const [liveDraft, setLiveDraft] = useState('');
  const [asrMode, setAsrMode] = useState<'connecting' | 'streaming' | 'chunked'>('connecting');
  const [voiceError, setVoiceError] = useState('');
  const [audioTransportMode, setAudioTransportMode] =
    useState<'idle' | 'baidu' | 'direct' | 'failed'>('idle');
  const [audioTransportDetail, setAudioTransportDetail] = useState('');
  const [micPerm, setMicPerm] = useState<'checking' | 'granted' | 'denied' | 'unknown'>('checking');
  const streamRef = useRef<MediaStream | null>(null);
  const isLiveRef = useRef(false);
  const audioTransportWantedRef = useRef(false);
  const sessionStartedAtRef = useRef<number | null>(null);
  const accumulatedMsRef = useRef(0);
  const lastClockPersistAtRef = useRef(0);
  const lastDurationSyncMinuteRef = useRef(0);
  const cycleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeMrRef = useRef<MediaRecorder | null>(null);
  const streamingSessionRef = useRef<StreamingSpeechSession | null>(null);
  const streamingFinalTasksRef = useRef<Set<Promise<unknown>>>(new Set());
  const pendingStreamingFinalRef = useRef<{ roomId: string; text: string } | null>(null);
  const pendingStreamingFinalTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenStreamingFinalKeysRef = useRef<Map<string, number>>(new Map());
  const subtitleBroadcastRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useEffect(() => {
    if (!currentRoom) return;
    onSnapshot?.({
      roomId: currentRoom.id,
      subtitles,
      members,
    });
  }, [currentRoom?.id, members, onSnapshot, subtitles]);

  const publishLiveDraft = useCallback((roomId: string, text: string) => {
    setLiveDraft(text);
    const channel = subtitleBroadcastRef.current;
    if (roomId !== 'demo-room' && channel) {
      void channel.send({
        type: 'broadcast',
        event: 'subtitle-draft',
        payload: { room_id: roomId, text, updated_at: Date.now() },
      });
    }
  }, []);

  const persistStreamingFinal = useCallback((roomId: string, text: string) => {
    const task = (async () => {
      setProcessingCount(n => n + 1);
      try {
        await saveRecognizedText(roomId, text);
      } catch (error) {
        console.error('[Streaming ASR] 最终字幕保存失败:', error);
        setVoiceError('流式字幕已识别，但保存失败，请检查字幕服务');
      } finally {
        setProcessingCount(n => Math.max(0, n - 1));
      }
    })();
    streamingFinalTasksRef.current.add(task);
    void task.finally(() => streamingFinalTasksRef.current.delete(task));
    return task;
  }, []);

  const flushPendingStreamingFinal = useCallback((roomId?: string) => {
    const pending = pendingStreamingFinalRef.current;
    if (!pending || (roomId && pending.roomId !== roomId)) return Promise.resolve();
    if (pendingStreamingFinalTimerRef.current) {
      clearTimeout(pendingStreamingFinalTimerRef.current);
      pendingStreamingFinalTimerRef.current = null;
    }
    pendingStreamingFinalRef.current = null;
    publishLiveDraft(pending.roomId, '');
    return persistStreamingFinal(pending.roomId, pending.text);
  }, [persistStreamingFinal, publishLiveDraft]);

  const queueStreamingFinal = useCallback((
    roomId: string,
    result: StreamingSpeechResult,
  ) => {
    const text = normalizeStreamingText(result.text);
    if (!text) return;

    const now = Date.now();
    const finalKey = `${result.startTime ?? 'na'}:${result.endTime ?? 'na'}:${text}`;
    for (const [key, seenAt] of seenStreamingFinalKeysRef.current) {
      if (now - seenAt > 30_000) seenStreamingFinalKeysRef.current.delete(key);
    }
    // WebSocket 重连或 FINISH 收尾时可能重放相同 FIN_TEXT，只保存一次。
    if (seenStreamingFinalKeysRef.current.has(finalKey)) return;
    seenStreamingFinalKeysRef.current.set(finalKey, now);

    const pending = pendingStreamingFinalRef.current;
    if (pending && pending.roomId !== roomId) {
      void flushPendingStreamingFinal(pending.roomId);
    }
    const previous = pending?.roomId === roomId ? pending.text : '';
    const merged = mergeStreamingText(previous, text);
    pendingStreamingFinalRef.current = { roomId, text: merged };
    publishLiveDraft(roomId, merged);

    if (pendingStreamingFinalTimerRef.current) {
      clearTimeout(pendingStreamingFinalTimerRef.current);
    }
    // 给连续 FIN_TEXT 一个很短的合并窗口，避免一句话被拆成多张残缺卡片。
    // 短片段多等一点，完整长句仍能快速落库。
    const meaningfulLength = merged.replace(/[^\p{L}\p{N}]/gu, '').length;
    const delay = meaningfulLength <= 6 ? 1_400 : 650;
    pendingStreamingFinalTimerRef.current = setTimeout(() => {
      pendingStreamingFinalTimerRef.current = null;
      void flushPendingStreamingFinal(roomId);
    }, delay);
  }, [flushPendingStreamingFinal, publishLiveDraft]);

  /**
   * lastStopFlushRef — 解决 stop→onstop 异步竞态。
   *
   * 每次主动停止 MediaRecorder（暂停/结束）时，先将一个 Promise 存入此 ref，
   * 并在 onstop 完成 enqueueAsr 后 resolve。
   * handleStop / handleEndSession 通过 await lastStopFlushRef.current 确保
   * 最后一段 Blob 已进入 FIFO，再 await waitQueueDrain() 排空。
   */
  const lastStopFlushRef = useRef<Promise<void>>(Promise.resolve());
  const lastStopFlushResolveRef = useRef<(() => void) | null>(null);

  // ─── FIFO ASR 串行队列 ────────────────────────────────────────────
  // 每个录音切片产生一个任务函数入队；处理器从队头逐个执行，禁止并发。
  type AsrTask = () => Promise<void>;
  const asrQueueRef = useRef<AsrTask[]>([]);
  const processorRunningRef = useRef(false);

  /** 取队头任务依次执行，直到队列为空；单段失败只跳过不阻塞。 */
  const runAsrQueue = useCallback(async () => {
    if (processorRunningRef.current) return;
    processorRunningRef.current = true;
    while (asrQueueRef.current.length > 0) {
      const task = asrQueueRef.current.shift()!;
      try { await task(); } catch (err) {
        console.error('[ASR Queue] 切片处理失败，跳过:', err);
      }
    }
    processorRunningRef.current = false;
  }, []);

  /** 将一个音频 Blob 推入 FIFO 队列并驱动处理器。 */
  const enqueueAsr = useCallback((roomId: string, blob: Blob, mimeType: string) => {
    const task: AsrTask = async () => {
      setProcessingCount(n => n + 1);
      try {
        console.log(`[ASR] ASR 请求开始 | size=${blob.size} mime=${mimeType}`);
        await (roomId === 'demo-room'
          ? processDemoAudioChunk(roomId, blob)
          : processAudioChunk(roomId, blob));
      } catch (err) {
        console.error('音频处理失败:', err);
        const msg = err instanceof Error && err.message.includes('推流')
          ? '麦克风推流启动失败，请刷新页面重试'
          : '字幕生成失败，请检查语音服务';
        setVoiceError(msg);
      } finally {
        setProcessingCount(n => Math.max(0, n - 1));
      }
    };
    asrQueueRef.current.push(task);
    void runAsrQueue();
    void mimeType; // 保留参数供日志扩展使用
  }, [runAsrQueue]);

  // 景点卡片快捷推送面板（已移除，点击直接跳转卡片库）

  // WebRTC（导游是 owner）— initSignaling 现在返回 { unsub, waitSubscribed }
  const {
    initSignaling,
    startMic: startDirectMic,
    stopMic: stopDirectMic,
  } = useWebRTC({
    roomId: currentRoom?.id ?? '',
    participantId: user?.id ?? '',
    isOwner: true,
  });
  const baiduRtc = useBaiduRtc({
    roomId: currentRoom?.id ?? '',
    participantId: user?.id ?? '',
    role: 'guide',
    displayName: profile?.nickname || profile?.username || '导游',
  });
  const startAudioTransport = useCallback(async (stream: MediaStream) => {
    let fallbackReason = '';
    if (baiduRtc.configured) {
      try {
        const started = await baiduRtc.startPublisher(stream);
        if (started) {
          setAudioTransportMode('baidu');
          setAudioTransportDetail('百度 RTC 正在传输中文原声');
          return true;
        }
        fallbackReason = '百度 RTC 未返回成功状态';
      } catch (error) {
        if (!audioTransportWantedRef.current || !stream.getAudioTracks().some(track => track.readyState === 'live')) {
          return false;
        }
        fallbackReason = error instanceof Error ? error.message : '百度 RTC 连接失败';
        console.warn('[Baidu RTC] 启动失败，回退到直连 WebRTC:', error);
      }
    } else {
      fallbackReason = '浏览器端未读取到百度 RTC AppID';
    }
    const directStarted = await startDirectMic(stream);
    if (directStarted) {
      setAudioTransportMode('direct');
      setAudioTransportDetail(`已降级为直连 WebRTC：${fallbackReason}；跨网络稳定性无法保证`);
      toast.warning('百度 RTC 不可用，已降级为直连 WebRTC');
      return true;
    }
    setAudioTransportMode('failed');
    setAudioTransportDetail(`百度 RTC 与直连 WebRTC 均未启动：${fallbackReason}`);
    return false;
  }, [baiduRtc.configured, baiduRtc.startPublisher, startDirectMic]);
  const stopAudioTransport = useCallback(() => {
    baiduRtc.stop();
    stopDirectMic();
    setAudioTransportMode('idle');
    setAudioTransportDetail('');
  }, [baiduRtc.stop, stopDirectMic]);

  // 初始化 WebRTC 信令
  useEffect(() => {
    if (!currentRoom?.id || !user?.id) return;
    const { unsub } = initSignaling();
    return unsub;
  }, [currentRoom?.id, user?.id]);

  // 密码加载：sessionStorage 命中则直接用，否则调 RPC（导游本人安全读取）
  useEffect(() => {
    if (!currentRoom?.id) return;
    const cached = sessionStorage.getItem(`shiguang-room-pwd-${currentRoom.id}`);
    if (cached) {
      setRoomPwd(cached);
      setPwdStatus('ok');
      return;
    }
    setPwdStatus('loading');
    fetchMyRoomPassword(currentRoom.id).then(pwd => {
      if (pwd) {
        setRoomPwd(pwd);
        // 写回 sessionStorage 作为本标签页缓存，刷新后再次 RPC 获取
        sessionStorage.setItem(`shiguang-room-pwd-${currentRoom.id}`, pwd);
        setPwdStatus('ok');
      } else {
        setPwdStatus('error');
      }
    }).catch(() => setPwdStatus('error'));
  }, [currentRoom?.id]);

  // 进入控制台时主动检测麦克风权限
  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      // 优先用 Permissions API（无感知，不弹权限框）
      if (navigator.permissions) {
        try {
          const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
          if (!cancelled) {
            setMicPerm(status.state === 'granted' ? 'granted' : status.state === 'denied' ? 'denied' : 'unknown');
            status.onchange = () => {
              setMicPerm(status.state === 'granted' ? 'granted' : status.state === 'denied' ? 'denied' : 'unknown');
            };
          }
          return;
        } catch { /* 降级到 getUserMedia */ }
      }
      // 降级：静默请求一次，立刻释放
      try {
        const s = await navigator.mediaDevices.getUserMedia({ audio: true });
        s.getTracks().forEach(t => t.stop());
        if (!cancelled) setMicPerm('granted');
      } catch (e) {
        if (!cancelled) {
          const name = (e as DOMException).name;
          setMicPerm(name === 'NotAllowedError' || name === 'PermissionDeniedError' ? 'denied' : 'unknown');
        }
      }
    };
    check();
    return () => { cancelled = true; };
  }, []);

  // 房间数据 & 实时订阅
  useEffect(() => {
    if (!currentRoom) return;
    let disposed = false;
    setSubtitles([]);
    setPushedCount(0);
    setUnreadSubtitleCount(0);
    knownSubtitleIdsRef.current = new Set();
    subtitleSeenAtRef.current = readGuideSubtitleSeenAt(currentRoom.id);
    unreadSubtitleRevisionRef.current = 0;

    fetchSubtitlesSafe(currentRoom.id, 50).then(rows => {
      if (disposed) return;
      rows.forEach(row => knownSubtitleIdsRef.current.add(row.id));
      setSubtitles(prev => {
        const liveRows = prev.filter(
          row => row.room_id === currentRoom.id && !rows.some(loaded => loaded.id === row.id),
        );
        return mergeLatestLiveSubtitles(rows, liveRows);
      });
    });
    fetchRoomMembersSafe(currentRoom.id).then(setMembers);
    fetchQuestions(currentRoom.id).then(setQuestions);
    fetchBarrages(currentRoom.id, 50).then(setBarrages);

    // 字幕徽章代表上次打开字幕记录后新增的字幕数，不受实时页 50 条缓存上限影响。
    let unreadQuery = supabase
      .from('subtitles')
      .select('id', { count: 'exact', head: true })
      .eq('room_id', currentRoom.id);
    if (subtitleSeenAtRef.current > 0) {
      unreadQuery = unreadQuery.gt(
        'created_at',
        new Date(subtitleSeenAtRef.current).toISOString(),
      );
    }
    const unreadQueryRevision = unreadSubtitleRevisionRef.current;
    unreadQuery.then(({ count, error }) => {
      if (
        !disposed
        && !error
        && unreadSubtitleRevisionRef.current === unreadQueryRevision
      ) {
        setUnreadSubtitleCount(count ?? 0);
      }
    });

    // 已推送卡片数始终回查数据库权威值，避免初始查询与 Realtime +1 产生漂移。
    const refreshPushedCount = async () => {
      const { count, error } = await supabase
        .from('card_pushes')
        .select('id', { count: 'exact', head: true })
        .eq('room_id', currentRoom.id)
        .not('kc_card_id', 'is', null);
      if (!disposed && !error) setPushedCount(count ?? 0);
    };
    void refreshPushedCount();

    const ch = supabase.channel(`room-live-${currentRoom.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'questions', filter: `room_id=eq.${currentRoom.id}` },
        payload => {
          const q = payload.new as Question;
          setQuestions(prev => {
            // 主键去重，防 Realtime 断线重连重放
            if (prev.some(x => x.id === q.id)) return prev;
            return [q, ...prev];
          });
        })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_barrages', filter: `room_id=eq.${currentRoom.id}` },
        payload => {
          const barrage = payload.new as Barrage;
          setBarrages(prev => [barrage, ...prev.filter(item => item.id !== barrage.id)].slice(0, 50));
        })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_members', filter: `room_id=eq.${currentRoom.id}` },
        () => fetchRoomMembersSafe(currentRoom.id).then(setMembers))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'card_pushes', filter: `room_id=eq.${currentRoom.id}` },
        payload => {
          // 只统计新流程推送（kc_card_id 非空，与旧中间层 room_card_id 无关）
          if ((payload.new as { kc_card_id?: string }).kc_card_id) {
            void refreshPushedCount();
          }
        });
    subtitleBroadcastRef.current = ch;

    const applySubtitleChange = (s: Subtitle, source: SubtitleChangeSource = 'insert') => {
      const isNewSubtitle = !knownSubtitleIdsRef.current.has(s.id);
      knownSubtitleIdsRef.current.add(s.id);
      setSubtitles(prev => mergeLatestLiveSubtitles(prev, [s]));
      if (
        isNewSubtitle
        && source !== 'update'
        && source !== 'poll-update'
        && new Date(s.created_at).getTime() > subtitleSeenAtRef.current
      ) {
        unreadSubtitleRevisionRef.current += 1;
        setUnreadSubtitleCount(prev => prev + 1);
      }
    };

    // 将字幕监听合并到同一 channel，减少独立 subtitles channel 的数据库连接占用
    const subtitleCleanup = attachSubtitleListener(ch, currentRoom.id, applySubtitleChange);

    // 使用 subscribeWithFallback：连接异常时自动降级为 3s 增量轮询，恢复后停止轮询
    const fbCleanup = subscribeWithFallback(
      ch,
      `guide-live-${currentRoom.id}`,
      currentRoom.id,
      setRealtimeSyncStatus,
      s => {
        // 轮询新字幕同步更新导游字幕预览（fingerprint 去重已在 subscribeWithFallback 内处理）
        applySubtitleChange(s);
      }
    );

    return () => {
      disposed = true;
      if (subtitleBroadcastRef.current === ch) subtitleBroadcastRef.current = null;
      subtitleCleanup.unsubscribe();
      fbCleanup.unsubscribe();
      supabase.removeChannel(ch);
    };
  }, [currentRoom?.id]);

  // 字幕记录页打开或在可见状态收到新字幕时，会广播“已读”状态。
  useEffect(() => {
    if (!currentRoom) return;
    const onSeen = (event: Event) => {
      const detail = (event as CustomEvent<{ roomId: string; seenAt: number }>).detail;
      if (!detail || detail.roomId !== currentRoom.id) return;
      subtitleSeenAtRef.current = Math.max(subtitleSeenAtRef.current, detail.seenAt);
      unreadSubtitleRevisionRef.current += 1;
      setUnreadSubtitleCount(0);
    };
    window.addEventListener('shiguang-guide-subtitles-seen', onSeen);
    return () => window.removeEventListener('shiguang-guide-subtitles-seen', onSeen);
  }, [currentRoom?.id]);

  // 讲解计时采用「累计有效时长 + 当前活动片段起点」模型。
  // 暂停时冻结累计值，恢复后开启新片段，暂停期间不会被计入讲解时长。
  useEffect(() => {
    if (!currentRoom) return;
    const storageKey = `shiguang-live-clock-${currentRoom.id}`;
    let restoredAccumulatedMs = Math.max(0, Number(currentRoom.actual_duration ?? 0) * 60_000);
    try {
      const raw = localStorage.getItem(storageKey) ?? sessionStorage.getItem(storageKey) ?? '{}';
      const saved = JSON.parse(raw) as {
        accumulatedMs?: number;
        segmentStartedAt?: number | null;
        lastHeartbeatAt?: number | null;
      };
      const savedAccumulated = Number(saved.accumulatedMs ?? 0);
      if (Number.isFinite(savedAccumulated) && savedAccumulated >= restoredAccumulatedMs) {
        restoredAccumulatedMs = savedAccumulated;
      }
      // 只累计至最后一次心跳，避免关闭页面数小时后再次打开时把离线时间误算为讲解时间。
      const staleSegmentStartedAt = Number(saved.segmentStartedAt ?? 0);
      const lastHeartbeatAt = Number(saved.lastHeartbeatAt ?? staleSegmentStartedAt);
      if (
        Number.isFinite(staleSegmentStartedAt) && staleSegmentStartedAt > 0
        && Number.isFinite(lastHeartbeatAt) && lastHeartbeatAt >= staleSegmentStartedAt
      ) {
        restoredAccumulatedMs += Math.max(0, lastHeartbeatAt - staleSegmentStartedAt);
      }
    } catch {
      restoredAccumulatedMs = 0;
    }
    accumulatedMsRef.current = restoredAccumulatedMs;
    sessionStartedAtRef.current = null;
    setAccumulatedMs(restoredAccumulatedMs);
    setSessionStartedAt(null);
    setElapsed(Math.floor(restoredAccumulatedMs / 1000));
    lastDurationSyncMinuteRef.current = Math.floor(restoredAccumulatedMs / 60_000);
    localStorage.setItem(storageKey, JSON.stringify({
      accumulatedMs: restoredAccumulatedMs,
      segmentStartedAt: null,
      lastHeartbeatAt: Date.now(),
    }));
    sessionStorage.removeItem(storageKey);
  }, [currentRoom?.id]);

  useEffect(() => {
    if (!sessionStartedAt || !isLive) {
      setElapsed(Math.floor(accumulatedMs / 1000));
      return;
    }
    const activeSegmentStartedAt = sessionStartedAt;
    const updateElapsed = () => {
      const activeMs = Math.max(0, Date.now() - activeSegmentStartedAt);
      const totalMs = accumulatedMs + activeMs;
      setElapsed(Math.floor(totalMs / 1000));
      const now = Date.now();
      if (now - lastClockPersistAtRef.current >= 5_000 && currentRoom) {
        lastClockPersistAtRef.current = now;
        localStorage.setItem(`shiguang-live-clock-${currentRoom.id}`, JSON.stringify({
          accumulatedMs,
          segmentStartedAt: activeSegmentStartedAt,
          lastHeartbeatAt: now,
        }));
      }
      const wholeMinutes = Math.floor(totalMs / 60_000);
      if (currentRoom && wholeMinutes > lastDurationSyncMinuteRef.current) {
        lastDurationSyncMinuteRef.current = wholeMinutes;
        void updateRoomDuration(currentRoom.id, wholeMinutes);
      }
    };
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [accumulatedMs, currentRoom?.id, isLive, sessionStartedAt]);

  const persistClock = useCallback((nextAccumulatedMs: number, segmentStartedAt: number | null) => {
    if (!currentRoom) return;
    localStorage.setItem(`shiguang-live-clock-${currentRoom.id}`, JSON.stringify({
      accumulatedMs: nextAccumulatedMs,
      segmentStartedAt,
      lastHeartbeatAt: Date.now(),
    }));
  }, [currentRoom?.id]);

  const startClockSegment = useCallback(() => {
    const now = Date.now();
    sessionStartedAtRef.current = now;
    setSessionStartedAt(now);
    persistClock(accumulatedMsRef.current, now);
  }, [persistClock]);

  const pauseClock = useCallback(() => {
    const segmentStart = sessionStartedAtRef.current;
    const nextAccumulatedMs = accumulatedMsRef.current
      + (segmentStart ? Math.max(0, Date.now() - segmentStart) : 0);
    accumulatedMsRef.current = nextAccumulatedMs;
    sessionStartedAtRef.current = null;
    setAccumulatedMs(nextAccumulatedMs);
    setSessionStartedAt(null);
    setElapsed(Math.floor(nextAccumulatedMs / 1000));
    persistClock(nextAccumulatedMs, null);
    if (currentRoom) {
      void updateRoomDuration(currentRoom.id, Math.floor(nextAccumulatedMs / 60_000));
    }
    return nextAccumulatedMs;
  }, [currentRoom?.id, persistClock]);

  const fmt = (s: number) => {
    const h = Math.floor(s / 3600).toString().padStart(2, '0');
    const m = Math.floor((s % 3600) / 60).toString().padStart(2, '0');
    const sec = (s % 60).toString().padStart(2, '0');
    return `${h}:${m}:${sec}`;
  };

  // 单次 3 秒录音周期（录完立即起下一段，ASR 任务推入 FIFO 队列串行处理）
  const startCycle = useCallback((stream: MediaStream, roomId: string) => {
    if (!isLiveRef.current) return;
    const chunks: Blob[] = [];
    const supportedMime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      .find(type => MediaRecorder.isTypeSupported(type));
    const mr = supportedMime ? new MediaRecorder(stream, { mimeType: supportedMime }) : new MediaRecorder(stream);
    activeMrRef.current = mr;
    mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
    mr.onstop = () => {
      if (activeMrRef.current === mr) activeMrRef.current = null;
      // ─── 修复竞态：严格保证 enqueueAsr → startCycle 的顺序 ───────────
      // 旧顺序（错误）：先 startCycle（替换 activeMrRef）→ 再 enqueueAsr
      //   — 新周期已开始录音，旧 Blob 入队时序不确定，若外部代码以 activeMrRef
      //     做校验则会误判"周期已替换"并丢弃分片。
      // 新顺序（正确）：
      //   1. 先校验 isLive（暂停/结束时跳过重启，但仍需入队）
      //   2. 先将旧分片 Blob 入队（enqueueAsr）— 保证分片不丢失
      //   3. 再启动下一录音周期（startCycle）— 此时才替换 activeMrRef
      //   4. 最后 resolve flush Promise 通知等待方

      const mimeType = mr.mimeType || supportedMime || 'audio/webm';

      // 步骤 1：无论是否继续，先把当前分片入队（关键：在 startCycle 之前）
      if (chunks.length) {
        const blob = new Blob(chunks, { type: mimeType });
        console.log(`[ASR] 分片已入队 | size=${blob.size} mime=${mimeType} isLive=${isLiveRef.current}`);
        enqueueAsr(roomId, blob, mimeType);
      }

      // 步骤 2：入队完成后，再决定是否启动下一段（此时才替换 activeMrRef）
      if (isLiveRef.current) startCycle(stream, roomId);

      // 步骤 3：resolve 通知 handleStop/handleEndSession：最后一段已进入 FIFO
      if (lastStopFlushResolveRef.current) {
        lastStopFlushResolveRef.current();
        lastStopFlushResolveRef.current = null;
      }
    };
    mr.start();
    cycleTimerRef.current = setTimeout(() => { if (mr.state === 'recording') mr.stop(); }, AUDIO_SLICE_MS);
  }, [enqueueAsr]);

  // 开始同声传译（ASR 录音独立启动，WebRTC 中文原声推流并行进行）
  const handleStart = async () => {
    if (!currentRoom) { toast.error('请先进入房间'); return; }
    if (isStarting || isStopping || isLiveRef.current) return;

    try {
      setVoiceError('');
      setIsStarting(true); // ① 立即进入 starting，禁用按钮防止重复点击

      // ② 麦克风授权（失败 → catch → failed/ready）
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;
      audioTransportWantedRef.current = true;
      // getUserMedia 成功即代表本次真实授权可用。Permissions API 在部分浏览器中
      // 仍可能停留在 prompt/unknown，因此这里必须同步页面状态。
      setMicPerm('granted');

      // ③ WebRTC/BRTC 推流启动（非阻断：失败只报 warning，不阻断字幕链路，
      //    starting 状态继续保持直到 DB 写入成功）
      startAudioTransport(stream).then(micStarted => {
        if (!audioTransportWantedRef.current) return;
        if (!micStarted) {
          const msg = '中文原声推流失败，字幕仍在生成中';
          setVoiceError(msg);
          toast.warning(msg);
        }
      }).catch(err => {
        if (!audioTransportWantedRef.current) return;
        const msg = `中文原声推流异常：${err instanceof Error ? err.message : '未知错误'}，字幕仍在生成中`;
        setVoiceError(msg);
        toast.warning(msg);
      });

      // ④ 房间状态写入（pending → live 首次才写；已 live 的房间不重写 started_at）
      if (currentRoom.status !== 'live') {
        const startedAt = new Date().toISOString();
        const { error: dbErr } = await updateRoomStatus(currentRoom.id, 'live', { started_at: startedAt });
        if (dbErr) {
          // DB 写入失败 → 完整回滚，保持 starting=false/isLive=false → failed
          stream.getTracks().forEach(t => t.stop());
          streamRef.current = null;
          isLiveRef.current = false;
          setIsStarting(false);
          stopAudioTransport();
          const msg = '开始讲解失败（数据库更新错误），请稍后重试';
          setVoiceError(msg);
          toast.error(msg);
          return;
        }
        // ⑤ DB 成功 → 更新房间状态
        setCurrentRoom({ ...currentRoom, status: 'live', started_at: startedAt });
      }

      // ⑥ 完整流程成功：isStarting → false，isLive → true
      startClockSegment();
      isLiveRef.current = true;
      setIsLive(true);
      setIsStarting(false);

      // ⑦ 优先启动百度 WebSocket 流式识别；配置或鉴权失败时自动回退到 3 秒短语音切片。
      setAsrMode('connecting');
      let fallbackStarted = false;
      const fallbackToChunkedAsr = (reason: string) => {
        if (!isLiveRef.current || fallbackStarted) return;
        fallbackStarted = true;
        streamingSessionRef.current?.cancel();
        streamingSessionRef.current = null;
        void flushPendingStreamingFinal(currentRoom.id);
        setAsrMode('chunked');
        startCycle(stream, currentRoom.id);
        setVoiceError(`流式字幕暂不可用，已切换兼容识别：${reason}`);
        toast.warning('百度流式识别暂不可用，已自动切换短语音字幕');
      };
      try {
        const streamingSession = await startStreamingSpeech(stream, {
          onPartial: ({ text }) => {
            const pending = pendingStreamingFinalRef.current;
            const draft = pending?.roomId === currentRoom.id
              ? mergeStreamingText(pending.text, text)
              : normalizeStreamingText(text);
            publishLiveDraft(currentRoom.id, draft);
          },
          onFinal: result => queueStreamingFinal(currentRoom.id, result),
          onError: fallbackToChunkedAsr,
        });
        if (!isLiveRef.current) {
          streamingSession.cancel();
        } else if (!fallbackStarted) {
          streamingSessionRef.current = streamingSession;
          setAsrMode('streaming');
          setVoiceError('');
          toast.success('中文原声、百度流式字幕、英文翻译与语音合成已开始');
        } else {
          streamingSession.cancel();
        }
      } catch (streamingError) {
        fallbackToChunkedAsr(
          streamingError instanceof Error ? streamingError.message : '连接失败',
        );
      }
    } catch (err) {
      // 任意步骤抛出异常 → 完整回滚 → failed
      isLiveRef.current = false;
      audioTransportWantedRef.current = false;
      setIsLive(false);
      setIsStarting(false);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
      stopAudioTransport();
      let friendlyMsg = '无法启动语音讲解，请稍后重试';
      if (err instanceof Error) {
        const name = (err as DOMException).name ?? '';
        const msg = err.message.toLowerCase();
        if (name === 'NotAllowedError' || msg.includes('not allowed') || msg.includes('permission') || msg.includes('denied')) {
          setMicPerm('denied');
          friendlyMsg = '麦克风权限被拒绝，请在浏览器地址栏左侧允许麦克风权限后重试';
        } else if (name === 'NotFoundError' || msg.includes('not found') || msg.includes('no device')) {
          friendlyMsg = '未检测到麦克风设备，请检查设备连接后重试';
        } else if (name === 'NotReadableError' || msg.includes('not readable')) {
          friendlyMsg = '麦克风被其他应用占用，请关闭其他正在使用麦克风的应用后重试';
        }
      }
      setVoiceError(friendlyMsg);
      toast.error(friendlyMsg);
    }
  };

  // ─── 等待 FIFO 队列完整排空。每个 ASR 请求自身有超时，不在这里提前截断。────
  const waitQueueDrain = useCallback((): Promise<void> => {
    return new Promise(resolve => {
      const check = () => {
        if (asrQueueRef.current.length === 0 && !processorRunningRef.current) {
          resolve(); return;
        }
        setTimeout(check, 200);
      };
      check();
    });
  }, []);

  /**
   * armStopFlush — 在调用 MediaRecorder.stop() 前调用。
   * 创建一个 Promise，等待 onstop 完成 enqueueAsr 后 resolve。
   * 若当前没有活跃录音器，直接返回已 resolved 的 Promise。
   */
  const armStopFlush = useCallback((): Promise<void> => {
    if (!activeMrRef.current || activeMrRef.current.state !== 'recording') {
      return Promise.resolve();
    }
    const p = new Promise<void>(resolve => {
      lastStopFlushResolveRef.current = resolve;
    });
    lastStopFlushRef.current = p;
    return p;
  }, []);

  // 停止同声传译（停录音；已入队片段继续处理完毕）
  const handleStop = async () => {
    if (isStopping || !isLiveRef.current) return;
    setIsStopping(true);
    const streamingSession = streamingSessionRef.current;
    streamingSessionRef.current = null;
    // 短语音回退模式需等待 MediaRecorder onstop 入队；流式模式由 FINISH 帧触发最终结果。
    const flushDone = streamingSession ? Promise.resolve() : armStopFlush();
    isLiveRef.current = false;
    audioTransportWantedRef.current = false;
    setIsLive(false);
    pauseClock();
    if (cycleTimerRef.current) { clearTimeout(cycleTimerRef.current); cycleTimerRef.current = null; }
    if (activeMrRef.current?.state === 'recording') activeMrRef.current.stop();
    const streamToStop = streamRef.current;
    streamRef.current = null;
    stopAudioTransport();
    streamToStop?.getTracks().forEach(track => track.stop());
    try {
      if (streamingSession) await streamingSession.stop();
      if (currentRoom) await flushPendingStreamingFinal(currentRoom.id);
      // 2. 等待 onstop 把最后一段推入队列（不等 ASR 完成，队列继续串行消费）
      await flushDone;
      toast.info('实时讲解已暂停，最后一段字幕正在生成…');
    } finally {
      setIsStopping(false);
    }
  };

  useEffect(() => () => {
    if (isLiveRef.current) pauseClock();
    isLiveRef.current = false;
    audioTransportWantedRef.current = false;
    streamingSessionRef.current?.cancel();
    streamingSessionRef.current = null;
    if (pendingStreamingFinalTimerRef.current) {
      clearTimeout(pendingStreamingFinalTimerRef.current);
      pendingStreamingFinalTimerRef.current = null;
    }
    const pendingFinal = pendingStreamingFinalRef.current;
    pendingStreamingFinalRef.current = null;
    if (pendingFinal) void saveRecognizedText(pendingFinal.roomId, pendingFinal.text);
    if (cycleTimerRef.current) clearTimeout(cycleTimerRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
    stopAudioTransport();
  }, [pauseClock, stopAudioTransport]);

  // currentRoom 缺失或房间已结束 → useEffect 安全返回首页，禁止在 render 中直接调用 go
  useEffect(() => {
    if (!currentRoom || currentRoom.status === 'ended') {
      go('guide-home');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRoom?.id, currentRoom?.status]);

  if (!currentRoom || currentRoom.status === 'ended') return null;

  // ── 讲解控制台内的分享逻辑（不含明文密码）
  const liveInviteUrl = buildInviteUrl(currentRoom.room_number);
  const handleShareRoom = async () => {
    const shareText = `邀请你加入「${currentRoom.name}」讲解导览！\n房间号：${currentRoom.room_number}\n邀请链接：${liveInviteUrl}\n（进入后需向导游询问密码）`;
    const shareData = { title: `邀请你加入「${currentRoom.name}」讲解`, text: shareText, url: liveInviteUrl };
    if (navigator.share) {
      try { await navigator.share(shareData); return; } catch { /* 降级复制 */ }
    }
    const doExecCopy = () => {
      const ta = document.createElement('textarea');
      ta.value = shareText;
      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
      toast.success('邀请信息已复制');
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(shareText).then(() => toast.success('邀请信息已复制到剪贴板')).catch(doExecCopy);
    } else { doExecCopy(); }
  };

  const handleEndSession = async () => {
    if (!currentRoom || endBusy) return;
    setEndBusy(true);

    const streamingSession = streamingSessionRef.current;
    streamingSessionRef.current = null;
    // 1. 短语音模式 arm flush；流式模式稍后发送 FINISH。
    const flushDone = streamingSession ? Promise.resolve() : armStopFlush();

    // 2. 停止录音（isLiveRef=false 防止 onstop 重启下一段）
    isLiveRef.current = false;
    audioTransportWantedRef.current = false;
    setIsLive(false);
    const finalAccumulatedMs = pauseClock();
    if (cycleTimerRef.current) { clearTimeout(cycleTimerRef.current); cycleTimerRef.current = null; }
    if (activeMrRef.current?.state === 'recording') activeMrRef.current.stop();
    const streamToStop = streamRef.current;
    streamRef.current = null;
    stopAudioTransport();
    streamToStop?.getTracks().forEach(track => track.stop());

    try {
      if (streamingSession) await streamingSession.stop();
      await flushPendingStreamingFinal(currentRoom.id);

      // 3. 等待 onstop 完成 enqueueAsr（最后一段已进入 FIFO）
      await flushDone;

      // 4. 等待所有中文字幕写入，再等待英文翻译与英文 TTS 全部完成。
      await waitQueueDrain();
      await Promise.allSettled([...streamingFinalTasksRef.current]);
      const { failedCount: enrichmentFailedCount } =
        await waitForSubtitleEnrichment(currentRoom.id);

      // 5. 只有数据库确认 ended 后，才清理本地房间并提示成功。
      const { error: endError } = await updateRoomStatus(currentRoom.id, 'ended', {
        ended_at: new Date().toISOString(),
        actual_duration: finalAccumulatedMs > 0 ? Math.ceil(finalAccumulatedMs / 60_000) : 0,
      });
      if (endError) {
        toast.error(`解散房间失败：${endError}`);
        return;
      }

      let minutesGenerated = false;
      let minutesCloudSaved = false;
      if (generateMinutesOnEnd) {
        const allSubtitles = await fetchAllSubtitles(currentRoom.id, user?.id);
        const generatedMinutes = generateMeetingMinutes(currentRoom, allSubtitles);
        saveMeetingMinutes(generatedMinutes);
        if (user?.id) {
          try {
            await saveMeetingMinutesCloud(generatedMinutes, user.id);
            minutesCloudSaved = true;
          } catch {
            minutesCloudSaved = false;
          }
        }
        minutesGenerated = true;
      }

      localStorage.removeItem(`shiguang-live-clock-${currentRoom.id}`);
      sessionStorage.removeItem(`shiguang-live-clock-${currentRoom.id}`);
      sessionStorage.removeItem(`shiguang-live-start-${currentRoom.id}`);
      setCurrentRoom(null);
      if (enrichmentFailedCount > 0) {
        toast.warning(`房间已结束；${enrichmentFailedCount} 条英文语音生成失败，中文字幕已保存`);
      } else if (minutesGenerated && !minutesCloudSaved) {
        toast.warning('讲解已结束，会议纪要已保存在本机；云端持久化待数据库迁移生效');
      } else {
        toast.success(minutesGenerated ? '讲解已结束，会议纪要已生成' : '讲解已结束');
      }
      go('records');
    } catch (error) {
      const message = error instanceof Error ? error.message : '未知错误';
      toast.error(`解散房间失败：${message}`);
    } finally {
      setEndBusy(false);
    }
  };

  type LectureUiState = 'ready' | 'starting' | 'live' | 'stopping' | 'paused' | 'ended' | 'failed';
  const lectureUiState = useMemo<LectureUiState>(() => {
    if (currentRoom.status === 'ended') return 'ended';
    if (isStopping) return 'stopping';
    if (isStarting) return 'starting';
    if (isLive) return 'live';
    if (accumulatedMs > 0) return 'paused';
    if (voiceError) return 'failed';
    return 'ready';
  }, [accumulatedMs, currentRoom.status, isStarting, isLive, isStopping, voiceError]);

  // ── 合并实时内容区：字幕 + 提问按时间升序排列，稳定 key，ID 去重
  type ContentItem =
    | { kind: 'subtitle'; id: string; ts: number; data: Subtitle }
    | { kind: 'question'; id: string; ts: number; data: Question }
    | { kind: 'barrage'; id: string; ts: number; data: Barrage };

  const contentItems = useMemo<ContentItem[]>(() => {
    const subs: ContentItem[] = subtitles.map(s => ({
      kind: 'subtitle', id: `sub-${s.id}`, ts: new Date(s.created_at).getTime(), data: s,
    }));
    const qs: ContentItem[] = questions.map(q => ({
      kind: 'question', id: `q-${q.id}`, ts: new Date(q.created_at).getTime(), data: q,
    }));
    const barrageItems: ContentItem[] = barrages.map(item => ({
      kind: 'barrage', id: `barrage-${item.id}`, ts: new Date(item.created_at).getTime(), data: item,
    }));
    return [...subs, ...qs, ...barrageItems].sort((a, b) => a.ts - b.ts);
  }, [barrages, subtitles, questions]);

  // ── 实时内容区：默认持续跟随最新内容；用户主动上滑时暂停跟随
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const contentEndRef = useRef<HTMLDivElement>(null);
  const [contentAutoFollow, setContentAutoFollow] = useState(true);

  const handleContentScroll = useCallback(() => {
    const el = contentScrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    setContentAutoFollow(distanceFromBottom <= 64);
  }, []);

  const scrollContentToLatest = useCallback((behavior: ScrollBehavior = 'smooth') => {
    setContentAutoFollow(true);
    const el = contentScrollRef.current;
    el?.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  useEffect(() => {
    if (!contentAutoFollow) return;
    const el = contentScrollRef.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [contentItems, liveDraft, contentAutoFollow]);

  return (
    <div className="screen padded-screen guide-live-screen" style={visible ? undefined : { display: 'none' }}>
      <div className="mini-header">
        <button className="back-button" onClick={() => go('guide-home')} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>{currentRoom.name}</strong>
        <button className="live-end-icon-btn" onClick={() => setShowEndConfirm(true)} aria-label="解散房间">
          <LogOut size={18} />
        </button>
      </div>

      {/* 在线人数来自 Presence（唯一真值） */}
      <p className="room-meta">
        房间号 {currentRoom.room_number} · 在线 <b>{participantCount}</b> 人
      </p>

      {/* 房间密码板块 */}
      <div className="live-pwd-row">
        <LockKeyhole size={13} className="live-pwd-icon" />
        <span className="live-pwd-label">房间密码</span>
        <span className="live-pwd-value">
          {pwdStatus === 'loading' && <span className="live-pwd-hint">读取中…</span>}
          {pwdStatus === 'error'   && <span className="live-pwd-hint live-pwd-hint--err">密码暂不可用</span>}
          {pwdStatus === 'ok'      && (pwdVisible ? roomPwd : '•'.repeat(roomPwd.length || 6))}
        </span>
        {pwdStatus === 'ok' && (
          <button
            className="live-pwd-eye"
            onClick={() => setPwdVisible(v => !v)}
            aria-label={pwdVisible ? '隐藏密码' : '显示密码'}
          >
            {pwdVisible ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        )}
      </div>

      {/* 导游信息与语音操作合并为一个控制台，状态仍由 lectureUiState 单一驱动 */}
      <section className={`guide-voice-console ${lectureUiState === 'live' ? 'is-live' : ''}`}>
      <div className="live-host-card">
        <Avatar url={profile?.avatar_url} />
        <div className="live-host-copy">
          <div className="host-name-row">
            <h2>{profile?.nickname ?? '导游'}</h2>
            <span
              className={`live-label ${lectureUiState === 'live' ? 'is-live' : lectureUiState === 'starting' || lectureUiState === 'stopping' ? 'is-starting' : 'is-ready'}`}
              aria-live="polite"
            >
              <CircleDot />
              {lectureUiState === 'live'     ? '正在讲解'
                : lectureUiState === 'starting' ? '正在连接'
                : lectureUiState === 'stopping' ? '正在暂停'
                : lectureUiState === 'paused'   ? '已暂停'
                : lectureUiState === 'ended'    ? '已结束'
                : lectureUiState === 'failed'   ? '连接失败'
                :                                 '设备已就绪'}
            </span>
          </div>
          <Wave active={lectureUiState === 'live'} />
          <strong className="timer" aria-label="讲解时长">
            {fmt(elapsed)}
          </strong>
          <p>
            {lectureUiState === 'live'
              ? '中文原声讲解中 · 字幕实时生成'
              : lectureUiState === 'starting'
              ? '正在建立连接，请稍候…'
              : lectureUiState === 'stopping'
              ? '正在保存最后一段字幕…'
              : lectureUiState === 'paused'
              ? '讲解已暂停 · 可继续本次讲解'
              : participantCount > 0
              ? `${participantCount} 位成员在线 · 准备讲解`
              : '准备讲解 · 暂无游客在线'}
          </p>
        </div>
      </div>

      {/* 语音讲解面板：按钮/文案由 lectureUiState 驱动 */}
      <div className={`voice-panel voice-only-panel ${lectureUiState === 'live' ? 'is-live' : ''}`}>
        <div className="voice-panel-heading">
          <span><Radio />语音讲解</span>
          <strong className="language-static-chip">普通话</strong>
          {processingCount > 0 && (
            <span className="processing-hint">
              <Loader2 size={12} className="spin-icon" />处理中 {processingCount} 段
            </span>
          )}
          {lectureUiState === 'live' && (
            <span className={`streaming-mode-chip ${asrMode}`}>
              {asrMode === 'streaming' ? '百度流式字幕'
                : asrMode === 'connecting' ? '流式连接中'
                : '兼容字幕'}
            </span>
          )}
        </div>
        <div className="mic-center">
          {lectureUiState !== 'live' && (micPerm === 'denied' || micPerm === 'unknown') && (
            <div className={`mic-perm-banner ${micPerm}`}>
              {micPerm === 'denied' ? <MicOff size={14} /> : <Mic size={14} />}
              <span>
                {micPerm === 'denied'
                  ? '麦克风权限已被禁止，请在浏览器地址栏左侧点击锁形图标开启权限后重试'
                  : '点击下方按钮后，请在弹出的权限请求中选择「允许」以使用麦克风'}
              </span>
            </div>
          )}
          {lectureUiState === 'starting' || lectureUiState === 'stopping' ? (
            <button className="mic-fab" disabled aria-label="正在连接" aria-busy="true">
              <Loader2 size={26} className="spin-icon" />
            </button>
          ) : lectureUiState === 'live' ? (
            <button className="mic-fab active" onClick={handleStop} aria-label="暂停讲解">
              <Square size={22} />
            </button>
          ) : (
            <button
              className="mic-fab"
              onClick={handleStart}
              aria-label={lectureUiState === 'paused' ? '继续讲解' : lectureUiState === 'failed' ? '重新开始讲解' : '开始讲解'}
              disabled={lectureUiState === 'ended'}
            >
              <Mic size={30} />
            </button>
          )}
          <strong className="mic-action-title">
            {lectureUiState === 'live'     ? '正在传输中文原声'
              : lectureUiState === 'starting' ? '正在连接，请稍候'
              : lectureUiState === 'stopping' ? '正在暂停，请稍候'
              : lectureUiState === 'paused'   ? '点击继续语音讲解'
              : lectureUiState === 'failed'   ? '点击重新开始讲解'
              :                                 '点击开始语音讲解'}
          </strong>
          <p className="mic-hint">
            {lectureUiState === 'live'
              ? '游客实时收听中文；英文语音与双语字幕同步生成'
              : '系统将自动生成中英字幕及英文语音'}
          </p>
          {audioTransportMode !== 'idle' && (
            <p
              className={`audio-transport-notice ${audioTransportMode}`}
              role={audioTransportMode === 'direct' || audioTransportMode === 'failed' ? 'alert' : 'status'}
            >
              {audioTransportMode === 'baidu' ? '百度 RTC' : audioTransportMode === 'direct' ? '直连降级模式' : '原声传输失败'}
              {' · '}
              {audioTransportDetail}
            </p>
          )}
          {voiceError && (
            <div className="voice-error-block" role="alert">
              <p className="voice-error-msg">{voiceError}</p>
            </div>
          )}
        </div>
      </div>
      </section>

      <div className="guide-tools">
        <button onClick={() => go('guest-list')}>
          <span className="tool-icon-wrap">
            <UsersRound />
            {participantCount > 0 && (
              <i className="tool-badge" aria-label={`${participantCount} 位成员在线`}>
                {formatToolBadgeCount(participantCount)}
              </i>
            )}
          </span>
          游客列表
        </button>
        <button onClick={() => go('guide-subtitle-record')}>
          <span className="tool-icon-wrap">
            <Languages />
            {unreadSubtitleCount > 0 && (
              <i className="tool-badge" aria-label={`${unreadSubtitleCount} 条新增字幕`}>
                {formatToolBadgeCount(unreadSubtitleCount)}
              </i>
            )}
          </span>
          字幕记录
        </button>
        <button onClick={() => go('card-library')}>
          <span className="tool-icon-wrap">
            <Landmark />
            {pushedCount > 0 && (
              <i className="tool-badge" aria-label={`已推送 ${pushedCount} 张景点卡片`}>
                {formatToolBadgeCount(pushedCount)}
              </i>
            )}
          </span>
          景点卡片
        </button>
        <button onClick={handleShareRoom}>
          <span className="tool-icon-wrap"><Share2 /></span>
          分享房间
        </button>
      </div>

      {/* ── 实时内容区：字幕与游客提问合并，按时间升序，最新在底部 ── */}
      <div className="live-content-stream">
        <h4 className="live-content-stream__header" aria-live="off">
          实时内容
          {contentItems.length > 0 && <span className="live-content-stream__count"> · {contentItems.length} 条</span>}
          <span className="live-content-stream__sync">
            {realtimeSyncStatus === 'ok' ? '同步中' : '恢复中…'}
          </span>
        </h4>
        <div className="live-content-stream__viewport">
          {/* aria-live="polite"：新内容到达时由辅助技术通报，不打断当前朗读 */}
          <div
            className="live-content-stream__list"
            ref={contentScrollRef}
            onScroll={handleContentScroll}
            aria-live="polite"
            aria-label="实时字幕与游客提问"
          >
            {contentItems.length === 0 && !liveDraft ? (
              <p className="live-content-stream__empty">
                {lectureUiState === 'live' ? '识别中，字幕即将出现…' : '开始讲解后字幕与提问将在此实时显示'}
              </p>
            ) : contentItems.map(item =>
              item.kind === 'subtitle' ? (
                <article key={item.id} className="lcs-bubble lcs-bubble--subtitle" aria-label="字幕">
                  <p className="lcs-bubble__main">{(item.data as Subtitle).content_cn}</p>
                  {(item.data as Subtitle).content_en && (
                    <p className="lcs-bubble__sub">{(item.data as Subtitle).content_en}</p>
                  )}
                </article>
              ) : item.kind === 'question' ? (
                <article key={item.id} className="lcs-bubble lcs-bubble--question" aria-label="游客提问">
                  <p className="lcs-bubble__main">
                    {`${(item.data as Question).profile?.nickname?.trim() || '游客'}：${(item.data as Question).content}`}
                  </p>
                  {(item.data as Question).translated_text && (
                    <p className="lcs-bubble__sub">{(item.data as Question).translated_text}</p>
                  )}
                </article>
              ) : (
                <article key={item.id} className="lcs-bubble lcs-bubble--barrage" aria-label="游客弹幕">
                  <p className="lcs-bubble__main">
                    {`${(item.data as Barrage).profile?.nickname?.trim() || '游客'}：${(item.data as Barrage).content}`}
                  </p>
                  <span className="lcs-bubble__tag">弹幕</span>
                </article>
              )
            )}
            {liveDraft && (
              <article className="lcs-bubble lcs-bubble--subtitle lcs-bubble--draft" aria-label="正在识别的字幕">
                <p className="lcs-bubble__main">{liveDraft}</p>
                <span>识别中…</span>
              </article>
            )}
            <div ref={contentEndRef} aria-hidden="true" />
          </div>
          {!contentAutoFollow && (
            <button
              type="button"
              className="live-content-stream__latest"
              onClick={() => scrollContentToLatest()}
            >
              <ChevronDown size={14} />
              回到最新
            </button>
          )}
        </div>
      </div>

      {/* 解散房间确认弹窗 */}
      {showEndConfirm && (
        <div className="end-confirm-overlay" onClick={() => !endBusy && setShowEndConfirm(false)}>
          <div
            className={`end-confirm-sheet${endBusy ? ' is-processing' : ''}`}
            onClick={e => e.stopPropagation()}
          >
            {endBusy ? (
              <div className="ai-minutes-progress" role="status" aria-live="polite">
                <div className="ai-minutes-spinner" aria-hidden="true">
                  <Loader2 size={38} />
                  <span />
                </div>
                <h3>{generateMinutesOnEnd ? 'AI正在生成中～' : '正在结束讲解～'}</h3>
                <p>
                  {generateMinutesOnEnd
                    ? '正在整理全部字幕，并完成英文翻译与语音处理'
                    : '正在保存字幕，并完成英文翻译与语音处理'}
                </p>
                <div className="ai-minutes-dots" aria-hidden="true">
                  <i /><i /><i />
                </div>
              </div>
            ) : (
              <>
                <div className="end-confirm-icon"><LogOut size={26} /></div>
                <h3>确认解散房间？</h3>
                <p>结束后游客将无法继续收听，讲解记录将被保存。</p>
                <label className="end-minutes-option">
                  <input
                    type="checkbox"
                    checked={generateMinutesOnEnd}
                    onChange={event => setGenerateMinutesOnEnd(event.target.checked)}
                  />
                  <span>
                    <b>根据全部字幕生成会议纪要</b>
                    <small>生成后可在“记录”中查看</small>
                  </span>
                </label>
                <div className="end-confirm-actions">
                  <button className="end-confirm-cancel" onClick={() => setShowEndConfirm(false)}>取消</button>
                  <button className="end-confirm-ok" onClick={handleEndSession}>确认解散</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * GuideLive 外层：挂载导游侧 Presence 订阅（仅订阅，不 track，role='guide'）。
 * 在讲解工具页切换期间由 ScreenRouter 提供共享 Provider，避免同名频道重复订阅；
 * 单独进入本页面时仍保留自身 Provider。
 */
export function GuideLive({
  go,
  visible = true,
  onSnapshot,
  presenceProvided = false,
}: Props & {
  visible?: boolean;
  onSnapshot?: (snapshot: GuideLiveSnapshot) => void;
  presenceProvided?: boolean;
}) {
  const { currentRoom, user } = useAuth();
  if (presenceProvided) {
    return <GuideLiveInner go={go} visible={visible} onSnapshot={onSnapshot} />;
  }
  return (
    <RoomPresenceProvider
      roomId={currentRoom?.id ?? ''}
      userId={user?.id ?? ''}
      role="guide"
    >
      <GuideLiveInner go={go} visible={visible} onSnapshot={onSnapshot} />
    </RoomPresenceProvider>
  );
}

// ─── BottomNav（共用） ────────────────────────────────
type NavItem = [React.ElementType, string, string];

interface BottomNavProps {
  active: string;
  go?: (id: string) => void;
  variant?: 'tour' | 'guide' | 'visitorHome' | 'photographer' | 'room';
}

export function BottomNav({ active, go, variant = 'tour' }: BottomNavProps) {
  const { t } = useAppLanguage();
  const navMap: Record<string, NavItem[]> = {
    guide:        [[DoorOpen, '房间', 'guide-home'], [History, '记录', 'records'], [CircleUserRound, '我的', 'my']],
    tour:         [[DoorOpen, '房间', 'room-list'],  [History, '最近', 'recent-rooms'], [CircleUserRound, '我的', 'tourist-my']],
    visitorHome:  [[DoorOpen, '房间', 'room-list'],  [History, '最近', 'recent-rooms'], [CircleUserRound, '我的', 'tourist-my']],
    photographer: [[Camera, '任务', 'photographer-tasks'], [Images, '相册', 'photographer-album'], [CircleUserRound, '我的', 'photographer-my']],
    room:         [[Headphones, '语音', 'listening'], [Captions, '字幕', 'subtitle-tab'], [Images, '相册', 'room-album']],
  };
  const items = navMap[variant] ?? navMap.tour;

  return (
    <div className="bottom-nav">
      {items.map(([Icon, name, target]) => (
        <button
          key={name as string}
          className={active === name ? 'active' : ''}
          onClick={() => go?.(target as string)}
          aria-label={t(name)}
        >
          <Icon size={22} strokeWidth={1.9} aria-hidden="true" />
          <span>{t(name)}</span>
        </button>
      ))}
    </div>
  );
}
