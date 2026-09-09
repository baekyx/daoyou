/**
 * 摄影师端完整页面：
 * - PhotographerTasks  (C01/C02)  任务 Tab
 * - PhotographerJoin   (C03)      加入验证
 * - PhotographerWait   (C04)      旧等待页兼容
 * - PhotographerAlbum  (C06/C07)  相册 Tab
 * - PhotoDeleteRequest (C08)      删除照片
 * - PhotographerMyPage (C09)      摄影师我的
 */
import React, { useCallback, useEffect, useState, useRef } from 'react';
import {
  ChevronRight, QrCode, Clock3, Trash2, Search, Radio, Users,
  Plus, UserRound, Landmark,
  Upload as UploadIcon, Images,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/db/supabase';
import { fetchActiveRoomsStrict, fetchRoomById, fetchRoomByNumber } from '@/api/rooms';
import { joinPhotographerRoomWithPassword } from '@/api/roomActivity';
import { deleteOwnPhoto } from '@/api/photos';
import { fetchPhotosSafeStrict } from '@/api/photosSecure';
import type { Room, Photo, Membership, UploadQueueItem } from '@/types/types';
import { toast } from 'sonner';
import { BottomNav } from '@/pages/guide/GuideScreens';

interface Props { go: (id: string) => void }

const REQUEST_TIMEOUT_MS = 10_000;

function withRequestTimeout<T>(request: PromiseLike<T>, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), REQUEST_TIMEOUT_MS);
    Promise.resolve(request).then(
      value => {
        window.clearTimeout(timer);
        resolve(value);
      },
      error => {
        window.clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function Avatar({ url, className = '' }: { url?: string | null; className?: string }) {
  if (url) return <img src={url} className={`avatar ${className}`} alt="头像" style={{ objectFit: 'cover' }} />;
  return <div className={`avatar ${className}`} />;
}

// ─── C01/C02 任务 Tab ─────────────────────────────────
export function PhotographerTasks({ go }: Props) {
  const { user, profile, setCurrentRoom } = useAuth();
  const [memberships, setMemberships] = useState<(Membership & { rooms: Room })[]>([]);
  const [joinableRooms, setJoinableRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [taskLoadError, setTaskLoadError] = useState('');
  const [roomListError, setRoomListError] = useState('');
  const [reloadTick, setReloadTick] = useState(0);
  const [tab, setTab] = useState<'active' | 'done'>('active');

  useEffect(() => {
    if (!user) return;
    let mounted = true;

    const loadTasks = async (showError: boolean) => {
      try {
        if (showError) setTaskLoadError('');
        const [{ data, error }, activeRoomsResult] = await Promise.all([
          withRequestTimeout(
            supabase
              .from('memberships')
              .select('*, rooms(*)')
              .eq('user_id', user.id)
              .eq('role', 'photographer')
              .order('joined_at', { ascending: false }),
            '拍摄任务加载超时',
          ),
          withRequestTimeout(fetchActiveRoomsStrict(), '进行中房间加载超时')
            .then(rooms => ({ rooms, error: '' }))
            .catch(roomError => ({
              rooms: [] as Room[],
              error: roomError instanceof Error ? roomError.message : '进行中房间加载失败',
            })),
        ]);

        if (!mounted) return;
        if (error) {
          setTaskLoadError('拍摄任务暂时无法加载');
          setLoading(false);
          if (showError) toast.error('拍摄任务加载失败，请稍后重试');
          return;
        }

        const rows = (data ?? []) as (Membership & { rooms?: Room | null })[];
        const rooms = await Promise.all(rows.map(item => (
          item.rooms
            ? Promise.resolve(item.rooms)
            : withRequestTimeout(fetchRoomById(item.room_id), '房间详情加载超时').catch(() => null)
        )));
        if (!mounted) return;

        const tasks = rows.flatMap((item, index) => {
          const room = rooms[index];
          return room ? [{ ...item, rooms: room }] : [];
        });
        setMemberships(tasks);
        setTaskLoadError('');
        const joinedRoomIds = new Set(rows.map(item => item.room_id));
        setJoinableRooms(activeRoomsResult.rooms.filter(room => (
          room.status === 'live'
          && room.discoverable !== false
          && !joinedRoomIds.has(room.id)
        )));
        setRoomListError(activeRoomsResult.error);
        setLoading(false);
      } catch {
        if (!mounted) return;
        setTaskLoadError('拍摄任务暂时无法加载');
        setLoading(false);
        if (showError) toast.error('拍摄任务加载失败，请稍后重试');
      }
    };

    void loadTasks(true);
    const timer = window.setInterval(() => void loadTasks(false), 10_000);
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void loadTasks(false);
    };
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      mounted = false;
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [user?.id, reloadTick]);

  const retryTasks = () => {
    setLoading(true);
    setTaskLoadError('');
    setReloadTick(value => value + 1);
  };

  const active = memberships.filter(m => (
    !m.left_at
    && ['pending', 'approved'].includes(m.approval_status)
    && m.rooms?.status !== 'ended'
    && m.rooms?.status !== 'archived'
  ));
  const done = memberships.filter(m => (
    Boolean(m.left_at)
    || m.approval_status === 'rejected'
    || m.rooms?.status === 'ended'
    || m.rooms?.status === 'archived'
  ));
  const displayed = tab === 'active' ? active : done;

  const statusText = (m: Membership & { rooms: Room }) => {
    if (m.approval_status === 'pending') return { text: '待验证', cls: 'task-status-pending' };
    if (m.approval_status === 'rejected') return { text: '已拒绝', cls: 'task-status-rejected' };
    if (m.rooms?.status === 'live') return { text: '进行中', cls: 'task-status-live' };
    if (m.rooms?.status === 'ended' || m.rooms?.status === 'archived') {
      return { text: '已结束', cls: 'task-status-done' };
    }
    return { text: '等待开始', cls: 'task-status-ready' };
  };

  const openTask = (membership: Membership & { rooms: Room }) => {
    setCurrentRoom(membership.rooms);
    if (membership.approval_status === 'pending') {
      sessionStorage.setItem('photographer-reverify-room', JSON.stringify(membership.rooms));
      go('photo-join');
      return;
    }
    if (membership.approval_status !== 'approved') {
      toast.error(membership.rejection_reason
        ? `申请未通过：${membership.rejection_reason}`
        : '该房间暂不可进入');
      return;
    }
    if (membership.rooms.status === 'ended' || membership.rooms.status === 'archived') {
      go('subtitle-history');
      return;
    }
    go('upload');
  };

  const verifyAndJoinRoom = (room: Room) => {
    setCurrentRoom(room);
    sessionStorage.setItem('photographer-reverify-room', JSON.stringify(room));
    go('photo-join');
  };

  return (
    <div className="screen padded-screen has-tabbar photographer-tasks-screen">
      <div className="photographer-page-scroll">
      <div className="photographer-hero">
        <div className="photographer-hero-copy">
          <p>你好，{profile?.nickname ?? '摄影师'} 👋</p>
          <h1>拍摄任务</h1>
          <span>管理已加入房间，继续上传现场照片。</span>
        </div>
        <div className="photographer-cutout" aria-hidden="true" />
      </div>

      <section className="photographer-my-tasks" aria-labelledby="photographer-my-tasks-title">
        <div className="photographer-section-heading">
          <div>
            <h2 id="photographer-my-tasks-title">我的任务</h2>
            <p>进入已加入房间，继续拍摄与上传。</p>
          </div>
          <span>{active.length + done.length} 个</span>
        </div>

        <div className="member-tab-row">
          <button className={tab === 'active' ? 'active' : ''} onClick={() => setTab('active')} aria-pressed={tab === 'active'}>
            进行中 {active.length > 0 && <span className="tab-badge">{active.length}</span>}
          </button>
          <button className={tab === 'done' ? 'active' : ''} onClick={() => setTab('done')} aria-pressed={tab === 'done'}>已完成</button>
        </div>

        {loading ? (
          <div className="photographer-task-loading" aria-busy="true" aria-label="正在加载拍摄任务">
            <span><i /><b /></span>
            <span><i /><b /></span>
          </div>
        ) : taskLoadError ? (
          <div className="empty-state photographer-task-empty photographer-task-error" role="alert">
            <Images size={40} className="empty-icon" />
            <p className="empty-title">{taskLoadError}</p>
            <small className="empty-desc">请检查网络后重试，已加入的任务不会丢失</small>
            <button className="empty-action-btn" onClick={retryTasks}>重新加载</button>
          </div>
        ) : displayed.length === 0 ? (
          <div className="empty-state photographer-task-empty">
            <Images size={40} className="empty-icon" />
            <p className="empty-title">{tab === 'active' ? '还没有已加入的任务' : '暂无已完成任务'}</p>
            {tab === 'done' && <small className="empty-desc">完成的任务将显示在这里</small>}
            {tab === 'active' && <small className="empty-desc">可从下方发现房间，或输入房间号加入</small>}
            {tab === 'active' && <button className="empty-action-btn" onClick={() => go('photo-join')}>输入房间号</button>}
          </div>
        ) : (
          <div className={`task-list task-list-${tab}`}>
            {displayed.map(m => {
              const { text, cls } = statusText(m);
              return (
                <button
                  key={m.id}
                  type="button"
                  className={`task-card task-card-clickable ${tab === 'active' ? 'task-card-primary' : 'task-card-completed'}`}
                  onClick={() => openTask(m)}
                  aria-label={`${m.rooms.name}，${text}`}
                >
                  <div className="task-cover">
                    {m.rooms?.cover_url
                      ? <img src={m.rooms.cover_url} alt={m.rooms.name} />
                      : <Landmark size={20} />
                    }
                  </div>
                  <div className="task-info">
                    <div className="task-head">
                      <span className="task-room-name">{m.rooms?.name ?? '未命名房间'}</span>
                      <span className={`task-status ${cls}`}>{text}</span>
                    </div>
                    <span className="task-room-num">房间号 {m.rooms?.room_number}</span>
                    {m.approval_status === 'rejected' && m.rejection_reason && (
                      <span className="task-reject-reason">拒绝原因：{m.rejection_reason}</span>
                    )}
                  </div>
                  <span className={m.approval_status === 'approved' ? 'task-enter-btn' : 'task-wait-btn'}>
                    {m.approval_status === 'approved'
                      ? (m.rooms.status === 'ended' || m.rooms.status === 'archived'
                        ? <><Clock3 size={14} />字幕/纪要</>
                        : <><UploadIcon size={14} />上传照片</>)
                      : <><Clock3 size={14} />查看</>
                    }
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </section>

      <button className="scan-room" onClick={() => go('photo-join')}>
        <span><Search /></span>
        <p>
          <strong>加入新房间</strong>
          <small>输入房间号与密码，加入拍摄任务</small>
        </p>
        <b><ChevronRight /></b>
      </button>

      <section className="joinable-room-section" aria-labelledby="joinable-room-title">
        <div className="joinable-room-heading">
          <div>
            <strong id="joinable-room-title">发现房间</strong>
            <span>可加入正在直播的讲解</span>
          </div>
          <Radio size={18} aria-hidden="true" />
        </div>
        {loading ? (
          <div className="joinable-room-loading"><div className="spinner" /><span>正在查找房间…</span></div>
        ) : roomListError ? (
          <div className="joinable-room-message" role="alert">
            房间列表暂时加载失败，可使用上方房间号加入。
          </div>
        ) : joinableRooms.length === 0 ? (
          <div className="joinable-room-message">暂无新的进行中房间</div>
        ) : (
          <div className="joinable-room-list">
            {joinableRooms.map(room => (
              <button
                key={room.id}
                type="button"
                className="joinable-room-card"
                onClick={() => verifyAndJoinRoom(room)}
                aria-label={`加入房间 ${room.name}`}
              >
                <span className="joinable-room-cover">
                  {room.cover_url
                    ? <img src={room.cover_url} alt="" />
                    : <Landmark size={20} aria-hidden="true" />}
                </span>
                <span className="joinable-room-main">
                  <strong>{room.name}</strong>
                  <small>
                    {room.guide?.nickname ?? room.guide?.username ?? '导游'}
                    <span aria-hidden="true"> · </span>
                    房间号 {room.room_number}
                  </small>
                </span>
                <span className="joinable-room-meta">
                  <b><Radio size={11} aria-hidden="true" />直播中</b>
                  <small><Users size={12} aria-hidden="true" />{room.online_count ?? 0}</small>
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
      </div>

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

  useEffect(() => {
    const raw = sessionStorage.getItem('photographer-reverify-room');
    if (!raw) return;
    sessionStorage.removeItem('photographer-reverify-room');
    try {
      const room = JSON.parse(raw) as Room;
      setFoundRoom(room);
      setCurrentRoom(room);
      setRoomNumber(room.room_number);
      setStep('password');
    } catch {
      // 数据无效时保留正常的房间号输入流程。
    }
  }, [setCurrentRoom]);

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
    const result = await joinPhotographerRoomWithPassword(foundRoom.id, pwd);
    if (!result.ok) {
      setBusy(false);
      setDigits(['', '', '', '', '', '']);
      if (result.code === 'rate_limited') {
        toast.error(`连续输入错误次数过多，请 ${result.retryAfterSeconds ?? 60} 秒后再试`);
      } else if (result.code === 'wrong_password') {
        const left = result.attemptsRemaining ?? 0;
        toast.error(left > 0 ? `密码错误，还可尝试 ${left} 次` : '连续输入错误 5 次，请稍后再试');
      } else if (result.code === 'service_not_configured') {
        toast.error('摄影师直入服务尚未配置，请先更新数据库服务');
      } else if (result.code === 'forbidden') {
        toast.error('当前账号不是摄影师身份');
      } else if (result.code === 'room_not_active') {
        toast.error('该房间已经结束，无法加入');
      } else {
        toast.error('验证失败，请重试');
      }
      return;
    }
    setBusy(false);
    toast.success('已加入房间，可以上传照片');
    go('upload');
  };

  return (
    <div className="screen padded-screen photographer-join-screen">
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
            <p>输入房间号与密码即可加入；加入状态会保留，之后可从任务列表继续上传。</p>
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
                autoComplete="one-time-code"
                aria-label={`房间密码第 ${i + 1} 位`}
              />
            ))}
          </div>
          <button className="primary-button green" onClick={handleJoin}
            disabled={busy || digits.some(d => !d)}>
            {busy ? '验证中…' : '验证并加入'}
          </button>
          <button className="text-button" onClick={() => setStep('room')}>重新输入房间号</button>
        </>
      )}
    </div>
  );
}

// ─── C04 旧版等待页兼容：引导重新验证密码 ──────────────
export function PhotographerWait({ go }: Props) {
  const { currentRoom } = useAuth();

  const continueWithPassword = () => {
    if (currentRoom) {
      sessionStorage.setItem('photographer-reverify-room', JSON.stringify(currentRoom));
    }
    go('photo-join');
  };

  return (
    <div className="screen padded-screen photo-wait-screen photographer-flow-screen">
      <div className="mini-header">
        <button className="back-button" onClick={() => go('photographer-tasks')} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>验证房间密码</strong>
        <span />
      </div>

      <div className="wait-room-card">
        <Landmark size={28} className="wait-room-icon" />
        <h3>{currentRoom?.name ?? '—'}</h3>
        <p>房间号 {currentRoom?.room_number}</p>
      </div>

      <div className="wait-status-area">
        <QrCode size={48} className="wait-room-icon" />
        <h3>无需等待导游审批</h3>
        <p>重新输入房间密码，验证成功后即可进入房间上传照片。</p>
        <button className="primary-button green" style={{ marginTop: 16 }} onClick={continueWithPassword}>
          输入房间密码
        </button>
      </div>
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
  const [loadError, setLoadError] = useState('');
  const [hasMorePhotos, setHasMorePhotos] = useState(false);
  const albumRequestId = useRef(0);

  const loadAlbum = useCallback(async () => {
    if (!user) {
      setLoading(false);
      return;
    }
    const requestId = ++albumRequestId.current;
    // 摄影师相册读取：先取本人已通过密码加入的 memberships room_id 列表，
    // 再逐房调用 fetchPhotosSafe (SECURITY DEFINER RPC)，按 uploaded_at 合并排序。
    // 单房间失败不影响其他房间（Promise.allSettled）。
    setLoading(true);
    setLoadError('');
    setHasMorePhotos(false);

    try {
      const { data: mData, error: membershipError } = await withRequestTimeout(
        supabase
          .from('memberships')
          .select('room_id')
          .eq('user_id', user.id)
          .eq('role', 'photographer')
          .eq('approval_status', 'approved')
          .order('joined_at', { ascending: false })
          .limit(100),
        '相册房间加载超时',
      );
      if (requestId !== albumRequestId.current) return;
      if (membershipError) {
        setLoadError('相册房间读取失败，请稍后重试');
        setLoading(false);
        return;
      }

      const roomIds: string[] = mData ? [...new Set((mData as { room_id: string }[]).map(m => m.room_id))] : [];

      if (roomIds.length === 0) {
        setPhotos([]);
        setRooms([]);
        setLoading(false);
        return;
      }

      // 逐房调用 fetchPhotosSafe，最多 200 张/房
      const results = await Promise.allSettled(
        roomIds.map(rid => withRequestTimeout(fetchPhotosSafeStrict(rid, 200), '房间照片加载超时'))
      );
      if (requestId !== albumRequestId.current) return;

      const all: Photo[] = [];
      let failedRooms = 0;
      let reachedLimit = false;
      results.forEach(r => {
        if (r.status === 'fulfilled') {
          all.push(...r.value);
          if (r.value.length === 200) reachedLimit = true;
        } else {
          failedRooms += 1;
        }
      });
      setHasMorePhotos(reachedLimit);
      if (failedRooms > 0) {
        setLoadError(`${failedRooms} 个房间的照片暂时无法读取`);
      }

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
        const roomResults = await Promise.all(usedRoomIds.map(roomId => (
          withRequestTimeout(fetchRoomById(roomId), '相册筛选加载超时').catch(() => null)
        )));
        if (requestId !== albumRequestId.current) return;
        setRooms(roomResults.filter((room): room is Room => room !== null));
      } else {
        setRooms([]);
      }
    } catch {
      if (requestId !== albumRequestId.current) return;
      setLoadError('相册加载超时，请检查网络后重试');
      setLoading(false);
    }
  }, [user?.id]);

  useEffect(() => {
    void loadAlbum();
    return () => {
      albumRequestId.current += 1;
    };
  }, [loadAlbum]);

  const filtered = filterRoom === 'all' ? photos : photos.filter(p => p.room_id === filterRoom);

  const handleDeleteRequest = (photo: Photo) => {
    sessionStorage.setItem('delete_photo', JSON.stringify(photo));
    go('photo-delete');
  };

  return (
    <div className="screen padded-screen has-tabbar photographer-album-screen">
      <div className="photographer-page-scroll">
      <div className="photographer-album-heading">
        <span className="photographer-album-heading-icon"><Images aria-hidden="true" /></span>
        <h1>我的相册</h1>
        <p>管理你在各房间上传的照片</p>
      </div>

      {rooms.length > 0 && (
        <div className="room-filter-scroll">
          <button className={filterRoom === 'all' ? 'active' : ''} onClick={() => setFilterRoom('all')} aria-pressed={filterRoom === 'all'}>全部</button>
          {rooms.map(r => (
            <button key={r.id} className={filterRoom === r.id ? 'active' : ''} onClick={() => setFilterRoom(r.id)} aria-pressed={filterRoom === r.id}>
              {r.name}
            </button>
          ))}
        </div>
      )}

      {loadError && photos.length > 0 && <div className="album-load-warning" role="alert">{loadError}</div>}
      {hasMorePhotos && <div className="album-load-note">部分房间照片较多，当前显示最近 200 张。</div>}

      {loading ? (
        <div className="album-loading-state" aria-busy="true" aria-label="正在加载已上传照片">
          <div className="album-skeleton-grid" aria-hidden="true">
            {Array.from({ length: 6 }, (_, index) => <span key={index} />)}
          </div>
          <p>正在整理已上传照片</p>
        </div>
      ) : loadError && photos.length === 0 ? (
        <div className="empty-state photographer-album-empty" role="alert">
          <Images size={40} className="empty-icon" />
          <p className="empty-title">相册暂时无法加载</p>
          <small className="empty-desc">{loadError}</small>
          <button className="empty-action-btn" onClick={() => void loadAlbum()}>重新加载</button>
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty-state photographer-album-empty">
          <Images size={40} className="empty-icon" />
          <p className="empty-title">还没有上传照片</p>
          <small className="empty-desc">使用房间密码加入后，可以在任务页上传照片</small>
          <button className="empty-action-btn" onClick={() => go('photographer-tasks')}>去任务页上传</button>
        </div>
      ) : (
        <div className="photo-album-grid">
          {filtered.map(p => (
            <div key={p.id} className="pa-item">
              <img src={p.url} className="pa-img" alt="照片" />
              <div className="pa-overlay">
                <button
                  className="pa-delete-btn"
                  onClick={() => handleDeleteRequest(p)}
                  title="删除照片"
                  aria-label="删除照片"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      </div>

      <BottomNav active="相册" go={go} variant="photographer" />
    </div>
  );
}

// ─── C08 摄影师直接删除本人照片 ───────────────────────
export function PhotoDeleteRequest({ go }: Props) {
  const { user } = useAuth();
  const [photo, setPhoto] = useState<Photo | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const raw = sessionStorage.getItem('delete_photo');
    if (raw) { try { setPhoto(JSON.parse(raw)); } catch { /* ignore */ } }
  }, []);

  const handleSubmit = async () => {
    if (!photo || !user) return;
    setBusy(true);
    try {
      const { error, warning } = await deleteOwnPhoto(photo, user.id);
      if (error) {
        toast.error(`删除失败：${error}`);
        return;
      }
      if (warning) toast.warning(warning);
      else toast.success('照片已删除');
      sessionStorage.removeItem('delete_photo');
      go('photographer-album');
    } catch (error) {
      toast.error(`删除失败：${error instanceof Error ? error.message : '网络请求异常'}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="screen padded-screen photo-delete-screen photographer-flow-screen">
      <div className="mini-header">
        <button className="back-button" onClick={() => go('photographer-album')} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>删除照片</strong>
        <span />
      </div>

      {photo && (
        <div className="delete-photo-preview">
          <img src={photo.url} className="delete-preview-img" alt="待删除照片" />
        </div>
      )}

      <div className="delete-note">
        <p>删除后，游客将无法继续看到这张照片。此操作不可撤销。</p>
      </div>

      <button
        className="primary-button"
        style={{ background: '#ef4444', color: '#fff' }}
        onClick={handleSubmit}
        disabled={busy || !photo || !user}
      >
        {busy ? '删除中…' : '确认删除'}
      </button>
      <button className="text-button" onClick={() => go('photographer-album')}>取消</button>
    </div>
  );
}
