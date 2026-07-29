import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { buildInviteUrl } from '@/lib/inviteUrl';
import {
  UsersRound, Clock3, Landmark, CircleDot, ChevronRight, Plus,
  Languages, Share2, Check,
  Copy, LockKeyhole,
  Mic, MicOff, Square, Loader2, Radio, History, ImagePlus,
  Images, Headphones, AlignLeft, Image as ImageIcon, LogOut, RefreshCw,
  AlertCircle, Eye, EyeOff,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { fetchGuideRooms, fetchRoomById, createRoom, updateRoomStatus, genPassword, fetchMyRoomPassword } from '@/api/rooms';
import { uploadRoomCoverBlob } from '@/api/roomCover';
import { RoomCoverCropModal } from '@/components/RoomCoverCropModal';
import { fetchQuestions } from '@/api/roomActivity';
import { fetchRoomMembersSafe } from '@/api/profiles';
import {
  processAudioChunk, processDemoAudioChunk, attachSubtitleListener, subscribeWithFallback,
} from '@/lib/voiceApi';
import { useWebRTC } from '@/hooks/use-webrtc';
import { RoomPresenceProvider, useRoomPresence } from '@/hooks/use-room-presence';
import type { Room, Question, RoomMember, Subtitle } from '@/types/types';
import { toast } from 'sonner';
import { supabase } from '@/db/supabase';
import QRCodeDataUrl from '@/components/ui/qrcodedataurl';

interface Props { go: (id: string) => void }

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
 * GuideHome 内层：已在 RoomPresenceProvider 内，可消费 Presence touristCount。
 * 当前活跃房间的"在线游客"统计来自 Presence，不再使用 rooms.online_count。
 */
function GuideHomeInner({ go }: Props) {
  const { user, profile, setCurrentRoom } = useAuth();
  const { touristCount } = useRoomPresence();
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
  const historyRooms = rooms.filter(r => r.status === 'ended').slice(0, 3);

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

  // 悬浮按钮文案
  const fabLabel = isCheckingActive
    ? '检查房间中'
    : isActiveError
      ? '加载失败，点击重试'
      : activeRoom ? '返回讲解房' : '创建讲解房';

  const handleFab = () => {
    if (isActiveError && activeRoomState.status === 'error') {
      activeRoomState.retry();
      return;
    }
    handleEnterOrCreate();
  };

  return (
    <div className="screen padded-screen has-tabbar" style={{ paddingTop: 16 }}>
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
        <div><span><UsersRound /></span><b>{activeRoom ? touristCount : 0}</b><small>在线游客</small></div>
        <div><span><Clock3 /></span><b>{rooms.filter(r => r.status !== 'pending').length}</b><small>历史房间</small></div>
        <div><span><Landmark /></span><b>{rooms.length}</b><small>累计创建</small></div>
      </div>

      {/* 当前房间 —— 加载中骨架 */}
      {isCheckingActive ? (
        <div className="current-room" style={{ opacity: 0.6 }}>
          <div className="title-row">
            <h3>当前讲解房</h3>
            <b style={{ color: 'var(--muted)' }}><Loader2 size={13} className="spin-icon" />检查中…</b>
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
          <div className="title-row">
            <h3>当前讲解房</h3>
            <b><CircleDot />讲解中</b>
          </div>
          <div className="current-room-main">
            <div className="guide-room-photo" />
            <div>
              <h2>{liveRoom.name}</h2>
              <span>房间号</span><strong>{liveRoom.room_number}</strong>
              {/* 在线人数来自 Presence，不使用 online_count */}
              <p><UsersRound />{touristCount} 人在线</p>
            </div>
          </div>
          <button className="primary-button green" onClick={handleEnterOrCreate}>
            继续讲解<ChevronRight />
          </button>
        </div>
      ) : pendingRoom ? (
        <div className="current-room">
          <div className="title-row">
            <h3>待开始的讲解房</h3>
            <b style={{ color: 'var(--amber)' }}>待开始</b>
          </div>
          <div className="current-room-main">
            <div className="guide-room-photo" />
            <div>
              <h2>{pendingRoom.name}</h2>
              <span>房间号</span><strong>{pendingRoom.room_number}</strong>
              {/* 在线人数来自 Presence，不使用 online_count */}
              <p><UsersRound />{touristCount} 人在线</p>
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
          <div className="title-row history-heading">
            <h3>历史讲解房</h3>
            <button className="all-records-btn" onClick={() => go('records')}>全部记录 <ChevronRight size={14} /></button>
          </div>
          <div className="history-room-list">
            {historyRooms.map(r => (
              <div key={r.id}>
                <span className="history-photo history-photo-a" />
                <p>
                  <strong>{r.name}</strong>
                  <small>房间号 {r.room_number} · {r.online_count} 人</small>
                  <small><Clock3 />{r.ended_at ? new Date(r.ended_at).toLocaleString('zh-CN') : ''}</small>
                </p>
                <b>已结束</b>
              </div>
            ))}
          </div>
        </>
      )}

      {createPortal(
        <button className="create-fab" onClick={handleFab} disabled={isCheckingActive}>
          {isCheckingActive
            ? <Loader2 size={16} className="spin-icon" />
            : isActiveError
              ? <AlertCircle size={16} />
              : activeRoom ? <ChevronRight size={16} /> : <Plus />}
          <span>{fabLabel}</span>
        </button>,
        document.querySelector('.mobile-app') ?? document.body
      )}
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
        await supabase.from('rooms').update({ cover_url: coverUrl }).eq('id', room.id);
        finalRoom = { ...room, cover_url: coverUrl };
        setCoverStatus('idle');
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
    <div className="screen padded-screen">
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
          <button
            className="cr-pwd-refresh-pill"
            onClick={() => { setPassword(genPassword()); setPwdError(''); }}
            type="button"
          ><RefreshCw size={11} />随机生成</button>
        </div>
        <div className="create-code-row" style={{ marginTop: 12 }} onClick={() => pwdInputRef.current?.focus()}>
          {Array.from({ length: 6 }).map((_, i) => (
            <span key={i} className={password[i] ? 'filled' : ''}>{password[i] ?? ''}</span>
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

      <div className="success-mark-wrap">
        <span className="success-mark"><Check /></span>
        <i /><i /><i />
      </div>
      <h2>房间创建成功</h2>
      <p>游客可通过房间号或分享链接加入，对方打开后需输入房间密码</p>

      <div className="success-room-card">
        {/* 房间封面 16:9 */}
        <div className="success-room-cover-wrap">
          {room.cover_url
            ? <img src={room.cover_url} className="success-room-cover-img" alt="封面" />
            : <div className="success-room-cover-placeholder" />
          }
        </div>
        {/* 导游信息 */}
        <div className="success-room-info">
          <Avatar url={profile?.avatar_url} className="success-guide-avatar" />
          <div>
            <p className="success-guide-name">{profile?.nickname ?? '导游'}</p>
            <h3>{room.name}</h3>
          </div>
        </div>
        {/* 房间号 + 密码（从本次创建流程 sessionStorage 读取，不从 DB 读）+ 二维码 */}
        <div className="success-secret">
          <p>
            <span><Landmark size={14} />房间号</span>
            <strong className="success-room-number">{room.room_number}</strong>
          </p>
          <p>
            <span><LockKeyhole size={14} />房间密码</span>
            <strong className="success-pwd-digits">{displayPwd || '——'}</strong>
          </p>
          <div className="real-qr">
            <QRCodeDataUrl text={inviteUrl} width={105} />
            <p className="success-qr-hint">扫码进入房间（需输入密码）</p>
          </div>
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
function GuideLiveInner({ go }: Props) {
  const { user, profile, currentRoom, setCurrentRoom } = useAuth();
  const [members, setMembers] = useState<RoomMember[]>([]);
  // Presence：导游侧订阅同一 topic，tourist 人数为唯一真值；导游不 track
  const { touristCount } = useRoomPresence();
  const [questions, setQuestions] = useState<Question[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [sessionStartedAt, setSessionStartedAt] = useState<number | null>(null);
  const [showEndConfirm, setShowEndConfirm] = useState(false);
  const [endBusy, setEndBusy] = useState(false);
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
  const [processingCount, setProcessingCount] = useState(0);
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [voiceError, setVoiceError] = useState('');
  const [micPerm, setMicPerm] = useState<'checking' | 'granted' | 'denied' | 'unknown'>('checking');
  const streamRef = useRef<MediaStream | null>(null);
  const isLiveRef = useRef(false);
  const cycleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeMrRef = useRef<MediaRecorder | null>(null);

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
  const { initSignaling, startMic, stopMic } = useWebRTC({
    roomId: currentRoom?.id ?? '',
    participantId: user?.id ?? '',
    isOwner: true,
  });

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
    fetchRoomMembersSafe(currentRoom.id).then(setMembers);
    fetchQuestions(currentRoom.id).then(setQuestions);
    // 初始拉取已推送卡片数（新流程：kc_card_id 非空，与旧中间层 room_card_id 无关）
    supabase.from('card_pushes').select('id', { count: 'exact', head: true })
      .eq('room_id', currentRoom.id)
      .not('kc_card_id', 'is', null)
      .then(({ count }) => setPushedCount(count ?? 0));

    const ch = supabase.channel(`guide-live-${currentRoom.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'questions', filter: `room_id=eq.${currentRoom.id}` },
        payload => {
          const q = payload.new as Question;
          setQuestions(prev => {
            // 主键去重，防 Realtime 断线重连重放
            if (prev.some(x => x.id === q.id)) return prev;
            return [q, ...prev];
          });
        })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'room_members', filter: `room_id=eq.${currentRoom.id}` },
        () => fetchRoomMembersSafe(currentRoom.id).then(setMembers))
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'card_pushes', filter: `room_id=eq.${currentRoom.id}` },
        payload => {
          // 只统计新流程推送（kc_card_id 非空，与旧中间层 room_card_id 无关）
          if ((payload.new as { kc_card_id?: string }).kc_card_id) {
            setPushedCount(prev => prev + 1);
          }
        });

    // 将字幕监听合并到同一 channel，减少独立 subtitles channel 的数据库连接占用
    const subtitleCleanup = attachSubtitleListener(ch, currentRoom.id, s => setSubtitles(prev =>
      [...prev.filter(item => item.id !== s.id), s]
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
    ));

    // 使用 subscribeWithFallback：连接异常时自动降级为 3s 增量轮询，恢复后停止轮询
    const fbCleanup = subscribeWithFallback(
      ch,
      `guide-live-${currentRoom.id}`,
      currentRoom.id,
      setRealtimeSyncStatus,
      s => {
        // 轮询新字幕同步更新导游字幕预览（fingerprint 去重已在 subscribeWithFallback 内处理）
        setSubtitles(prev =>
          [...prev.filter(item => item.id !== s.id), s]
            .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())
        );
      }
    );

    return () => { subtitleCleanup.unsubscribe(); fbCleanup.unsubscribe(); supabase.removeChannel(ch); };
  }, [currentRoom?.id]);

  // 讲解计时：仅当本次会话已实际开始（isLive=true 或 sessionStorage 有本房间记录）时才倒数。
  // ready 状态（isLive=false 且无 sessionStorage 记录）始终显示 00:00:00。
  useEffect(() => {
    if (!currentRoom) return;
    const storageKey = `shiguang-live-start-${currentRoom.id}`;
    // 只采信 sessionStorage（本次标签页操作写入的真实开始时刻）
    // 不读 currentRoom.started_at：避免重新进入旧 live 房间时从历史时间算起
    const fromSession = Number(sessionStorage.getItem(storageKey) || 0);
    const startedAt = (Number.isFinite(fromSession) && fromSession > 0) ? fromSession : null;
    setSessionStartedAt(startedAt);
  }, [currentRoom?.id]);

  // handleStart 写入 sessionStorage 后需更新计时器起点（不依赖 currentRoom?.started_at 重触发）
  const applySessionStart = useCallback((ms: number) => {
    setSessionStartedAt(ms);
  }, []);

  useEffect(() => {
    // 仅在 live 且有明确起点时运行计时器；非 live 时 elapsed 归零
    if (!sessionStartedAt || !isLive) { setElapsed(0); return; }
    const updateElapsed = () => setElapsed(Math.max(0, Math.floor((Date.now() - sessionStartedAt) / 1000)));
    updateElapsed();
    const timer = window.setInterval(updateElapsed, 1000);
    return () => window.clearInterval(timer);
  }, [sessionStartedAt, isLive]);

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

    try {
      setVoiceError('');
      setIsStarting(true); // ① 立即进入 starting，禁用按钮防止重复点击

      // ② 麦克风授权（失败 → catch → failed/ready）
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      streamRef.current = stream;

      // ③ WebRTC/BRTC 推流启动（非阻断：失败只报 warning，不阻断字幕链路，
      //    starting 状态继续保持直到 DB 写入成功）
      startMic(stream).then(micStarted => {
        if (!micStarted) {
          const msg = '中文原声推流失败，字幕仍在生成中';
          setVoiceError(msg);
          toast.warning(msg);
        }
      }).catch(err => {
        const msg = `中文原声推流异常：${err instanceof Error ? err.message : '未知错误'}，字幕仍在生成中`;
        setVoiceError(msg);
        toast.warning(msg);
      });

      // ④ 房间状态写入（pending → live 首次才写；已 live 的房间不重写 started_at）
      if (currentRoom.status !== 'live') {
        const startedAt = new Date().toISOString();
        const startedMs = new Date(startedAt).getTime();
        const { error: dbErr } = await updateRoomStatus(currentRoom.id, 'live', { started_at: startedAt });
        if (dbErr) {
          // DB 写入失败 → 完整回滚，保持 starting=false/isLive=false → failed
          stream.getTracks().forEach(t => t.stop());
          streamRef.current = null;
          isLiveRef.current = false;
          setIsStarting(false);
          stopMic();
          const msg = '开始讲解失败（数据库更新错误），请稍后重试';
          setVoiceError(msg);
          toast.error(msg);
          return;
        }
        // ⑤ DB 成功 → 写入 sessionStorage，此时才切换到 live，计时器正式启动
        sessionStorage.setItem(`shiguang-live-start-${currentRoom.id}`, String(startedMs));
        setSessionStartedAt(startedMs);
        setCurrentRoom({ ...currentRoom, status: 'live', started_at: startedAt });
        applySessionStart(startedMs);
      }

      // ⑥ 完整流程成功：isStarting → false，isLive → true
      isLiveRef.current = true;
      setIsLive(true);
      setIsStarting(false);

      // ⑦ ASR 分片录音独立启动（不依赖 WebRTC 推流结果）
      startCycle(stream, currentRoom.id);
      toast.success('中文原声、双语字幕与英文语音生成已开始');
    } catch (err) {
      // 任意步骤抛出异常 → 完整回滚 → failed
      isLiveRef.current = false;
      setIsLive(false);
      setIsStarting(false);
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(track => track.stop());
        streamRef.current = null;
      }
      stopMic();
      let friendlyMsg = '无法启动语音讲解，请稍后重试';
      if (err instanceof Error) {
        const name = (err as DOMException).name ?? '';
        const msg = err.message.toLowerCase();
        if (name === 'NotAllowedError' || msg.includes('not allowed') || msg.includes('permission') || msg.includes('denied')) {
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

  // ─── 等待 FIFO 队列排空（最长 15 秒）────────────────────────────────
  const waitQueueDrain = useCallback((): Promise<void> => {
    return new Promise(resolve => {
      const deadline = Date.now() + 15_000;
      const check = () => {
        if (asrQueueRef.current.length === 0 && !processorRunningRef.current) {
          resolve(); return;
        }
        if (Date.now() >= deadline) { resolve(); return; }
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
    // 1. 先 arm flush Promise（stop() 前），再置 isLiveRef=false 阻止 onstop 重启
    const flushDone = armStopFlush();
    isLiveRef.current = false;
    setIsLive(false);
    if (cycleTimerRef.current) { clearTimeout(cycleTimerRef.current); cycleTimerRef.current = null; }
    if (activeMrRef.current?.state === 'recording') activeMrRef.current.stop();
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    stopMic();
    // 2. 等待 onstop 把最后一段推入队列（不等 ASR 完成，队列继续串行消费）
    await flushDone;
    toast.info('实时讲解已暂停，最后一段字幕正在生成…');
  };

  useEffect(() => () => {
    isLiveRef.current = false;
    if (cycleTimerRef.current) clearTimeout(cycleTimerRef.current);
    if (streamRef.current) streamRef.current.getTracks().forEach(t => t.stop());
  }, []);

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
    if (!currentRoom) return;
    setEndBusy(true);

    // 1. arm flush Promise（必须在 stop() 之前）
    const flushDone = armStopFlush();

    // 2. 停止录音（isLiveRef=false 防止 onstop 重启下一段）
    isLiveRef.current = false;
    setIsLive(false);
    if (cycleTimerRef.current) { clearTimeout(cycleTimerRef.current); cycleTimerRef.current = null; }
    if (activeMrRef.current?.state === 'recording') activeMrRef.current.stop();
    if (streamRef.current) { streamRef.current.getTracks().forEach(t => t.stop()); streamRef.current = null; }
    stopMic();

    // 3. 等待 onstop 完成 enqueueAsr（最后一段已进入 FIFO）
    await flushDone;

    // 4. 等待 FIFO 队列排空（最长 15 秒，含 flush 时间）
    await waitQueueDrain();
    const timedOut = asrQueueRef.current.length > 0 || processorRunningRef.current;

    // 5. 写 ended
    await updateRoomStatus(currentRoom.id, 'ended', { ended_at: new Date().toISOString() });
    sessionStorage.removeItem(`shiguang-live-start-${currentRoom.id}`);
    setEndBusy(false);
    setCurrentRoom(null);
    if (timedOut) {
      toast.warning('房间已结束，最后一段字幕可能仍在处理中');
    } else {
      toast.success('讲解已结束');
    }
    go('guide-home');
  };

  // 真实可达状态：ready（未开始/停止后）| starting（启动中）| live（讲解中）| ended（房间已结束）| failed（启动失败）
  // handleStop 后 isLive=false、voiceError='' → 落入 ready，无 paused 状态
  type LectureUiState = 'ready' | 'starting' | 'live' | 'ended' | 'failed';
  const lectureUiState = useMemo<LectureUiState>(() => {
    if (currentRoom.status === 'ended') return 'ended';
    if (isStarting) return 'starting';
    if (isLive) return 'live';
    if (voiceError) return 'failed';
    return 'ready';
  }, [currentRoom.status, isStarting, isLive, voiceError]);

  // ── 合并实时内容区：字幕 + 提问按时间升序排列，稳定 key，ID 去重
  type ContentItem =
    | { kind: 'subtitle'; id: string; ts: number; data: Subtitle }
    | { kind: 'question'; id: string; ts: number; data: Question };

  const contentItems = useMemo<ContentItem[]>(() => {
    const subs: ContentItem[] = subtitles.map(s => ({
      kind: 'subtitle', id: `sub-${s.id}`, ts: new Date(s.created_at).getTime(), data: s,
    }));
    const qs: ContentItem[] = questions.map(q => ({
      kind: 'question', id: `q-${q.id}`, ts: new Date(q.created_at).getTime(), data: q,
    }));
    return [...subs, ...qs].sort((a, b) => a.ts - b.ts);
  }, [subtitles, questions]);

  // ── 实时内容区：新内容到达时在用户接近底部时自动滚至底部
  const contentScrollRef = useRef<HTMLDivElement>(null);
  const prevItemCountRef = useRef(0);
  useEffect(() => {
    const el = contentScrollRef.current;
    if (!el || contentItems.length === prevItemCountRef.current) return;
    prevItemCountRef.current = contentItems.length;
    const threshold = 80; // px
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
    if (nearBottom) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [contentItems]);

  return (
    <div className="screen padded-screen">
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
        房间号 {currentRoom.room_number} · 在线 <b>{touristCount}</b> 人
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

      {/* 导游信息卡：所有文案/状态由 lectureUiState 单一驱动 */}
      <div className="live-host-card">
        <Avatar url={profile?.avatar_url} />
        <div className="live-host-copy">
          <div className="host-name-row">
            <h2>{profile?.nickname ?? '导游'}</h2>
            <span
              className={`live-label ${lectureUiState === 'live' ? 'is-live' : lectureUiState === 'starting' ? 'is-starting' : 'is-ready'}`}
              aria-live="polite"
            >
              <CircleDot />
              {lectureUiState === 'live'     ? '正在讲解'
                : lectureUiState === 'starting' ? '正在连接'
                : lectureUiState === 'ended'    ? '已结束'
                : lectureUiState === 'failed'   ? '连接失败'
                :                                 '设备已就绪'}
            </span>
          </div>
          <Wave active={lectureUiState === 'live'} />
          {/* 计时器：live 时运行计时；ready/starting/failed/ended 显示 00:00:00 */}
          <strong className="timer" aria-label="讲解时长">
            {lectureUiState === 'live' ? fmt(elapsed) : '00:00:00'}
          </strong>
          <p>
            {lectureUiState === 'live'
              ? '中文原声讲解中 · 字幕实时生成'
              : lectureUiState === 'starting'
              ? '正在建立连接，请稍候…'
              : touristCount > 0
              ? `${touristCount} 位游客在线 · 准备讲解`
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
        </div>
        <div className="mic-center">
          {(micPerm === 'denied' || micPerm === 'unknown') && (
            <div className={`mic-perm-banner ${micPerm}`}>
              {micPerm === 'denied' ? <MicOff size={14} /> : <Mic size={14} />}
              <span>
                {micPerm === 'denied'
                  ? '麦克风权限已被禁止，请在浏览器地址栏左侧点击锁形图标开启权限后重试'
                  : '点击下方按钮后，请在弹出的权限请求中选择「允许」以使用麦克风'}
              </span>
            </div>
          )}
          {lectureUiState === 'starting' ? (
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
              aria-label={lectureUiState === 'failed' ? '重新开始讲解' : '开始讲解'}
              disabled={lectureUiState === 'ended'}
            >
              <Mic size={30} />
            </button>
          )}
          <strong className="mic-action-title">
            {lectureUiState === 'live'     ? '正在传输中文原声'
              : lectureUiState === 'starting' ? '正在连接，请稍候'
              : lectureUiState === 'failed'   ? '点击重新开始讲解'
              :                                 '点击开始语音讲解'}
          </strong>
          <p className="mic-hint">
            {lectureUiState === 'live'
              ? '游客实时收听中文；英文语音与双语字幕同步生成'
              : '系统将自动生成中英字幕及英文语音'}
          </p>
          {voiceError && (
            <div className="voice-error-block" role="alert">
              <p className="voice-error-msg">{voiceError}</p>
            </div>
          )}
        </div>
      </div>

      <div className="guide-tools">
        <button onClick={() => go('guest-list')}>
          <span className="tool-icon-wrap">
            <UsersRound />
            {touristCount > 0 && <i className="tool-badge">{touristCount}</i>}
          </span>
          游客列表
        </button>
        <button onClick={() => go('guide-subtitle-record')}>
          <span className="tool-icon-wrap">
            <Languages />
            {subtitles.length > 0 && <i className="tool-badge">{subtitles.length}</i>}
          </span>
          字幕记录
        </button>
        <button onClick={() => go('card-library')}>
          <span className="tool-icon-wrap">
            <Landmark />
            {pushedCount > 0 && <i className="tool-badge">{pushedCount}</i>}
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
        {/* aria-live="polite"：新内容到达时由辅助技术通报，不打断当前朗读 */}
        <div
          className="live-content-stream__list"
          ref={contentScrollRef}
          aria-live="polite"
          aria-label="实时字幕与游客提问"
        >
          {contentItems.length === 0 ? (
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
            ) : (
              <article key={item.id} className="lcs-bubble lcs-bubble--question" aria-label="游客提问">
                <p className="lcs-bubble__main">
                  {`${(item.data as Question).profile?.nickname?.trim() || '游客'}：${(item.data as Question).content}`}
                </p>
                {(item.data as Question).translated_text && (
                  <p className="lcs-bubble__sub">{(item.data as Question).translated_text}</p>
                )}
              </article>
            )
          )}
        </div>
      </div>

      {/* 解散房间确认弹窗 */}
      {showEndConfirm && (
        <div className="end-confirm-overlay" onClick={() => !endBusy && setShowEndConfirm(false)}>
          <div className="end-confirm-sheet" onClick={e => e.stopPropagation()}>
            <div className="end-confirm-icon"><LogOut size={26} /></div>
            <h3>确认解散房间？</h3>
            <p>结束后游客将无法继续收听，讲解记录将被保存。</p>
            <div className="end-confirm-actions">
              <button className="end-confirm-cancel" onClick={() => setShowEndConfirm(false)} disabled={endBusy}>取消</button>
              <button className="end-confirm-ok" onClick={handleEndSession} disabled={endBusy}>
                {endBusy ? '正在保存最后一段…' : '确认解散'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * GuideLive 外层：挂载导游侧 Presence 订阅（仅订阅，不 track，role='guide'）。
 * 与 GuestList 共享同一 topic（room-presence-{roomId}），切换页面时分别独立创建实例；
 * 两者不会同时渲染（ScreenRouter 路由互斥），不存在重复 channel 问题。
 */
export function GuideLive({ go }: Props) {
  const { currentRoom, user } = useAuth();
  return (
    <RoomPresenceProvider
      roomId={currentRoom?.id ?? ''}
      userId={user?.id ?? ''}
      role="guide"
    >
      <GuideLiveInner go={go} />
    </RoomPresenceProvider>
  );
}

// ─── 结束确认 ─────────────────────────────────────────
export function EndConfirm({ go }: Props) {
  const { currentRoom, setCurrentRoom, profile } = useAuth();
  const [busy, setBusy] = useState(false);

  const handleEnd = async () => {
    if (!currentRoom) return;
    setBusy(true);
    await updateRoomStatus(currentRoom.id, 'ended', {
      ended_at: new Date().toISOString(),
    });
    sessionStorage.removeItem(`shiguang-live-start-${currentRoom.id}`);
    setBusy(false);
    setCurrentRoom(null);
    toast.success('讲解已结束');
    go('guide-home');
  };

  return (
    <div className="screen padded-screen modal-page">
      <div className="end-background">
        <div className="end-guide-head">
          <Avatar url={profile?.avatar_url} />
          <div>
            <h2>导游控制台</h2>
            <p>{currentRoom?.name}</p>
            <small>房间号 {currentRoom?.room_number}</small>
          </div>
        </div>
      </div>

      <div className="sheet-modal exact-end-sheet">
        <i className="sheet-handle" />
        <h2>结束本次讲解？</h2>
        <p>游客将停止接收语音、字幕记录保留。</p>
        <label>✓　结束后生成讲解记录</label>
        <button className="danger-button" onClick={handleEnd} disabled={busy}>
          {busy ? '结束中…' : '确认结束'}
        </button>
        <button className="continue-button" onClick={() => go('guide-live')}>
          继续讲解
        </button>
      </div>
    </div>
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
  const navMap: Record<string, NavItem[]> = {
    guide:        [[Landmark, '房间', 'guide-home'], [History, '记录', 'records'], [UsersRound, '我的', 'my']],
    tour:         [[Landmark, '房间', 'room-list'],  [History, '最近', 'recent-rooms'], [UsersRound, '我的', 'tourist-my']],
    visitorHome:  [[Landmark, '房间', 'room-list'],  [History, '最近', 'recent-rooms'], [UsersRound, '我的', 'tourist-my']],
    photographer: [[Landmark, '任务', 'photographer-tasks'], [Images, '相册', 'photographer-album'], [UsersRound, '我的', 'photographer-my']],
    room:         [[Headphones, '语音', 'listening'], [AlignLeft, '字幕', 'subtitle-tab'], [ImageIcon, '相册', 'room-album']],
  };
  const items = navMap[variant] ?? navMap.tour;

  return (
    <div className="bottom-nav">
      {items.map(([Icon, name, target]) => (
        <button
          key={name as string}
          className={active === name ? 'active' : ''}
          onClick={() => go?.(target as string)}
        >
          <Icon aria-hidden="true" />
          <span>{name}</span>
        </button>
      ))}
    </div>
  );
}
