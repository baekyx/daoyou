import { useCallback, useEffect, useState, useRef } from 'react';
import {
  ChevronRight, UserRound, Landmark, Settings2,
  MessageCircleQuestion, Languages, Volume2,
  Headphones, AlertTriangle, RefreshCw, ChevronDown, Wifi, WifiOff,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { fetchActiveRooms } from '@/api/rooms';
import {
  joinRoomWithPassword, fetchQuestions, sendQuestion, leaveRoom,
  restoreCurrentRoom, resolveRoomEntry,
} from '@/api/roomActivity';
import { fetchKcByPush, fetchLatestPushedKc } from '@/api/cards';
import { attachSubtitleListener, subscribeWithFallback } from '@/lib/voiceApi';
import { fetchSubtitlesSafe } from '@/api/subtitles';
import { useRoomRtc } from '@/hooks/use-room-rtc';
import { isTurnConfigured } from '@/lib/rtcConfig';
import type { KnowledgeCard, Question as QuestionRecord, Room, Subtitle } from '@/types/types';
import { ACTIVE_KC_ID_KEY } from '@/pages/cards/CardScreens';
import { toast } from 'sonner';
import { supabase } from '@/db/supabase';
import { BottomNav } from '@/pages/guide/GuideScreens';

interface Props { go: (id: string) => void }
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

// ─── 房间列表 ─────────────────────────────────────────
export function RoomList({ go }: Props) {
  const [rooms, setRooms] = useState<Room[]>([]);
  const [search, setSearch] = useState('');
  const [enteringId, setEnteringId] = useState<string | null>(null);
  const { setCurrentRoom } = useAuth();

  useEffect(() => {
    fetchActiveRooms().then(setRooms);
  }, []);

  const filtered = search
    ? rooms.filter(r => r.room_number.includes(search) || r.name.includes(search))
    : rooms;

  const selectRoom = async (room: Room) => {
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
        <span><Landmark />发现房间</span>
        <h2>加入讲解</h2>
        <p>选择一个正在讲解的房间开始收听</p>
      </div>

      <div className="search-box">
        <input
          placeholder="输入房间号搜索…"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      <div className="room-card-list">
        {filtered.length === 0 ? (
          <div className="empty-state room-empty-state">
            <span className="empty-icon"><Landmark /></span>
            <h3 className="empty-title">暂时没有可加入的讲解房</h3>
            <p className="empty-desc">可输入导游提供的房间号搜索，或通过邀请链接进入。</p>
          </div>
        ) : filtered.map(room => (
          <button key={room.id} className="room-card" onClick={() => selectRoom(room)} disabled={!!enteringId}>
            {room.cover_url
              ? <img src={room.cover_url} className="room-card-cover" alt={room.name} />
              : <div className="scenic-art compact" />
            }
            <div className="room-card-copy">
              <span className={`status-chip ${room.status === 'live' ? 'live' : ''}`}>
                {room.status === 'live' ? '讲解中' : '待开始'}
              </span>
              <h3>{room.name}</h3>
              <p>房间号 {room.room_number} · {room.online_count} 人</p>
              <p style={{ fontSize: 12, color: 'var(--muted)' }}>
                <UserRound style={{ width: 12, height: 12 }} />
                {(room.guide as any)?.nickname ?? (room.guide as any)?.username ?? '导游'}
              </p>
            </div>
            <b>{enteringId === room.id ? <span className="spinner-sm" /> : <ChevronRight />}</b>
          </button>
        ))}
      </div>

      <BottomNav active="房间" go={go} variant="visitorHome" />
    </div>
  );
}

// ─── 密码锁定持久化 helpers ───────────────────────────
/** localStorage key 格式：sg_lock_{uid}_{roomId}，仅存非敏感截止时间戳 */
function lockKey(uid: string, roomId: string) {
  return `sg_lock_${uid}_${roomId}`;
}
function saveLockUntil(uid: string, roomId: string, until: number) {
  try { localStorage.setItem(lockKey(uid, roomId), String(until)); } catch { /* ignore */ }
}
function readLockUntil(uid: string, roomId: string): number {
  try { return Number(localStorage.getItem(lockKey(uid, roomId)) ?? '0'); } catch { return 0; }
}
function clearLockUntil(uid: string, roomId: string) {
  try { localStorage.removeItem(lockKey(uid, roomId)); } catch { /* ignore */ }
}
/** 根据绝对截止时间计算剩余整秒（向上取整，最小 0） */
function secsRemaining(until: number) {
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

// ─── 密码验证 ─────────────────────────────────────────
export function Password({ go, returnTo = 'room-list' }: Props & { returnTo?: string }) {
  const [digits, setDigits] = useState(['', '', '', '', '', '']);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [lockedSeconds, setLockedSeconds] = useState(0);
  // 'checking' = 挂载时预检授权中（不显示密码框），'show' = 需要输密码，'resuming' = 已授权正在恢复
  const [phase, setPhase] = useState<'checking' | 'show' | 'resuming'>('checking');
  const { currentRoom, user } = useAuth();

  // ── 挂载/room/user 变化时：预检授权 + 恢复剩余锁定倒计时 ──
  useEffect(() => {
    if (!currentRoom || !user) { setPhase('show'); return; }
    setPhase('checking');
    resolveRoomEntry(currentRoom.id).then(({ target }) => {
      if (target === 'listening') {
        setPhase('resuming');
        sessionStorage.removeItem('shiguang-pending-invite');
        clearLockUntil(user.id, currentRoom.id);
        go('listening');
      } else if (target === 'subtitle-history') {
        go('subtitle-history');
      } else if (target === 'room-list') {
        go(returnTo);
      } else {
        setPhase('show');
        // 恢复 localStorage 中的锁定截止时间
        const until = readLockUntil(user.id, currentRoom.id);
        const remaining = secsRemaining(until);
        if (remaining > 0) {
          setLockedSeconds(remaining);
        } else {
          clearLockUntil(user.id, currentRoom.id);
          setLockedSeconds(0);
          window.setTimeout(() => (document.getElementById('d0') as HTMLInputElement)?.focus(), 50);
        }
      }
    }).catch(() => setPhase('show'));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentRoom?.id, user?.id]);

  // ── 绝对时间倒计时，切后台 / 定时器漂移不影响准确度 ──
  useEffect(() => {
    if (lockedSeconds <= 0) return;
    const interval = window.setInterval(() => {
      if (!user || !currentRoom) { setLockedSeconds(0); return; }
      const until = readLockUntil(user.id, currentRoom.id);
      const remaining = secsRemaining(until);
      if (remaining <= 0) {
        clearLockUntil(user.id, currentRoom.id);
        setLockedSeconds(0);
        setError('');
      } else {
        setLockedSeconds(remaining);
      }
    }, 1000);
    return () => window.clearInterval(interval);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lockedSeconds > 0, user?.id, currentRoom?.id]);

  const handleDigit = (i: number, val: string) => {
    if (!/^\d?$/.test(val)) return;
    const next = [...digits];
    next[i] = val;
    setDigits(next);
    setError('');
    if (val && i < 5) {
      (document.getElementById(`d${i + 1}`) as HTMLInputElement)?.focus();
    }
    if (next.every(Boolean)) {
      window.setTimeout(() => handleEnter(next.join('')), 0);
    }
  };

  const handleEnter = async (code?: string) => {
    if (lockedSeconds > 0 || phase !== 'show' || busy) return;
    const pwd = code ?? digits.join('');
    if (pwd.length < 6) { toast.error('请输入六位密码'); return; }
    if (!currentRoom) { toast.error('未选择房间'); return; }
    if (!user) { go('login'); return; }
    setBusy(true);
    const result = await joinRoomWithPassword(currentRoom.id, pwd);
    setBusy(false);
    if (result.ok) {
      // 成功：清理锁定 key
      clearLockUntil(user.id, currentRoom.id);
      sessionStorage.removeItem('shiguang-pending-invite');
      go('listening');
      return;
    }
    setDigits(['', '', '', '', '', '']);
    window.setTimeout(() => (document.getElementById('d0') as HTMLInputElement)?.focus(), 0);
    switch (result.code) {
      case 'rate_limited': {
        // 用服务端结果校准截止时间（15s 为标准锁定时长）
        const secs = result.retryAfterSeconds ?? 15;
        const until = Date.now() + secs * 1000;
        saveLockUntil(user.id, currentRoom.id, until);
        setLockedSeconds(secs);
        setError('');  // 锁定时不显示独立红字，仅在按钮展示倒计时
        break;
      }
      case 'wrong_password': {
        const left = result.attemptsRemaining ?? 0;
        if (left <= 0) {
          // 第 5 次错误：服务端会同时触发 rate_limited，但 wrong_password 时 left=0 也本地锁 15s
          const until = Date.now() + 15 * 1000;
          saveLockUntil(user.id, currentRoom.id, until);
          setLockedSeconds(15);
          setError('');
        } else {
          // 普通错误：只显示简洁文案，无倒计时
          setError('房间密码错误，请重试');
        }
        break;
      }
      case 'room_not_active':
        setError('房间已结束，无法加入');
        break;
      case 'room_not_found':
        setError('房间不存在，请返回重新选择');
        break;
      default:
        setError('加入失败，请重试');
    }
  };

  // 预检阶段：全屏加载态，不短暂显示密码框
  if (phase === 'checking' || phase === 'resuming') {
    return (
      <div className="screen padded-screen" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <div className="spinner" />
        <p style={{ color: 'var(--muted)', fontSize: 14 }}>
          {phase === 'resuming' ? '正在恢复房间…' : '正在验证房间权限…'}
        </p>
      </div>
    );
  }

  const isLocked = lockedSeconds > 0;
  const btnDisabled = busy || digits.some(d => !d) || isLocked;
  const btnLabel = busy ? '验证中…' : isLocked ? `${lockedSeconds}s 后重试` : '进入房间';

  return (
    <div className="screen padded-screen">
      <div className="mini-header">
        <button className="back-button" onClick={() => go(returnTo)} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>加入房间</strong>
        <span />
      </div>

      <div className="password-room-info">
        <h3>{currentRoom?.name ?? '讲解房'}</h3>
        <p>房间号 {currentRoom?.room_number}</p>
      </div>

      <p className="password-hint">请输入六位数字密码</p>
      <div className={`password-boxes ${error ? 'has-error' : ''}`}>
        {digits.map((d, i) => (
          <input
            key={i}
            id={`d${i}`}
            className="digit-box"
            maxLength={1}
            value={d}
            onChange={e => handleDigit(i, e.target.value)}
            type="text"
            inputMode="numeric"
            disabled={busy || isLocked}
          />
        ))}
      </div>

      {error && <p className="password-error" role="alert">{error}</p>}

      <button className="primary-button green" onClick={() => handleEnter()} disabled={btnDisabled}>
        {btnLabel}
      </button>
    </div>
  );
}

// ─── currentRoom 恢复 hook ─────────────────────────────
function useRoomRestore() {
  const { user, currentRoom, setCurrentRoom } = useAuth();
  const [restoring, setRestoring] = useState(false);
  const [restoreFailed, setRestoreFailed] = useState(false);

  useEffect(() => {
    if (currentRoom || !user) return;
    setRestoring(true);
    restoreCurrentRoom().then(room => {
      if (room) {
        setCurrentRoom(room);
      } else {
        setRestoreFailed(true);
      }
      setRestoring(false);
    }).catch(() => {
      setRestoreFailed(true);
      setRestoring(false);
    });
  }, [user?.id]);

  return { restoring, restoreFailed };
}

// ─── 实时收听 ─────────────────────────────────────────
export function Listening({ go }: Props) {
  const { user, currentRoom, subtitlePrefs, setSubtitlePrefs, setCurrentRoom } = useAuth();
  const { restoring, restoreFailed } = useRoomRestore();
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [questions, setQuestions] = useState<QuestionRecord[]>([]);
  // Task2：activeCard 直接存 KC 内容，不再存 RoomCard 中间层
  const [activeCard, setActiveCard] = useState<KnowledgeCard | null>(null);
  // push_id 去重 ref：防止 Realtime 断线重连重放同一条 INSERT / UPDATE 触发多次弹窗
  // roomId 变化时在 effect cleanup 重置（见下方 useEffect）
  const seenPushIdsRef = useRef<Set<string>>(new Set());
  // subscribedRef：channel SUBSCRIBED 后才允许 INSERT 触发弹窗，防止订阅建立前的历史推播
  const cardChannelSubscribedRef = useRef(false);
  const [roomEnded, setRoomEnded] = useState(false);
  const [englishVoiceState, setEnglishVoiceState] = useState<'off' | 'ready' | 'playing' | 'blocked'>('off');
  // Realtime 同步状态（轮询降级时显示"字幕连接恢复中"）
  const [realtimeSyncStatus, setRealtimeSyncStatus] = useState<'ok' | 'degraded'>('ok');
  // subtitleEndRef / subtitleScrollRef / autoScroll 在下方 WebRTC 消费块统一声明
  const englishAudioRef = useRef<HTMLAudioElement | null>(null);
  const englishQueueRef = useRef<string[]>([]);
  const englishPlayingRef = useRef(false);
  const englishEnabledRef = useRef(subtitlePrefs.showEn);
  const playedEnglishIdsRef = useRef<Set<string>>(new Set());

  // ── 中文原声分片：B1-T 期间暂停自动播放（保留队列代码备后续恢复）──
  // chineseEnabledRef 强制 false，不删数据/上传逻辑
  const [chineseVoiceState, setChineseVoiceState] = useState<'off' | 'ready' | 'playing' | 'blocked'>('off');
  const chineseAudioRef = useRef<HTMLAudioElement | null>(null);
  const chineseQueueRef = useRef<string[]>([]);
  const chinesePlayingRef = useRef(false);
  const chineseEnabledRef = useRef(false); // B1-T: 中文分片自动播放已暂停，避免与 WebRTC 实时原声叠音
  const playedChineseIdsRef = useRef<Set<string>>(new Set());

  const playNextChinese = useCallback(() => {
    if (!chineseEnabledRef.current || chinesePlayingRef.current) return;
    const nextUrl = chineseQueueRef.current.shift();
    if (!nextUrl) { setChineseVoiceState('ready'); return; }
    const audio = chineseAudioRef.current ?? new Audio();
    chineseAudioRef.current = audio;
    audio.preload = 'auto';
    audio.src = nextUrl;
    audio.onended = () => { chinesePlayingRef.current = false; playNextChinese(); };
    audio.onerror = () => { chinesePlayingRef.current = false; playNextChinese(); };
    chinesePlayingRef.current = true;
    audio.play().then(() => setChineseVoiceState('playing')).catch(() => {
      chinesePlayingRef.current = false;
      setChineseVoiceState('blocked');
    });
  }, []);

  const enqueueChineseAudio = useCallback((_subtitle: Subtitle) => {
    // B1-T: 中文分片自动播放已暂停，保留函数签名以便后续恢复
    // if (!chineseEnabledRef.current || ...) return;
  }, []);

  const playNextEnglish = useCallback(() => {
    if (!englishEnabledRef.current || englishPlayingRef.current) return;
    const nextUrl = englishQueueRef.current.shift();
    if (!nextUrl) { setEnglishVoiceState('ready'); return; }
    const audio = englishAudioRef.current ?? new Audio();
    englishAudioRef.current = audio;
    audio.preload = 'auto';
    audio.src = nextUrl;
    audio.onended = () => {
      englishPlayingRef.current = false;
      playNextEnglish();
    };
    audio.onerror = () => {
      englishPlayingRef.current = false;
      playNextEnglish();
    };
    englishPlayingRef.current = true;
    audio.play().then(() => setEnglishVoiceState('playing')).catch(() => {
      englishPlayingRef.current = false;
      setEnglishVoiceState('blocked');
    });
  }, []);

  const enqueueEnglishAudio = useCallback((subtitle: Subtitle) => {
    if (!englishEnabledRef.current || !subtitle.audio_url || playedEnglishIdsRef.current.has(subtitle.id)) return;
    playedEnglishIdsRef.current.add(subtitle.id);
    englishQueueRef.current.push(subtitle.audio_url);
    playNextEnglish();
  }, [playNextEnglish]);

  // WebRTC：从房间级 RoomRtcProvider 消费（信令/连接已在 Provider 初始化）
  const {
    connState, candidateKind, turnConfigured, relayForced,
    guideMicOn, audioPlayState, playAudio, retryConnect,
    trackPresence, untrackPresence,
  } = useRoomRtc();

  // 游客进入收听页后立即 track Presence（同一 Provider 实例只 track 一次）
  useEffect(() => {
    trackPresence();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // autoScroll 状态
  const [autoScroll, setAutoScroll] = useState(true);
  const subtitleEndRef = useRef<HTMLDivElement>(null);
  const subtitleScrollRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);

  // 加载字幕、问题 & 实时订阅
  useEffect(() => {
    if (!currentRoom) return;

    // 切换/重新挂载时清除旧房间的弹窗状态和去重集合，防止旧事件串入新房间
    setActiveCard(null);
    seenPushIdsRef.current = new Set();
    cardChannelSubscribedRef.current = false;

    fetchSubtitlesSafe(currentRoom.id, 50).then(setSubtitles);
    fetchQuestions(currentRoom.id).then(setQuestions);

    // ── 历史补查：仅将最近一张已推送卡片写入 sessionStorage，供用户手动进入卡片详情页使用；
    //    不调用 setActiveCard，绝不触发弹窗，避免刷新/重新打开时重复弹出"导游刚刚推送"。
    fetchLatestPushedKc(currentRoom.id).then(result => {
      if (result) {
        // 仅更新 sessionStorage 缓存，不弹窗
        sessionStorage.setItem(ACTIVE_KC_ID_KEY, result.kcCardId);
        console.log(
          `[CardPush] 历史补查完成 | roomId=${currentRoom.id} kcCardId=${result.kcCardId} (仅缓存，不弹窗)`
        );
      }
    });

    const ch = supabase.channel(`listening-cards-${currentRoom.id}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'card_pushes', filter: `room_id=eq.${currentRoom.id}` },
        payload => {
          // 门控1：channel 必须已 SUBSCRIBED，否则丢弃（属于订阅建立前的历史回放）
          if (!cardChannelSubscribedRef.current) {
            console.log(`[CardPush] 订阅未就绪，丢弃历史推播 | roomId=${currentRoom.id}`);
            return;
          }
          const p = payload.new as { id?: string; kc_card_id?: string; room_card_id?: string; card_id?: string; room_id?: string };

          // 门控2：room_id 精确匹配（防止 filter 失效时的串房间）
          if (p.room_id && p.room_id !== currentRoom.id) {
            console.warn(`[CardPush] room_id 不匹配，丢弃 | expected=${currentRoom.id} got=${p.room_id}`);
            return;
          }

          // Task2 新流程：必须有 kc_card_id
          if (!p.kc_card_id) return;

          const pushId = p.id ?? `${p.kc_card_id}-${p.room_id}`;

          // 门控3：push_id 去重，防止断线重连重放同一条 INSERT
          if (seenPushIdsRef.current.has(pushId)) {
            console.log(`[CardPush] 已处理，跳过重放 | pushId=${pushId} kcCardId=${p.kc_card_id}`);
            return;
          }
          seenPushIdsRef.current.add(pushId);

          console.log(`[CardPush] 新推送 | pushId=${pushId} kcCardId=${p.kc_card_id} roomId=${currentRoom.id}`);

          fetchKcByPush(currentRoom.id, p.kc_card_id).then(kc => {
            if (!kc) {
              console.warn(`[CardPush] fetchKcByPush 返回空 | pushId=${pushId} kcCardId=${p.kc_card_id}`);
              return;
            }
            sessionStorage.setItem(ACTIVE_KC_ID_KEY, kc.id);
            setActiveCard(kc);
            console.log(`[CardPush] 弹窗触发 | pushId=${pushId} kcCardId=${kc.id} title=${kc.title_cn}`);
          });
        })
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'questions', filter: `room_id=eq.${currentRoom.id}` },
        payload => setQuestions(prev => [payload.new as QuestionRecord, ...prev]))
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `id=eq.${currentRoom.id}` },
        payload => {
          const updated = payload.new as Partial<Room>;
          if (updated.status) {
            setCurrentRoom({ ...currentRoom, status: updated.status });
          }
          if (updated.status === 'ended') {
            setRoomEnded(true);
          }
        });

    // 将字幕监听合并到同一 channel，避免单独 subtitles channel 再占一条数据库连接
    // 使用 subscribeWithFallback：连接异常时自动降级为 3s 增量轮询，恢复后停止轮询
    const subtitleHandler = (s: Subtitle) => {
      setSubtitles(prev => {
        const merged = [...prev.filter(item => item.id !== s.id), s];
        merged.sort((a, b) => {
          if (a.sequence != null && b.sequence != null) return a.sequence - b.sequence;
          return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
        });
        return merged;
      });
      enqueueEnglishAudio(s);
      enqueueChineseAudio(s); // B1-T: enqueueChineseAudio 为空操作，中文分片暂停
    };
    const subtitleCleanup = attachSubtitleListener(ch, currentRoom.id, subtitleHandler);

    const fbCleanup = subscribeWithFallback(
      ch,
      `listening-cards-${currentRoom.id}`,
      currentRoom.id,
      setRealtimeSyncStatus,
      s => {
        // 轮询新字幕 / 内容更新（fingerprint 去重已在 subscribeWithFallback 内处理）
        subtitleHandler(s);
      },
      // SUBSCRIBED 回调：channel 就绪后才允许 card_pushes INSERT 触发弹窗
      () => {
        cardChannelSubscribedRef.current = true;
        console.log(`[CardPush] channel SUBSCRIBED | roomId=${currentRoom.id}`);
      }
    );

    return () => {
      subtitleCleanup.unsubscribe();
      fbCleanup.unsubscribe();
      supabase.removeChannel(ch);
      // 清理：防止旧 room 的状态泄漏到下一个 room
      cardChannelSubscribedRef.current = false;
    };
  }, [currentRoom?.id, enqueueEnglishAudio, enqueueChineseAudio]);

  useEffect(() => {
    englishEnabledRef.current = subtitlePrefs.showEn;
    if (!subtitlePrefs.showEn) {
      englishQueueRef.current = [];
      englishPlayingRef.current = false;
      if (englishAudioRef.current) {
        englishAudioRef.current.pause();
        englishAudioRef.current.currentTime = 0;
      }
      setEnglishVoiceState('off');
      return;
    }
    setEnglishVoiceState(prev => prev === 'playing' ? prev : 'ready');
    playNextEnglish();
  }, [subtitlePrefs.showEn, playNextEnglish]);

  // 中文模式开关：B1-T 中文分片已暂停，仅清理队列
  useEffect(() => {
    // B1-T: chineseEnabledRef.current 固定为 false，不触发分片播放
    chineseQueueRef.current = [];
    chinesePlayingRef.current = false;
    if (chineseAudioRef.current) {
      chineseAudioRef.current.pause();
      chineseAudioRef.current.currentTime = 0;
    }
    setChineseVoiceState('off');
  }, [subtitlePrefs.mode]);

  useEffect(() => () => {
    englishQueueRef.current = [];
    englishPlayingRef.current = false;
    englishAudioRef.current?.pause();
    chineseQueueRef.current = [];
    chinesePlayingRef.current = false;
    chineseAudioRef.current?.pause();
  }, []);

  // 字幕区滚动检测：用户上滑 >60px 时暂停自动跟随
  const handleSubtitleScroll = useCallback(() => {
    const el = subtitleScrollRef.current;
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

  // 新字幕到达，仅 autoScroll 开启时滚底
  useEffect(() => {
    if (autoScroll) subtitleEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [subtitles, autoScroll]);

  // RTC 状态文案
  const rtcLabel: Record<string, string> = {
    idle: '等待开启收听',
    connecting: '正在连接…',
    connected: candidateKind === 'relay'
      ? 'relay 已连接（TURN 中继）'
      : `实时收听中（${candidateKind}）`,
    disconnected: '连接中断',
    failed: '连接失败',
  };
  const rtcStatus = connState as string;

  const fontSizeMap = { small: 16, medium: 18, large: 22 };
  const fs = fontSizeMap[subtitlePrefs.fontSize];

  if (restoring) {
    return (
      <div className="screen padded-screen" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <p style={{ color: 'var(--muted)', fontSize: 14 }}>正在恢复讲解房间…</p>
      </div>
    );
  }

  if (restoreFailed || !currentRoom) {
    return (
      <div className="screen padded-screen" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <p style={{ color: 'var(--muted)', fontSize: 14 }}>未找到当前讲解房，请重新加入</p>
        <button className="primary-button green" onClick={() => go('room-list')}>返回房间列表</button>
      </div>
    );
  }

  const showCn = subtitlePrefs.mode !== 'en';
  const showEn = subtitlePrefs.mode !== 'cn';

  const updateLanguageMode = (mode: 'cn' | 'en' | 'bilingual') => {
    setSubtitlePrefs({
      ...subtitlePrefs,
      mode,
      showCn: mode !== 'en',
      showEn: mode !== 'cn',
    });
    // 切到含英文模式：尝试解锁英文音频
    if (mode !== 'cn' && englishVoiceState === 'blocked' && englishAudioRef.current) {
      englishPlayingRef.current = true;
      englishAudioRef.current.play()
        .then(() => setEnglishVoiceState('playing'))
        .catch(() => { englishPlayingRef.current = false; setEnglishVoiceState('blocked'); });
    }
    // 切到纯中文模式：尝试解锁中文原声
    if (mode === 'cn' && chineseVoiceState === 'blocked' && chineseAudioRef.current) {
      chinesePlayingRef.current = true;
      chineseAudioRef.current.play()
        .then(() => setChineseVoiceState('playing'))
        .catch(() => { chinesePlayingRef.current = false; setChineseVoiceState('blocked'); });
    }
  };

  const cardTitle = subtitlePrefs.mode === 'en'
    ? (activeCard?.title_en || activeCard?.title_cn)
    : activeCard?.title_cn;
  const cardDescription = subtitlePrefs.mode === 'en'
    ? (activeCard?.desc_en || activeCard?.desc_cn)
    : activeCard?.desc_cn;

  // 游客主动退出：先 untrack Presence，再更新 left_at，再清理 RTC 状态，再导航
  const handleLeaveRoom = useCallback(async () => {
    if (!currentRoom || !user) { go('room-list'); return; }
    await untrackPresence();
    await leaveRoom(currentRoom.id, user.id);
    setCurrentRoom(null);
    go('room-list');
  }, [currentRoom, user, untrackPresence, setCurrentRoom, go]);

  return (
    <div className="screen listening-screen">
      <div className="mini-header" style={{ padding: '0 18px' }}>
        <button className="back-button" onClick={handleLeaveRoom} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>{currentRoom?.name ?? '收听中'}</strong>
        <span />
      </div>

      {/* 顶部固定区：语言切换 + 导游状态栏 */}
      <div className="listening-top">
        <div className="language-tools">
          {(['cn', 'en', 'bilingual'] as const).map(m => (
            <button key={m} className={subtitlePrefs.mode === m ? 'active' : ''} onClick={() => updateLanguageMode(m)}>
              {m === 'cn' ? '中' : m === 'en' ? 'EN' : '双语'}
            </button>
          ))}
          <button onClick={() => go('subtitle-settings')}><Settings2 />字幕设置</button>
        </div>
        {subtitlePrefs.showEn && (
          <div className={`english-voice-status ${englishVoiceState}`}>
            <Volume2 />
            <span>{englishVoiceState === 'playing' ? '英文语音播放中' : englishVoiceState === 'blocked' ? '点击 EN 或双语以开启英文语音' : '英文语音已开启，译文生成后自动播放'}</span>
          </div>
        )}
        {subtitlePrefs.mode === 'cn' && chineseVoiceState !== 'off' && (
          <div className={`english-voice-status ${chineseVoiceState}`}>
            <Volume2 />
            <span>{chineseVoiceState === 'playing' ? '中文原声播放中' : chineseVoiceState === 'blocked' ? '点击「中」以开启中文原声' : '中文原声已开启，讲解生成后自动播放'}</span>
          </div>
        )}

        {/* WebRTC 状态条 */}
        <div className={`rtc-status-bar rtc-status-${rtcStatus}`}>
          {rtcStatus === 'connected' ? <Wifi size={13} /> : rtcStatus === 'failed' || rtcStatus === 'disconnected' ? <WifiOff size={13} /> : <Headphones size={13} />}
          <span>{rtcLabel[rtcStatus] ?? rtcStatus}</span>
          {!turnConfigured && (
            <span className="rtc-noturn-tag">TURN 未配置·仅直连</span>
          )}
          {relayForced && (
            <span className="rtc-relay-tag">relay 模式</span>
          )}
          {(rtcStatus === 'disconnected' || rtcStatus === 'failed') && (
            <button className="rtc-retry-btn" onClick={retryConnect} aria-label="重新连接">
              <RefreshCw size={12} />重连
            </button>
          )}
        </div>

        {/* 开启收听 / 恢复收听 按钮（必须真实手势触发 play()，同时解锁英文 Audio） */}
        {(audioPlayState === 'idle' || audioPlayState === 'blocked') && connState === 'connected' && (
          <button className="rtc-play-btn" onClick={() => {
            // 1. 解锁 WebRTC 中文原声
            playAudio();
            // 2. 在同一用户手势内解锁英文 Audio（若已有待播 URL 则立即播放，否则预热 Audio 上下文）
            if (englishEnabledRef.current) {
              if (!englishAudioRef.current) englishAudioRef.current = new Audio();
              const audio = englishAudioRef.current;
              if (englishQueueRef.current.length > 0 && !englishPlayingRef.current) {
                // 队列里已有待播 URL，直接推进播放器
                const nextUrl = englishQueueRef.current.shift()!;
                audio.src = nextUrl;
                audio.preload = 'auto';
                audio.onended = () => { englishPlayingRef.current = false; playNextEnglish(); };
                audio.onerror = () => { englishPlayingRef.current = false; playNextEnglish(); };
                englishPlayingRef.current = true;
                audio.play()
                  .then(() => setEnglishVoiceState('playing'))
                  .catch(() => { englishPlayingRef.current = false; setEnglishVoiceState('blocked'); });
              } else {
                // 队列为空：静默播放一段空白来预热 Audio 上下文，之后 enqueueEnglishAudio 可直接 play()
                audio.src = 'data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=';
                audio.play().then(() => {
                  audio.pause();
                  setEnglishVoiceState('ready');
                }).catch(() => setEnglishVoiceState('blocked'));
              }
            }
          }}>
            <Headphones size={18} />
            {audioPlayState === 'blocked' ? '点击恢复收听' : '开启收听'}
          </button>
        )}

        {/* 导游信息 & 麦克风状态 */}
        <div className="listener-host-bar">
          {(currentRoom?.guide as any)?.avatar_url
            ? <img src={(currentRoom.guide as any).avatar_url} className="avatar" style={{ width: 42, height: 42, objectFit: 'cover', borderRadius: '50%' }} alt="导游头像" />
            : <div className="avatar" style={{ width: 42, height: 42 }} />
          }
          <div>
            <strong>{(currentRoom?.guide as any)?.nickname ?? '导游'}</strong>
            <span style={{ color: guideMicOn ? 'var(--green)' : 'var(--muted)' }}>
              {guideMicOn ? '正在讲解' : '导游已暂停'}
            </span>
          </div>
          <Wave active={guideMicOn} />
        </div>
      </div>

      {/* 可滚动字幕区 */}
      <div
        className="subtitle-scroll"
        ref={subtitleScrollRef}
        onScroll={handleSubtitleScroll}
      >
        {/* 字幕同步状态提示（简洁，不暴露技术词汇） */}
        <p style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'center', padding: '4px 0 0' }}>
          {realtimeSyncStatus === 'ok' ? '字幕实时同步中' : '字幕连接恢复中'}
        </p>
        {subtitles.length === 0 ? (
          <p style={{ color: 'var(--muted)', textAlign: 'center', padding: '24px 0' }}>等待导游开始讲解…</p>
        ) : subtitles.map(s => (
          <div key={s.id} className="subtitle-card" style={{ fontSize: fs }}>
            {showCn && <p className="zh">{s.content_cn}</p>}
            {showEn && s.content_en && (
              <p className="en" style={{ color: 'var(--muted)', fontSize: fs - 1 }}>{s.content_en}</p>
            )}
          </div>
        ))}
        <div ref={subtitleEndRef} />
      </div>

      {/* 回到最新 按钮（用户上滑暂停后显示） */}
      {!autoScroll && (
        <button
          className="back-to-latest-btn"
          onClick={() => {
            setAutoScroll(true);
            userScrolledRef.current = false;
            subtitleEndRef.current?.scrollIntoView({ behavior: 'smooth' });
          }}
        >
          <ChevronDown size={14} />回到最新
        </button>
      )}

      {/* 底部固定区：提问按钮 + 底栏 */}
      <div className="listening-bottom">
        {/* 提问按钮 */}
        <button className="ask-fab" onClick={() => go('question')}>
          <MessageCircleQuestion /><span>提问</span>
        </button>
        <BottomNav active="语音" go={go} variant="room" />
      </div>

      {/* 卡片推送弹窗 */}
      {activeCard && (
        <div className="card-alert-overlay" onClick={() => setActiveCard(null)}>
          <div className="knowledge-modal" onClick={e => e.stopPropagation()}>
            <span className="push-badge">导游刚刚推送</span>
            <h2>{cardTitle}</h2>
            {activeCard.deleted_at ? (
              <p style={{ color: 'var(--muted)', textAlign: 'center', padding: '16px 0' }}>卡片已下架</p>
            ) : (
              <>
                {activeCard.image_url
                  ? <img className="knowledge-card-image" src={activeCard.image_url} alt={cardTitle ?? '景区图片'} />
                  : <div className="scenic-art" />
                }
                <p className="knowledge-card-description">{cardDescription}</p>
                <button className="primary-button green" onClick={() => {
                  setActiveCard(null);
                  // Task2：存 kc_card_id（仅 ID），详情页通过 RPC 加载最新内容
                  sessionStorage.setItem(ACTIVE_KC_ID_KEY, activeCard.id);
                  go('room-card-detail');
                }}>
                  查看卡片
                </button>
              </>
            )}
            <button className="text-button" onClick={() => setActiveCard(null)}>稍后查看</button>
            <div className="audio-continues">讲解音频将继续播放</div>
          </div>
        </div>
      )}

      {/* 房间已结束弹窗 */}
      {roomEnded && (
        <div className="room-ended-overlay">
          <div className="room-ended-card">
            <div style={{ fontSize: 36 }}>🏁</div>
            <h3>讲解已结束</h3>
            <p style={{ fontSize: 13, color: 'var(--muted)', lineHeight: 1.6, margin: '4px 0 20px' }}>
              导游已解散房间，感谢您的参与！
            </p>
            <button
              className="primary-button green"
              style={{ width: '100%' }}
              onClick={handleLeaveRoom}
            >
              返回房间列表
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── 游客提问 ──────────────────────────────────────────
// 修复 DatabaseLackOfConnections：
// 删除原有独立 question-page Realtime channel（questions INSERT + rooms UPDATE 双订阅），
// 改为挂载时一次性 REST 拉取 + 定时轮询刷新。
// rooms 状态变更由 Listening 的 listening-cards channel 写入 context，Question 读同一 context 即可。
export function Question({ go }: Props) {
  const { user, currentRoom, subtitlePrefs, setSubtitlePrefs } = useAuth();
  const { restoring, restoreFailed } = useRoomRestore();
  const [content, setContent] = useState('');
  const [busy, setBusy] = useState(false);
  const [questions, setQuestions] = useState<QuestionRecord[]>([]);

  // 初次拉取 + 每 10s 轮询一次（无 Realtime channel，不占数据库连接配额）
  useEffect(() => {
    if (!currentRoom) return;
    let cancelled = false;
    const load = () => fetchQuestions(currentRoom.id).then(data => {
      if (!cancelled) setQuestions(data);
    });
    load();
    const timer = window.setInterval(load, 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [currentRoom?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const isEnded = currentRoom?.status === 'ended';

  // 提问发送
  const handleSend = async () => {
    if (!content.trim()) { toast.error('请输入问题内容'); return; }
    if (!user) { toast.error('请先登录'); return; }
    if (!currentRoom) { toast.error('未找到当前讲解房，请重新加入'); return; }
    if (isEnded) { toast.error('讲解已结束，无法提问'); return; }
    setBusy(true);
    const { error } = await sendQuestion(currentRoom.id, user.id, content.trim());
    setBusy(false);
    if (error) { toast.error('发送失败，请重试：' + error); return; }
    toast.success('问题已发送给导游');
    setContent('');
  };

  const updateMode = (mode: 'cn' | 'en' | 'bilingual') => {
    setSubtitlePrefs({ ...subtitlePrefs, mode, showCn: mode !== 'en', showEn: mode !== 'cn' });
  };

  if (restoring) {
    return (
      <div className="screen padded-screen" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <p style={{ color: 'var(--muted)', fontSize: 14 }}>正在恢复讲解房间…</p>
      </div>
    );
  }

  if (restoreFailed || !currentRoom) {
    return (
      <div className="screen padded-screen" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <p style={{ color: 'var(--muted)', fontSize: 14 }}>未找到当前讲解房，请重新加入</p>
        <button className="primary-button green" onClick={() => go('room-list')}>返回房间列表</button>
      </div>
    );
  }

  return (
    <div className="screen padded-screen">
      <div className="mini-header">
        <button className="back-button" onClick={() => go('listening')} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>{currentRoom.name}</strong>
        <span />
      </div>

      {/* 语言模式选择（影响问题翻译显示策略） */}
      <div className="language-tools" style={{ marginBottom: 12 }}>
        <div className="segment">
          {(['cn', 'en', 'bilingual'] as const).map(m => (
            <button
              key={m}
              className={subtitlePrefs.mode === m ? 'active' : ''}
              onClick={() => updateMode(m)}
            >
              {m === 'cn' ? '中' : m === 'en' ? 'EN' : '双语'}
            </button>
          ))}
        </div>
      </div>

      <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 8 }}>
        {isEnded ? '讲解已结束，问题记录只读' : '导游正在讲解，请输入您的问题'}
      </p>

      {/* 问题历史列表 */}
      {questions.length > 0 && (
        <div className="interaction-history">
          {questions.slice(0, 10).map(q => (
            <article key={q.id} className="interaction-item">
              <div className="interaction-meta">
                <strong>{q.profile?.nickname ?? '游客'}</strong>
              </div>
              <p>{q.content}</p>
              {q.translated_text && (
                <p className="interaction-translation"><Languages size={11} />{q.translated_text}</p>
              )}
            </article>
          ))}
        </div>
      )}

      {/* 输入框 */}
      <div className="composer">
        <textarea
          value={content}
          onChange={e => setContent(e.target.value.slice(0, 80))}
          placeholder={isEnded ? '讲解已结束' : '请输入您的问题…'}
          rows={3}
          disabled={isEnded}
        />
        <div>
          <span>{content.length}/80 字</span>
          <button
            onClick={handleSend}
            disabled={busy || !content.trim() || isEnded || !user || !currentRoom}
          >
            {busy ? '发送中…' : isEnded ? '已结束' : '发送问题'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── 字幕设置 ─────────────────────────────────────────
export function SubtitleSettings({ go, returnTo = 'listening' }: Props & { returnTo?: string }) {
  const { subtitlePrefs, setSubtitlePrefs } = useAuth();
  const [local, setLocal] = useState({ ...subtitlePrefs });

  const save = () => {
    setSubtitlePrefs(local);
    toast.success('设置已保存');
    go(returnTo);
  };

  const toggleLanguage = (key: 'showCn' | 'showEn') => {
    setLocal(prev => {
      const next = { ...prev, [key]: !prev[key] };
      if (!next.showCn && !next.showEn) return prev;
      next.mode = next.showCn && next.showEn ? 'bilingual' : next.showCn ? 'cn' : 'en';
      return next;
    });
  };

  const setMode = (mode: 'cn' | 'en' | 'bilingual') => {
    setLocal(prev => ({ ...prev, mode, showCn: mode !== 'en', showEn: mode !== 'cn' }));
  };

  return (
    <div className="screen padded-screen">
      <div className="mini-header">
        <button className="back-button" onClick={() => go(returnTo)} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>字幕与翻译</strong>
        <span />
      </div>

      <p className="voice-setting-note"><Volume2 />中文原声始终实时播放；开启英文后，英文翻译语音将自动播放。</p>

      <div className="settings-card exact-settings">
        {/* 中文字幕 */}
        <div className="setting-toggle-row">
          <span className="setting-icon">中</span>
          <strong>显示中文字幕</strong>
          <button
            className={`toggle-btn ${local.showCn ? 'on' : ''}`}
            onClick={() => toggleLanguage('showCn')}
          >{local.showCn ? '开' : '关'}</button>
        </div>
        {/* 英文翻译 */}
        <div className="setting-toggle-row">
          <span className="setting-icon">EN</span>
          <strong>英文字幕与语音</strong>
          <button
            className={`toggle-btn ${local.showEn ? 'on' : ''}`}
            onClick={() => toggleLanguage('showEn')}
          >{local.showEn ? '开' : '关'}</button>
        </div>
        {/* 显示模式 */}
        <div className="display-mode-row">
          <strong>默认显示模式</strong>
          <div className="segment">
            {(['cn', 'en', 'bilingual'] as const).map(m => (
              <button
                key={m}
                className={local.mode === m ? 'active' : ''}
                onClick={() => setMode(m)}
              >{m === 'cn' ? '中' : m === 'en' ? 'EN' : '双语'}</button>
            ))}
          </div>
        </div>
        {/* 字号 */}
        <div className="display-mode-row">
          <strong>字幕字号</strong>
          <div className="segment">
            {(['small', 'medium', 'large'] as const).map(s => (
              <button
                key={s}
                className={local.fontSize === s ? 'active' : ''}
                onClick={() => setLocal(p => ({ ...p, fontSize: s }))}
              >{s === 'small' ? '小' : s === 'medium' ? '中' : '大'}</button>
            ))}
          </div>
        </div>
      </div>

      <button className="primary-button green" onClick={save}>保存我的设置</button>
    </div>
  );
}
