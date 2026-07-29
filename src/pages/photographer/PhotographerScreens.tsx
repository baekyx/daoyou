/**
 * 摄影师端完整页面：
 * - PhotographerTasks  (C01/C02)  任务 Tab
 * - PhotographerJoin   (C03)      加入验证
 * - PhotographerWait   (C04)      等待审批
 * - PhotographerAlbum  (C06/C07)  相册 Tab
 * - PhotoDeleteRequest (C08)      删除申请
 * - PhotographerMyPage (C09)      摄影师我的
 */
import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
  ChevronRight, QrCode, Radio, Clock3, Trash2,
  CheckCircle2, XCircle, RefreshCw, Plus, UserRound,
  LogOut, HelpCircle, Landmark,
  Upload as UploadIcon, Images,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/db/supabase';
import { fetchActiveRooms, fetchRoomByNumber } from '@/api/rooms';
import { verifyRoomPasswordOnly } from '@/api/roomActivity';
import { uploadPhoto } from '@/api/photos';
import { fetchPhotosSafe } from '@/api/photosSecure';
import type { Room, Photo, Membership, UploadQueueItem } from '@/types/types';
import { toast } from 'sonner';
import { BottomNav } from '@/pages/guide/GuideScreens';

interface Props { go: (id: string) => void }

function Avatar({ url, className = '' }: { url?: string | null; className?: string }) {
  if (url) return <img src={url} className={`avatar ${className}`} alt="头像" style={{ objectFit: 'cover' }} />;
  return <div className={`avatar ${className}`} />;
}

