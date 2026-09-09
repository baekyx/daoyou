import { useEffect, useRef, useState } from 'react';
import {
  Landmark, Clock3, Users, ChevronRight, Radio, CalendarDays, Headphones,
  PlayCircle, FileText, Sparkles, BookOpen, RefreshCw,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { fetchGuideRoomsStrict } from '@/api/rooms';
import { fetchMyJoinedRoomsStrict } from '@/api/roomActivity';
import { fetchAllSubtitlesStrict } from '@/api/subtitles';
import {
  fetchMeetingMinutesCloud, fetchMeetingMinutesRoomIds, saveMeetingMinutesCloud,
} from '@/api/meetingMinutes';
import {
  generateMeetingMinutes, hasMeetingMinutes, readMeetingMinutes,
  saveMeetingMinutes, subscribeMeetingMinutes, type MeetingMinutes,
} from '@/lib/meetingMinutes';
import type { Room, RoomStatus, Subtitle } from '@/types/types';
import { BottomNav } from '@/pages/guide/GuideScreens';
import { toast } from 'sonner';

interface Props { go: (id: string) => void }

// ─── 导游专用：时长格式化（秒 → 可读字符串） ─────────────────────
function formatSeconds(totalSeconds: number): string {
  if (totalSeconds < 60) return '不足1分钟';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  if (h === 0) return `${m}分钟`;
  return m === 0 ? `${h}小时` : `${h}小时${m}分钟`;
}

/** 导游专用：已结束房间用 started_at/ended_at 计算真实时长 */
function calcEndedDuration(room: Room): string {
  if (room.actual_duration != null && room.actual_duration >= 0) {
    return formatSeconds(room.actual_duration * 60);
  }
  const { started_at, ended_at } = room;
  if (!started_at || !ended_at) return '暂无时长';
  const s = new Date(started_at).getTime();
  const e = new Date(ended_at).getTime();
  if (isNaN(s) || isNaN(e)) return '暂无时长';
  return formatSeconds(Math.max(0, Math.floor((e - s) / 1000)));
}

/** 导游专用：进行中房间已用秒数，started_at 缺失/无效返回 -1 */
function calcLiveElapsedSeconds(room: Room): number {
  try {
    const saved = JSON.parse(localStorage.getItem(`shiguang-live-clock-${room.id}`) ?? '{}') as {
      accumulatedMs?: number;
      segmentStartedAt?: number | null;
      lastHeartbeatAt?: number | null;
    };
    const accumulated = Number(saved.accumulatedMs ?? 0);
    const started = Number(saved.segmentStartedAt ?? 0);
    const heartbeat = Number(saved.lastHeartbeatAt ?? 0);
    const active = started > 0 && heartbeat >= started ? heartbeat - started : 0;
    if (accumulated > 0 || active > 0) return Math.floor((accumulated + active) / 1000);
  } catch { /* 回退数据库分钟数 */ }
  if (room.actual_duration != null) return Math.max(0, room.actual_duration * 60);
  return -1;
}

// ─── 非导游沿用：分钟数格式化（v386 原行为） ─────────────────────
function formatDuration(minutes: number | null): string {
  if (!minutes) return '—';
  if (minutes < 60) return `${minutes} 分钟`;
  const h = Math.floor(minutes / 60), m = minutes % 60;
  return m > 0 ? `${h} 小时 ${m} 分钟` : `${h} 小时`;
}

// ─── 格式化日期 ────────────────────────────────────────────────
function formatDate(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${d.getMonth() + 1}月${d.getDate()}日`;
}

// ─── 状态标签 ──────────────────────────────────────────────────
function StatusBadge({ status }: { status: Room['status'] }) {
  const map: Partial<Record<RoomStatus, { label: string; cls: string }>> = {
    live:     { label: '进行中', cls: 'rec-badge live' },
    pending:  { label: '待开始', cls: 'rec-badge pending' },
    ended:    { label: '已结束', cls: 'rec-badge ended' },
    paused:   { label: '已暂停', cls: 'rec-badge pending' },
    archived: { label: '已归档', cls: 'rec-badge ended' },
    draft:    { label: '草稿',   cls: 'rec-badge ended' },
    ready:    { label: '就绪',   cls: 'rec-badge pending' },
  };
  const { label, cls } = map[status] ?? { label: '—', cls: 'rec-badge ended' };
  return <span className={cls}>{label}</span>;
}

function roomStatusDescription(status: RoomStatus): string {
  if (status === 'live') return '讲解正在进行，可继续进入讲解控制台。';
  if (status === 'paused') return '讲解暂时暂停，可随时返回继续。';
  if (status === 'pending' || status === 'ready') return '房间已经创建，等待开始本场讲解。';
  if (status === 'ended' || status === 'archived') return '讲解已结束，可回顾会议纪要与完整字幕。';
  return '房间资料已保存，可继续完善后使用。';
}

// ─── 导游专用：进行中房间实时时长（每30秒刷新） ───────────────────
function LiveDuration({ room }: { room: Room }) {
  const [elapsed, setElapsed] = useState(() => calcLiveElapsedSeconds(room));
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (elapsed < 0) return;
    timerRef.current = setInterval(() => {
      setElapsed(calcLiveElapsedSeconds(room));
    }, 30_000);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, room.started_at]);

  if (elapsed < 0) return <span>暂无时长</span>;
  return <span>{formatSeconds(elapsed)}</span>;
}

// ─── 导游专用：筛选类型 ────────────────────────────────────────
type FilterTab = 'all' | 'live' | 'ended';

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'all',   label: '全部'   },
  { key: 'live',  label: '进行中' },
  { key: 'ended', label: '已结束' },
];

/**
 * 导游专用筛选：
 * - "进行中"包含尚未开讲与已经开讲：pending / ready / live / paused
 * - "已结束"仅含 ended / archived
 * - draft 只出现在"全部"
 */
function filterRooms(rooms: Room[], tab: FilterTab): Room[] {
  if (tab === 'all') return rooms;
  if (tab === 'live') {
    return rooms.filter(r => (
      r.status === 'pending'
      || r.status === 'ready'
      || r.status === 'live'
      || r.status === 'paused'
    ));
  }
  return rooms.filter(r => r.status === 'ended' || r.status === 'archived');
}

const EMPTY_TEXT: Record<FilterTab, string> = {
  all:   '还没有任何房间记录',
  live:  '当前没有进行中的房间',
  ended: '还没有已结束的房间',
};

const DEFAULT_ROOM_COVER_URL = 'https://miaoda-site-img.cdn.bcebos.com/images/baidu_image_search_1a8b8a77-d487-4258-b258-c6732fb5bac3.jpg';

const ROOM_STATUS_ORDER: Record<RoomStatus, number> = {
  live: 0,
  paused: 1,
  pending: 2,
  ready: 3,
  draft: 4,
  ended: 5,
  archived: 6,
};

function sortRoomsForDisplay(rooms: Room[]): Room[] {
  return [...rooms].sort((a, b) => {
    const byStatus = ROOM_STATUS_ORDER[a.status] - ROOM_STATUS_ORDER[b.status];
    if (byStatus !== 0) return byStatus;
    const aTime = new Date(a.started_at ?? a.created_at).getTime();
    const bTime = new Date(b.started_at ?? b.created_at).getTime();
    return bTime - aTime;
  });
}

// ─── 主组件 ───────────────────────────────────────────────────
export function RecordsScreen({ go }: Props) {
  const { user, profile, setCurrentRoom } = useAuth();
  const role = profile?.role ?? 'tourist';
  const isGuide = role === 'guide';
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [retryTick, setRetryTick] = useState(0);
  const [minuteRoomIds, setMinuteRoomIds] = useState<Set<string>>(new Set());
  // activeTab 只在导游模式下有意义；非导游始终渲染全量列表
  const [activeTab, setActiveTab] = useState<FilterTab>('all');
  const [, setMinutesVersion] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!user) {
      setRooms([]);
      setLoading(false);
      setLoadError('登录状态已失效，请重新登录');
      return;
    }
    setLoading(true);
    setLoadError('');
    void (async () => {
      try {
        const data = isGuide
          ? await fetchGuideRoomsStrict()
          : await fetchMyJoinedRoomsStrict();
        if (cancelled) return;
        setRooms(data);

        if (isGuide) {
          try {
            setMinuteRoomIds(await fetchMeetingMinutesRoomIds());
          } catch {
            // 数据库迁移尚未部署时，继续兼容本机已生成的纪要。
            setMinuteRoomIds(new Set(data.filter(room => hasMeetingMinutes(room.id)).map(room => room.id)));
          }
        }
      } catch (error) {
        if (!cancelled) {
          setRooms([]);
          setLoadError(error instanceof Error ? error.message : '记录读取失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [user, isGuide, retryTick]);

  useEffect(() => subscribeMeetingMinutes(() => setMinutesVersion(value => value + 1)), []);

  const navVariant = isGuide ? 'guide' : role === 'photographer' ? 'photographer' : 'tour';
  // 导游使用筛选，其他角色直接使用全量
  const visibleRooms = sortRoomsForDisplay(isGuide ? filterRooms(rooms, activeTab) : rooms);

  return (
    <div className="screen padded-screen has-tabbar rec-page">
      <div className="rec-page-scroll">
      <header className="rec-page-hero">
        <div>
          <span>讲解归档</span>
          <h1>讲解记录</h1>
          <p>管理已创建房间，继续讲解或回顾会议纪要。</p>
        </div>
        <BookOpen size={30} aria-hidden="true" />
      </header>

      {/* ─── 导游专用：状态筛选 tabs ─── */}
      {isGuide && (
        <div className="rec-filter-tabs" role="tablist" aria-label="房间状态筛选">
          {FILTER_TABS.map(({ key, label }) => (
            <button
              key={key}
              role="tab"
              aria-selected={activeTab === key}
              className={`rec-filter-tab${activeTab === key ? ' active' : ''}`}
              onClick={() => setActiveTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {loading && (
        <div className="rec-loading">
          <div className="rec-spinner" />
          <span>加载中…</span>
        </div>
      )}

      {!loading && loadError && (
        <div className="rec-error" role="alert">
          <p>记录加载失败：{loadError}</p>
          <button onClick={() => setRetryTick(value => value + 1)}>重新加载</button>
        </div>
      )}

      {/* 全量空状态 */}
      {!loading && !loadError && rooms.length === 0 && (
        <div className="rec-empty">
          <Landmark size={40} className="rec-empty-icon" />
          <p>{isGuide ? '还没有创建过房间' : '还没有参与过房间'}</p>
          <button
            className="rec-empty-btn"
            onClick={() => go(isGuide ? 'guide-home' : 'room-list')}
          >
            {isGuide ? '去创建房间' : '去加入房间'}
          </button>
        </div>
      )}

      {/* 导游筛选后空状态 */}
      {isGuide && !loading && rooms.length > 0 && visibleRooms.length === 0 && (
        <div className="rec-empty">
          <Landmark size={40} className="rec-empty-icon" />
          <p>{EMPTY_TEXT[activeTab]}</p>
        </div>
      )}

      {/* 房间列表 */}
      {!loading && !loadError && visibleRooms.map(room => (
        <div key={room.id} className={`rec-room-card rec-room-card--${room.status}`}>
          {/* 封面 */}
          <div className="rec-room-cover">
            <img
              src={room.cover_url || DEFAULT_ROOM_COVER_URL}
              alt={`${room.name}房间封面`}
            />
          </div>

          {/* 内容 */}
          <div className="rec-room-body">
            <div className="rec-room-top">
              <span className="rec-room-name">{room.name}</span>
              <StatusBadge status={room.status} />
            </div>

            <span className="rec-room-number">房间号 {room.room_number}</span>
            <p className="rec-room-summary">{roomStatusDescription(room.status)}</p>

            <div className="rec-room-meta">
              <span><CalendarDays size={12} />{formatDate(room.started_at ?? room.created_at)}</span>
              <span>
                <Clock3 size={12} />
                {isGuide
                  /* 导游：真实时长（started_at/ended_at） */
                  ? (room.status === 'ended' || room.status === 'archived')
                      ? calcEndedDuration(room)
                      : (room.status === 'live' || room.status === 'paused')
                          ? <LiveDuration room={room} />
                          : '暂无时长'
                  /* 非导游：v386 原行为，用 actual_duration / estimated_duration */
                  : formatDuration(room.actual_duration ?? room.estimated_duration)
                }
              </span>
              <span><Users size={12} />{room.online_count} 人</span>
            </div>

            {/* 操作按钮（行为与原版完全一致） */}
            {room.status === 'pending' && isGuide && (
              <button
                className="rec-room-action pending-start"
                onClick={() => { setCurrentRoom(room); go('guide-live'); }}
              >
                <PlayCircle size={12} />开始讲解<ChevronRight size={12} />
              </button>
            )}
            {room.status === 'pending' && !isGuide && (
              <button
                className="rec-room-action pending-start"
                onClick={() => { setCurrentRoom(room); go('listening'); }}
              >
                <PlayCircle size={12} />进入房间<ChevronRight size={12} />
              </button>
            )}
            {room.status === 'live' && (
              <button
                className="rec-room-action live"
                onClick={() => { setCurrentRoom(room); go(isGuide ? 'guide-live' : 'listening'); }}
              >
                <Radio size={12} />{isGuide ? '继续讲解' : '继续收听'}<ChevronRight size={12} />
              </button>
            )}
            {(room.status === 'ended' || room.status === 'archived') && (
              <button
                className="rec-room-action ended"
                onClick={() => {
                  setCurrentRoom(room);
                  go(isGuide ? 'record-detail' : 'subtitle-history');
                }}
              >
                {isGuide && (minuteRoomIds.has(room.id) || hasMeetingMinutes(room.id))
                  ? <><FileText size={12} />查看会议纪要<ChevronRight size={12} /></>
                  : <><Headphones size={12} />查看字幕回放<ChevronRight size={12} /></>
                }
              </button>
            )}
          </div>
        </div>
      ))}
      </div>

      <BottomNav active="记录" go={go} variant={navVariant} />
    </div>
  );
}

/** 导游记录详情：会议纪要 + 该房间的全部字幕。 */
export function RecordDetailScreen({ go }: Props) {
  const { currentRoom, user } = useAuth();
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [minutes, setMinutes] = useState<MeetingMinutes | null>(
    () => currentRoom ? readMeetingMinutes(currentRoom.id) : null,
  );
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [transcriptError, setTranscriptError] = useState('');
  const [retryTick, setRetryTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    if (!currentRoom) {
      setLoading(false);
      return;
    }
    setMinutes(readMeetingMinutes(currentRoom.id));
    setLoading(true);
    setTranscriptError('');
    void (async () => {
      try {
        try {
          const cloudMinutes = await fetchMeetingMinutesCloud(currentRoom.id);
          if (!cancelled && cloudMinutes) {
            saveMeetingMinutes(cloudMinutes);
            setMinutes(cloudMinutes);
          }
        } catch {
          // 云表尚未部署或暂不可用时保留本机副本，不把纪要误判为丢失。
        }

        const rows = await fetchAllSubtitlesStrict(currentRoom.id, user?.id);
        if (cancelled) return;
        setSubtitles(rows);
        const stored = readMeetingMinutes(currentRoom.id);
        if (stored && (!stored.keyPoints || stored.keyPoints.length === 0) && rows.length > 0) {
          const upgraded = generateMeetingMinutes(currentRoom, rows);
          saveMeetingMinutes(upgraded);
          setMinutes(upgraded);
          if (user?.id) {
            void saveMeetingMinutesCloud(upgraded, user.id).catch(() => undefined);
          }
        }
      } catch (error) {
        if (!cancelled) {
          setSubtitles([]);
          setTranscriptError(error instanceof Error ? error.message : '字幕读取失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [currentRoom?.id, user?.id, retryTick]);

  const handleGenerate = async () => {
    if (!currentRoom || generating) return;
    setGenerating(true);
    try {
      const latestSubtitles = await fetchAllSubtitlesStrict(currentRoom.id, user?.id);
      if (latestSubtitles.length === 0) {
        toast.error('没有读取到可用于生成纪要的字幕');
        return;
      }
      setSubtitles(latestSubtitles);
      const generated = generateMeetingMinutes(currentRoom, latestSubtitles);
      saveMeetingMinutes(generated);
      setMinutes(generated);
      if (!user?.id) {
        toast.warning('纪要已保存在本机；登录后才能同步到云端');
        return;
      }
      try {
        await saveMeetingMinutesCloud(generated, user.id);
        toast.success(`已根据 ${latestSubtitles.length} 条字幕重新生成并同步`);
      } catch {
        toast.warning(`已根据 ${latestSubtitles.length} 条字幕生成，本机已保存；云端持久化待数据库迁移生效`);
      }
    } catch (error) {
      toast.error(`重新生成失败：${error instanceof Error ? error.message : '请稍后重试'}`);
    } finally {
      setGenerating(false);
    }
  };

  if (!currentRoom) {
    return (
      <div className="screen padded-screen rec-detail-page">
        <div className="mini-header">
          <button className="back-button" onClick={() => go('records')} aria-label="返回"><span className="back-chevron" /></button>
          <strong>讲解记录</strong><span />
        </div>
        <div className="rec-empty">
          <FileText size={40} className="rec-empty-icon" />
          <p>尚未选择讲解记录</p>
          <button className="rec-empty-btn" onClick={() => go('records')}>返回记录列表</button>
        </div>
      </div>
    );
  }

  return (
    <div className="screen padded-screen rec-detail-page">
      <div className="mini-header">
        <button className="back-button" onClick={() => go('records')} aria-label="返回"><span className="back-chevron" /></button>
        <strong>讲解记录</strong><span />
      </div>

      <section className="minutes-document">
        <div className="minutes-document__head">
          <div>
            <small>讲解会议纪要</small>
            <h2>{minutes?.title ?? currentRoom.name}</h2>
          </div>
          <Sparkles size={22} />
        </div>
        {minutes ? (
          <>
            <section className="minutes-fixed-step">
              <header className="minutes-fixed-step__header">
                <span>01</span>
                <h3>关键词</h3>
              </header>
              <div className="minutes-fixed-step__body">
                <div className="minutes-keywords minutes-keywords--primary">
                  {(minutes.keywords ?? ['讲解主题'])
                    .slice(0, 8)
                    .map(keyword => <span key={keyword}>{keyword}</span>)}
                </div>
              </div>
            </section>

            <section className="minutes-fixed-step">
              <header className="minutes-fixed-step__header">
                <span>02</span>
                <h3>讲解信息</h3>
              </header>
              <div className="minutes-fixed-step__body">
                <div className="minutes-info-grid">
                  <div>
                    <CalendarDays size={14} />
                    <span>开始时间</span>
                    <b>{minutes.startedAt ? new Date(minutes.startedAt).toLocaleString('zh-CN', {
                      month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    }) : '—'}</b>
                  </div>
                  <div>
                    <Clock3 size={14} />
                    <span>讲解时长</span>
                    <b>{formatSeconds(minutes.durationSeconds || (currentRoom.actual_duration ?? 0) * 60)}</b>
                  </div>
                  <div>
                    <BookOpen size={14} />
                    <span>字幕依据</span>
                    <b>{minutes.subtitleCount} 条</b>
                  </div>
                </div>
              </div>
            </section>

            <section className="minutes-fixed-step">
              <header className="minutes-fixed-step__header">
                <span>03</span>
                <h3>讲解摘要</h3>
              </header>
              <div className="minutes-fixed-step__body">
                <p className="minutes-fixed-summary">{minutes.overview}</p>
              </div>
            </section>

            <section className="minutes-fixed-step">
              <header className="minutes-fixed-step__header">
                <span>04</span>
                <h3>关键内容</h3>
              </header>
              <div className="minutes-fixed-step__body">
                {minutes.keyPoints?.length > 0 ? (
                  <ul className="minutes-fixed-points">
                    {minutes.keyPoints.map((point, index) => (
                      <li key={`${index}-${point}`}>
                        <span>{String(index + 1).padStart(2, '0')}</span>
                        <p>{point}</p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="minutes-template-upgrade">
                    <p>这份纪要为旧模板，点击下方按钮即可按新模板重新生成。</p>
                  </div>
                )}
              </div>
            </section>

            <div className="minutes-document__footer">
              <span>生成于 {new Date(minutes.generatedAt).toLocaleString('zh-CN')}</span>
              <button className="minutes-regenerate" onClick={handleGenerate} disabled={loading || generating}>
                <RefreshCw size={14} />{generating ? '正在重新读取字幕…' : '重新生成'}
              </button>
            </div>
          </>
        ) : (
          <div className="minutes-empty">
            <p>结束讲解时未生成会议纪要，你仍可根据本房间的全部字幕生成。</p>
            <button onClick={handleGenerate} disabled={loading || generating || subtitles.length === 0}>
              <Sparkles size={15} />{loading ? '正在读取字幕…' : generating ? '生成中…' : '生成会议纪要'}
            </button>
          </div>
        )}
      </section>

      <div className="record-transcript-head">
        <div><BookOpen size={17} /><strong>全部字幕</strong></div>
        <span>{loading ? '加载中…' : `${subtitles.length} 条`}</span>
      </div>
      {!loading && transcriptError ? (
        <div className="rec-error" role="alert">
          <p>字幕加载失败：{transcriptError}</p>
          <button onClick={() => setRetryTick(value => value + 1)}>重新加载</button>
        </div>
      ) : !loading && subtitles.length === 0 ? (
        <div className="rec-empty">
          <BookOpen size={36} className="rec-empty-icon" />
          <p>本次讲解没有字幕记录</p>
        </div>
      ) : (
        <div className="record-transcript-list">
          {subtitles.map(item => (
            <article key={item.id} className="record-transcript-item">
              <time>{new Date(item.created_at).toLocaleTimeString('zh-CN', {
                hour: '2-digit', minute: '2-digit', second: '2-digit',
              })}</time>
              <p>{item.content_cn}</p>
              {item.content_en && <small>{item.content_en}</small>}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
