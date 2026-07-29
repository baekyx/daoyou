import { useEffect, useRef, useState } from 'react';
import { Landmark, Clock3, Users, ChevronRight, Radio, CalendarDays, Headphones, PlayCircle } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { fetchGuideRooms } from '@/api/rooms';
import { fetchMyJoinedRooms } from '@/api/roomActivity';
import type { Room, RoomStatus } from '@/types/types';
import { BottomNav } from '@/pages/guide/GuideScreens';

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
  const { started_at, ended_at } = room;
  if (!started_at || !ended_at) return '暂无时长';
  const s = new Date(started_at).getTime();
  const e = new Date(ended_at).getTime();
  if (isNaN(s) || isNaN(e)) return '暂无时长';
  return formatSeconds(Math.max(0, Math.floor((e - s) / 1000)));
}

/** 导游专用：进行中房间已用秒数，started_at 缺失/无效返回 -1 */
function calcLiveElapsedSeconds(room: Room): number {
  if (!room.started_at) return -1;
  const s = new Date(room.started_at).getTime();
  if (isNaN(s)) return -1;
  return Math.max(0, Math.floor((Date.now() - s) / 1000));
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
 * - "进行中"仅含 live / paused
 * - "已结束"仅含 ended / archived
 * - pending / ready / draft 只出现在"全部"
 */
function filterRooms(rooms: Room[], tab: FilterTab): Room[] {
  if (tab === 'all') return rooms;
  if (tab === 'live') return rooms.filter(r => r.status === 'live' || r.status === 'paused');
  return rooms.filter(r => r.status === 'ended' || r.status === 'archived');
}

const EMPTY_TEXT: Record<FilterTab, string> = {
  all:   '还没有任何房间记录',
  live:  '当前没有进行中的房间',
  ended: '还没有已结束的房间',
};

// ─── 主组件 ───────────────────────────────────────────────────
export function RecordsScreen({ go }: Props) {
  const { user, profile, setCurrentRoom } = useAuth();
  const role = profile?.role ?? 'tourist';
  const isGuide = role === 'guide';
  const [rooms, setRooms] = useState<Room[]>([]);
  const [loading, setLoading] = useState(true);
  // activeTab 只在导游模式下有意义；非导游始终渲染全量列表
  const [activeTab, setActiveTab] = useState<FilterTab>('all');

  useEffect(() => {
    if (!user) return;
    setLoading(true);
    const fetch = isGuide
      ? fetchGuideRooms(user.id)
      : fetchMyJoinedRooms(user.id);
    fetch.then(data => { setRooms(data); setLoading(false); });
  }, [user, isGuide]);

  const navVariant = isGuide ? 'guide' : role === 'photographer' ? 'photographer' : 'tour';
  // 导游使用筛选，其他角色直接使用全量
  const visibleRooms = isGuide ? filterRooms(rooms, activeTab) : rooms;

  return (
    <div className="screen padded-screen has-tabbar rec-page">
      {/* 标题栏 */}
      <div className="mini-header">
        <span />
        <strong>记录</strong>
        <span />
      </div>

      {/* 统计摘要 */}
      <div className="rec-stats-row">
        <div className="rec-stat-card">
          <span className="rec-stat-num">{rooms.length}</span>
          <span className="rec-stat-label">{isGuide ? '创建房间' : '参与房间'}</span>
        </div>
        <div className="rec-stat-card">
          <span className="rec-stat-num">
            {rooms.filter(r => r.status === 'ended').length}
          </span>
          <span className="rec-stat-label">已结束</span>
        </div>
        <div className="rec-stat-card">
          <span className="rec-stat-num">
            {rooms.filter(r => r.status === 'live').length}
          </span>
          <span className="rec-stat-label">进行中</span>
        </div>
        <div className="rec-stat-card">
          <span className="rec-stat-num">
            {rooms.filter(r => r.status === 'pending').length}
          </span>
          <span className="rec-stat-label">待开始</span>
        </div>
      </div>

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

      {/* 全量空状态 */}
      {!loading && rooms.length === 0 && (
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
      {!loading && visibleRooms.map(room => (
        <div key={room.id} className="rec-room-card">
          {/* 封面 */}
          <div className="rec-room-cover">
            {room.cover_url
              ? <img src={room.cover_url} alt={room.name} />
              : <Landmark size={22} className="rec-room-cover-icon" />
            }
          </div>

          {/* 内容 */}
          <div className="rec-room-body">
            <div className="rec-room-top">
              <span className="rec-room-name">{room.name}</span>
              <StatusBadge status={room.status} />
            </div>

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
            {room.status === 'ended' && (
              <button
                className="rec-room-action ended"
                onClick={() => go('subtitle-history')}
              >
                <Headphones size={12} />查看字幕回放<ChevronRight size={12} />
              </button>
            )}
          </div>
        </div>
      ))}

      <BottomNav active="记录" go={go} variant={navVariant} />
    </div>
  );
}