// ─── C01/C02 任务 Tab ─────────────────────────────────
export function PhotographerTasks({ go }: Props) {
  const { user, profile, setCurrentRoom } = useAuth();
  const [memberships, setMemberships] = useState<(Membership & { rooms: Room })[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<'active' | 'done'>('active');

  useEffect(() => {
    if (!user) return;
    supabase
      .from('memberships')
      .select('*, rooms(*)')
      .eq('user_id', user.id)
      .eq('role', 'photographer')
      .order('joined_at', { ascending: false })
      .then(({ data }) => {
        setMemberships((data ?? []) as unknown as (Membership & { rooms: Room })[]);
        setLoading(false);
      });
  }, [user]);

  const active = memberships.filter(m => ['pending', 'approved'].includes(m.approval_status) && m.rooms?.status !== 'ended');
  const done = memberships.filter(m => m.approval_status === 'rejected' || m.rooms?.status === 'ended');
  const displayed = tab === 'active' ? active : done;

  const statusText = (m: Membership & { rooms: Room }) => {
    if (m.approval_status === 'pending') return { text: '待审批', cls: 'task-status-pending' };
    if (m.approval_status === 'rejected') return { text: '已拒绝', cls: 'task-status-rejected' };
    if (m.rooms?.status === 'live') return { text: '进行中', cls: 'task-status-live' };
    if (m.rooms?.status === 'ended') return { text: '已结束', cls: 'task-status-done' };
    return { text: '等待开始', cls: 'task-status-ready' };
  };

  return (
    <div className="screen padded-screen has-tabbar">
      <div className="photographer-hero">
        <p>你好，{profile?.nickname ?? '摄影师'} 👋</p>
        <h1>拍摄任务</h1>
        <i />
      </div>

      <button className="scan-room" onClick={() => go('photo-join')}>
        <span><QrCode /></span>
        <p>
          <strong>扫码 / 输入房间号加入</strong>
          <small>加入房间后等待导游审批</small>
        </p>
        <b><ChevronRight /></b>
      </button>

      <div className="member-tab-row" style={{ marginTop: 16 }}>
        <button className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')}>
          进行中 {active.length > 0 && <span className="tab-badge">{active.length}</span>}
        </button>
        <button className={tab === 'done' ? 'active' : ''} onClick={() => setTab('done')}>已完成</button>
      </div>

      {loading ? (
        <div className="loading-state"><div className="spinner" /><span>加载中…</span></div>
      ) : displayed.length === 0 ? (
        <div className="empty-state">
          <Images size={40} className="empty-icon" />
          <p className="empty-title">{tab === 'active' ? '还没有拍摄任务' : '暂无已完成任务'}</p>
          <small className="empty-desc">{tab === 'active' ? '扫码加入导游房间，等待审批后即可上传照片' : '完成的任务将显示在这里'}</small>
          {tab === 'active' && <button className="empty-action-btn" onClick={() => go('photo-join')}>加入房间</button>}
        </div>
      ) : (
        <div className="task-list">
          {displayed.map(m => {
            const { text, cls } = statusText(m);
            return (
              <div key={m.id} className="task-card">
                <div className="task-cover">
                  {m.rooms?.cover_url
                    ? <img src={m.rooms.cover_url} alt={m.rooms.name} />
                    : <Landmark size={20} />
                  }
                </div>
                <div className="task-info">
                  <div className="task-head">
                    <span className="task-room-name">{m.rooms?.name ?? '—'}</span>
                    <span className={`task-status ${cls}`}>{text}</span>
                  </div>
                  <span className="task-room-num">房间号 {m.rooms?.room_number}</span>
                  {m.approval_status === 'rejected' && m.rejection_reason && (
                    <span className="task-reject-reason">拒绝原因：{m.rejection_reason}</span>
                  )}
                </div>
                {m.approval_status === 'approved' && m.rooms?.status === 'live' && (
                  <button className="task-enter-btn" onClick={() => { setCurrentRoom(m.rooms); go('upload'); }}>
                    <UploadIcon size={14} />上传
                  </button>
                )}
                {m.approval_status === 'pending' && (
                  <button className="task-wait-btn" onClick={() => { setCurrentRoom(m.rooms); go('photo-wait'); }}>
                    <Clock3 size={14} />等待中
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}

      <BottomNav active="任务" go={go} variant="photographer" />
    </div>
  );
}

// ─── C03 摄影师加入验证 ───────────────────────────────
export function PhotographerJoin({ go }: Props) {
  const { user, setCurrentRoom } = useAuth();
  const [roomNumber, setRoomNumber] = useState('');
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [step, setStep] = useState<'room' | 'password'>('room');
  const [foundRoom, setFoundRoom] = useState<Room | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRefs = useRef<(HTMLInputElement | null)[]>([]);

  const handleSearchRoom = async () => {
    if (!roomNumber.trim()) { toast.error('请输入房间号'); return; }
    setBusy(true);
    // A2 预置：使用安全 RPC 查询，不含 password 字段
    const found = await fetchRoomByNumber(roomNumber.trim());
    setBusy(false);
    if (!found) { toast.error('未找到该房间，请确认房间号'); return; }
    setFoundRoom(found as Room);
    setCurrentRoom(found as Room);
    setStep('password');
  };

  const handleDigit = (i: number, val: string) => {
    if (!/^\d?$/.test(val)) return;
    const next = [...digits];
    next[i] = val;
    setDigits(next);
    if (val && i < 5) inputRefs.current[i + 1]?.focus();
  };

  const handleJoin = async () => {
    const pwd = digits.join('');
    if (pwd.length < 6) { toast.error('请输入六位密码'); return; }
    if (!foundRoom || !user) return;
    setBusy(true);
    // A2 预置：使用 verify_room_password_only —— 仅服务端校验密码，不写 room_members
    // 摄影师不能通过 joinRoomWithPassword 获得 tourist 成员身份
    const result = await verifyRoomPasswordOnly(foundRoom.id, pwd);
    if (!result.ok) {
      setBusy(false);
      setDigits(['', '', '', '', '', '']);
      if (result.code === 'rate_limited') {
        toast.error(`连续输入错误次数过多，请 ${result.retryAfterSeconds ?? 60} 秒后再试`);
      } else if (result.code === 'wrong_password') {
        const left = result.attemptsRemaining ?? 0;
        toast.error(left > 0 ? `密码错误，还可尝试 ${left} 次` : '连续输入错误 5 次，请稍后再试');
      } else {
        toast.error('验证失败，请重试');
      }
      return;
    }
    // 密码验证通过：申请加入（摄影师 approval_status = pending，仅写 memberships，不写 room_members）
    const { error } = await supabase.from('memberships').upsert({
      room_id: foundRoom.id,
      user_id: user.id,
      role: 'photographer',
      approval_status: 'pending',
    }, { onConflict: 'room_id,user_id' });
    setBusy(false);
    if (error) { toast.error('申请失败：' + error.message); return; }
    toast.success('申请已提交，等待导游审批');
    go('photo-wait');
  };

  return (
    <div className="screen padded-screen">
      <div className="mini-header">
        <button className="back-button" onClick={() => go('photographer-tasks')} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>{step === 'room' ? '加入房间' : '验证密码'}</strong>
        <span />
      </div>

      {step === 'room' ? (
        <>
          <div className="photo-join-note">
            <UserRound size={18} />
            <p>以摄影师身份加入房间后，需等待导游审批方可上传照片。</p>
          </div>
          <div className="join-room-field">
            <label>房间号</label>
            <input
              className="profile-input"
              placeholder="请输入 6 位房间号"
              value={roomNumber}
              maxLength={6}
              inputMode="numeric"
              onChange={e => setRoomNumber(e.target.value.replace(/\D/g, ''))}
            />
          </div>
          <button className="primary-button green" onClick={handleSearchRoom} disabled={busy || roomNumber.length < 6}>
            {busy ? '查找中…' : '下一步'}
          </button>
        </>
      ) : (
        <>
          <div className="password-room-info">
            <h3>{foundRoom?.name}</h3>
            <p>房间号 {foundRoom?.room_number}</p>
          </div>
          <p className="password-hint">请输入六位数字密码</p>
          <div className="password-boxes">
            {digits.map((d, i) => (
              <input
                key={i}
                ref={el => { inputRefs.current[i] = el; }}
                id={`pd${i}`}
                className="digit-box"
                maxLength={1}
                value={d}
                onChange={e => handleDigit(i, e.target.value)}
                type="text"
                inputMode="numeric"
              />
            ))}
          </div>
          <button className="primary-button green" onClick={handleJoin}
            disabled={busy || digits.some(d => !d)}>
            {busy ? '提交中…' : '提交申请'}
          </button>
          <button className="text-button" onClick={() => setStep('room')}>重新输入房间号</button>
        </>
      )}
    </div>
  );
}

// ─── C04 等待导游审批 ─────────────────────────────────
export function PhotographerWait({ go }: Props) {
  const { user, currentRoom } = useAuth();
  const [status, setStatus] = useState<'pending' | 'approved' | 'rejected'>('pending');
  const [reason, setReason] = useState('');

  const checkStatus = useCallback(async () => {
    if (!user || !currentRoom) return;
    const { data } = await supabase
      .from('memberships')
      .select('approval_status, rejection_reason')
      .eq('user_id', user.id)
      .eq('room_id', currentRoom.id)
      .maybeSingle();
    if (!data) return;
    setStatus(data.approval_status as typeof status);
    if (data.rejection_reason) setReason(data.rejection_reason);
    if (data.approval_status === 'approved') {
      toast.success('审批通过！可以开始上传照片了');
      go('upload');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, currentRoom]);

  useEffect(() => {
    checkStatus();
    const interval = setInterval(checkStatus, 5000);
    return () => clearInterval(interval);
  }, [checkStatus]);

  const handleWithdraw = async () => {
    if (!user || !currentRoom) return;
    await supabase.from('memberships')
      .delete()
      .eq('user_id', user.id)
      .eq('room_id', currentRoom.id);
    toast.success('已撤回申请');
    go('photographer-tasks');
  };

  return (
    <div className="screen padded-screen photo-wait-screen">
      <div className="mini-header">
        <button className="back-button" onClick={() => go('photographer-tasks')} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>等待审批</strong>
        <span />
      </div>

      <div className="wait-room-card">
        <Landmark size={28} className="wait-room-icon" />
        <h3>{currentRoom?.name ?? '—'}</h3>
        <p>房间号 {currentRoom?.room_number}</p>
      </div>

      {status === 'pending' && (
        <div className="wait-status-area">
          <div className="wait-spinner-wrap">
            <div className="wait-spinner" />
          </div>
          <h3>等待导游审批</h3>
          <p>申请已提交，导游确认后您将收到通知。</p>
          <button className="primary-button ghost" style={{ marginTop: 16 }} onClick={checkStatus}>
            <RefreshCw size={14} />刷新状态
          </button>
          <button className="text-button" onClick={handleWithdraw}>撤回申请</button>
        </div>
      )}

      {status === 'rejected' && (
        <div className="wait-status-area rejected">
          <XCircle size={48} className="wait-rejected-icon" />
          <h3>申请被拒绝</h3>
          {reason && <p className="wait-reason">原因：{reason}</p>}
          <button className="primary-button green" style={{ marginTop: 16 }} onClick={() => go('photo-join')}>
            重新申请
          </button>
          <button className="text-button" onClick={() => go('photographer-tasks')}>返回任务列表</button>
        </div>
      )}
    </div>
  );
}

// ─── C06/C07 摄影师相册 Tab ────────────────────────────
export function PhotographerAlbum({ go }: Props) {
  const { user } = useAuth();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const [rooms, setRooms] = useState<Room[]>([]);
  const [filterRoom, setFilterRoom] = useState<string>('all');

  useEffect(() => {
    if (!user) return;
    // 摄影师相册读取：先取本人已批准的 memberships room_id 列表，
    // 再逐房调用 fetchPhotosSafe (SECURITY DEFINER RPC)，按 uploaded_at 合并排序。
    // 单房间失败不影响其他房间（Promise.allSettled）；最多并发 10 个房间。
    (async () => {
      const { data: mData } = await supabase
        .from('memberships')
        .select('room_id')
        .eq('user_id', user.id)
        .eq('role', 'photographer')
        .eq('approval_status', 'approved')
        .is('left_at', null)
        .limit(10);

      const roomIds: string[] = mData ? [...new Set((mData as { room_id: string }[]).map(m => m.room_id))] : [];

      if (roomIds.length === 0) {
        setPhotos([]);
        setLoading(false);
        return;
      }

      // 逐房调用 fetchPhotosSafe，最多 200 张/房
      const results = await Promise.allSettled(
        roomIds.map(rid => fetchPhotosSafe(rid, 200))
      );

      const all: Photo[] = [];
      results.forEach(r => {
        if (r.status === 'fulfilled') all.push(...r.value);
      });

      // 按 uploaded_at 降序去重（同 id 取第一次出现的）
      const seen = new Set<string>();
      const deduped = all
        .sort((a, b) => (b.uploaded_at ?? '').localeCompare(a.uploaded_at ?? ''))
        .filter(p => { if (seen.has(p.id)) return false; seen.add(p.id); return true; });

      setPhotos(deduped as Photo[]);
      setLoading(false);

      // 提取关联房间
      const usedRoomIds = [...new Set(deduped.map(p => p.room_id))];
      if (usedRoomIds.length > 0) {
        supabase.from('rooms').select('id,name,room_number').in('id', usedRoomIds).then(({ data: rd }) => {
          setRooms((rd ?? []) as Room[]);
        });
      }
    })();
  }, [user]);

  const filtered = filterRoom === 'all' ? photos : photos.filter(p => p.room_id === filterRoom);

  const handleDeleteRequest = (photo: Photo) => {
    sessionStorage.setItem('delete_photo', JSON.stringify(photo));
    go('photo-delete');
  };

  return (
    <div className="screen padded-screen has-tabbar">
      <div className="section-heading">
        <span><Images />我的相册</span>
        <h2>已上传照片</h2>
        <p>管理你在各房间上传的照片</p>
      </div>

      {rooms.length > 0 && (
        <div className="room-filter-scroll">
          <button className={filterRoom === 'all' ? 'active' : ''} onClick={() => setFilterRoom('all')}>全部</button>
          {rooms.map(r => (
            <button key={r.id} className={filterRoom === r.id ? 'active' : ''} onClick={() => setFilterRoom(r.id)}>
              {r.name}
            </button>
          ))}
        </div>
      )}

      {loading ? (
        <div className="loading-state"><div className="spinner" /></div>
      ) : filtered.length === 0 ? (
        <div className="empty-state">
          <Images size={40} className="empty-icon" />
          <p className="empty-title">还没有上传照片</p>
          <small className="empty-desc">完成任务审批后，可以在任务页上传照片</small>
          <button className="empty-action-btn" onClick={() => go('photographer-tasks')}>去上传照片</button>
        </div>
      ) : (
        <div className="photo-album-grid">
          {filtered.map(p => (
            <div key={p.id} className="pa-item">
              <img src={p.url} className="pa-img" alt="照片" />
              <div className="pa-overlay">
                {p.delete_status === 'requested' && (
                  <span className="pa-delete-tag">删除申请中</span>
                )}
                <button className="pa-delete-btn" onClick={() => handleDeleteRequest(p)} title="申请删除">
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <BottomNav active="相册" go={go} variant="photographer" />
    </div>
  );
}

// ─── C08 照片删除申请 ─────────────────────────────────
export function PhotoDeleteRequest({ go }: Props) {
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const raw = sessionStorage.getItem('delete_photo');
    if (raw) { try { setPhoto(JSON.parse(raw)); } catch { /* ignore */ } }
  }, []);

  const handleSubmit = async () => {
    if (!reason.trim()) { toast.error('请填写删除原因'); return; }
    if (!photo) return;
    setBusy(true);
    await supabase.from('photos').update({ delete_status: 'requested', delete_reason: reason }).eq('id', photo.id);
    setBusy(false);
    toast.success('删除申请已提交，等待导游确认');
    sessionStorage.removeItem('delete_photo');
    go('photographer-album');
  };

  return (
    <div className="screen padded-screen">
      <div className="mini-header">
        <button className="back-button" onClick={() => go('photographer-album')} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>申请删除照片</strong>
        <span />
      </div>

      {photo && (
        <div className="delete-photo-preview">
          <img src={photo.url} className="delete-preview-img" alt="待删除照片" />
        </div>
      )}

      <div className="delete-note">
        <p>提交删除申请后，照片将标记为「等待导游处理」，导游确认前游客仍可查看原图。</p>
      </div>

      <div className="kc-field">
        <label>删除原因 *</label>
        <textarea
          className="profile-input"
          rows={3}
          placeholder="请说明删除原因，如：拍摄角度不好、隐私问题等"
          value={reason}
          onChange={e => setReason(e.target.value)}
        />
      </div>

      <button className="primary-button green" onClick={handleSubmit} disabled={busy || !reason.trim()}>
        {busy ? '提交中…' : '提交删除申请'}
      </button>
      <button className="text-button" onClick={() => go('photographer-album')}>取消</button>
    </div>
  );
}

