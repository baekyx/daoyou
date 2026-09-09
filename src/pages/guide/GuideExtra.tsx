/**
 * 导游端扩展页面：
 * - GuestList (G06)       游客列表
 * - GuideSubtitleRecord (G07) 字幕记录
 * - KnowledgeCardLib (G08)  景区卡片库
 * - KnowledgeCardEdit (G09) 卡片新建/编辑
 * - EndResult (G11)         讲解结束结果
 * - GuideMyPage            导游「我的」专用版
 */
import React, { useEffect, useState, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  ChevronRight, Search, UserRound, UsersRound, Camera as CameraIcon,
  Plus, Landmark, Crown, Star, CalendarDays, Clock3, Radio,
  CheckCircle2, XCircle, ImagePlus, Edit2, Trash2, Eye,
  BookOpen, History, LogOut, Settings, HelpCircle, Shield,
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/db/supabase';
import { fetchAllSubtitles } from '@/api/subtitles';
import { fetchRoomMemberHistory, fetchRoomMembersSafe } from '@/api/profiles';
import { RoomPresenceProvider, useRoomPresence } from '@/hooks/use-room-presence';
import { ScenicCardShell } from '@/pages/cards/CardScreens';
import { RoomCoverCropModal } from '@/components/RoomCoverCropModal';
import { uploadCardImageBlob } from '@/api/cardImage';

import type { Subtitle, KnowledgeCard, RoomMember } from '@/types/types';
import { toast } from 'sonner';

interface Props { go: (id: string) => void }
interface GuestListProps extends Props {
  initialMembers?: RoomMember[];
  presenceProvided?: boolean;
}
interface GuideSubtitleRecordProps extends Props { initialSubtitles?: Subtitle[] }

function markGuideSubtitlesSeen(roomId: string, seenAt = Date.now()) {
  try {
    localStorage.setItem(`shiguang-guide-subtitle-seen-${roomId}`, String(seenAt));
  } catch {
    // 本地存储不可用时仍通知当前页面内的讲解控制台清零。
  }
  window.dispatchEvent(new CustomEvent('shiguang-guide-subtitles-seen', {
    detail: { roomId, seenAt },
  }));
}

// ─── 通用头像 ─────────────────────────────────────────
function Avatar({ url, className = '' }: { url?: string | null; className?: string }) {
  if (url) return <img src={url} className={`avatar ${className}`} alt="头像" style={{ objectFit: 'cover' }} />;
  return <div className={`avatar ${className}`} />;
}

// ─── 身份标签 ─────────────────────────────────────────
function RoleBadge({ role }: { role: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    guide:        { label: '导游',   cls: 'badge-guide' },
    tourist:      { label: '游客',   cls: 'badge-tourist' },
    photographer: { label: '摄影师', cls: 'badge-photo' },
  };
  const { label, cls } = map[role] ?? { label: role, cls: '' };
  return <span className={`member-role-badge ${cls}`}>{label}</span>;
}

// ─── G06 游客列表 ─────────────────────────────────────
/**
 * GuestList 内层组件：依赖 RoomPresenceProvider，可直接消费 useRoomPresence。
 * 历史成员合并 room_members 与 approved memberships，排除导游并按 user_id 去重；
 * 在线状态来自 Presence onlineParticipantIds（唯一真值，不依赖 left_at）。
 *
 * v379 修复：
 *   - 等待 user 就绪（auth.uid() 有效）再发请求，避免 RPC not_authenticated；
 *   - roomId 或 user 变化时取消旧请求，防止旧结果覆盖新房间；
 *   - not_authenticated / 瞬时网络错误：最多重试 3 次，指数退避（500→1000→2000ms）；
 *   - permission_denied 等确定性错误：不重试，直接展示错误态 + 手动重试入口；
 *   - 请求成功 0 条才显示"暂无游客"，失败显示错误提示；
 *   - 前端过滤 user_id === guide_id 的脏行（不修改数据库）；
 *   - 可检索日志：[GuestListHistory] start/retry/success/error。
 */
function GuestListInner({ go, initialMembers = [] }: GuestListProps) {
  const { currentRoom, user, loading: authLoading } = useAuth();
  const { onlineParticipantIds, participantCount } = useRoomPresence();
  const [members, setMembers] = useState<RoomMember[]>(initialMembers);
  const [search, setSearch] = useState('');
  // 'idle' | 'loading' | 'success' | 'error'
  const [loadState, setLoadState] = useState<'idle' | 'loading' | 'success' | 'error'>('idle');
  const [errorMsg, setErrorMsg] = useState('');
  // 手动重试触发器：每次点击+1，useEffect 检测到变化后重新执行
  const [retryTick, setRetryTick] = useState(0);
  // 取消标记：roomId/user 变化时置 true，旧飞行中请求到达后丢弃结果
  const cancelRef = useRef(false);

  useEffect(() => {
    if (initialMembers.length === 0) return;
    setMembers(current => Array.from(
      new Map([...current, ...initialMembers].map(member => [member.id, member])).values(),
    ));
  }, [initialMembers]);

  // 是否为可重试的瞬时错误（session 尚未恢复 / 网络）
  const isRetryable = (msg: string) =>
    msg.includes('not_authenticated') ||
    msg.includes('JWT') ||
    msg.includes('session') ||
    msg.includes('network') ||
    msg.includes('fetch');

  const roomId    = currentRoom?.id;
  const guideId   = currentRoom?.guide_id;   // 用于前端过滤脏行
  // 认证就绪：auth 初始化完成且 user 已存在
  const authReady = !authLoading && !!user;

  useEffect(() => {
    // 认证未就绪或 roomId 不存在时不请求（等下次 user/loading 变化触发）
    if (!authReady || !roomId) return;

    let cancelled = false;
    cancelRef.current = false;

    const MAX_RETRIES = 3;
    // 仅对瞬时错误退避重试，确定性错误（permission_denied）最多 1 次
    const load = async (attempt: number) => {
      if (cancelled) return;
      console.info('[GuestListHistory] start', { roomId, attempt });
      setLoadState('loading');

      try {
        const rows = await fetchRoomMemberHistory(roomId);
        if (cancelled) return; // 已换房间，丢弃结果

        console.info('[GuestListHistory] success', { roomId, attempt, rows: rows.length });
        setMembers(rows);
        setLoadState('success');
        setErrorMsg('');
      } catch (err: unknown) {
        if (cancelled) return;

        const msg = err instanceof Error ? err.message
          : (err as { message?: string })?.message ?? String(err);

        const canRetry = isRetryable(msg) && attempt < MAX_RETRIES;
        console.error('[GuestListHistory] error', { roomId, attempt, canRetry, message: msg });

        if (canRetry) {
          const delay = 500 * Math.pow(2, attempt - 1); // 500→1000→2000ms
          console.info('[GuestListHistory] retry', { roomId, attempt, delayMs: delay });
          await new Promise(r => setTimeout(r, delay));
          if (!cancelled) load(attempt + 1);
        } else {
          // 完整历史读取失败时只显示明确错误，不把当前成员伪装成历史成员。
          try {
            const fallbackRows = await fetchRoomMembersSafe(roomId);
            if (cancelled) return;
            if (fallbackRows.length > 0) {
              setMembers(fallbackRows.filter(member => member.role !== 'guide'));
            }
            setLoadState('error');
            setErrorMsg('历史成员加载失败，请点击重试');
          } catch {
            setLoadState('error');
            setErrorMsg(
              msg.includes('permission_denied')
                ? '权限不足，无法加载游客列表'
                : '加载失败，请点击重试'
            );
          }
        }
      }
    };

    load(1);

    return () => {
      // roomId / user 变化或组件卸载时取消
      cancelled = true;
      cancelRef.current = true;
    };
    // retryTick 变化触发手动重试；authReady/roomId/user?.id 变化自动重新加载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId, user?.id, authReady, retryTick]);

  // 前端过滤：排除 user_id === guideId 的异常脏行（不修改数据库）
  const cleanMembers = guideId
    ? members.filter(m => m.user_id !== guideId)
    : members;

  const filtered = cleanMembers.filter(m => {
    const name = (m.profile as { nickname?: string; username?: string } | undefined)?.nickname
      ?? (m.profile as { nickname?: string; username?: string } | undefined)?.username
      ?? '';
    return !search || name.includes(search);
  });

  // 历史成员总人数（排脏后，RPC 已保证 user_id 唯一）
  const historyCount = cleanMembers.length;

  return (
    <div className="screen padded-screen guest-list-screen">
      <div className="mini-header">
        <button className="back-button" onClick={() => go('guide-live')} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>游客列表</strong>
        <span />
      </div>

      <div className="member-stats-row">
        {/* 在线人数：Presence 唯一来源 */}
        <div className="member-stat"><b>{participantCount}</b><small>在线</small></div>
        {/* 历史人数：排脏后历史成员数（含已退出） */}
        <div className="member-stat"><b>{historyCount}</b><small>历史人数</small></div>
      </div>

      <div className="member-tab-row">
        <button className="active" aria-pressed="true">全部成员</button>
      </div>

      <div className="member-search-wrap">
        <Search size={14} />
        <input placeholder="搜索成员…" value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {/* 错误态：加载失败，显示错误提示 + 重试按钮，不显示"暂无游客" */}
      {loadState === 'error' ? (
        <div className="empty-state">
          <UsersRound size={40} className="empty-icon" />
          <p className="empty-title">{errorMsg}</p>
          <button
            className="primary-button green"
            style={{ marginTop: 12 }}
            onClick={() => setRetryTick(t => t + 1)}
          >
            重新加载
          </button>
        </div>
      ) : loadState === 'loading' && members.length === 0 ? (
        /* 首次加载中骨架：避免闪烁空态 */
        <div className="empty-state">
          <p className="empty-title" style={{ color: 'var(--muted)' }}>加载中…</p>
        </div>
      ) : filtered.length === 0 ? (
        /* 真正 0 条：请求成功且 cleanMembers 为空 */
        <div className="empty-state">
          <UsersRound size={40} className="empty-icon" />
          <p className="empty-title">暂无游客加入</p>
          <small className="empty-desc">游客通过房间号或分享链接加入后将显示在这里</small>
        </div>
      ) : (
        <div className="member-list">
          {filtered.map(m => {
            const isOnline = onlineParticipantIds.has(m.user_id);
            const profile = m.profile as { nickname?: string | null; username?: string; avatar_url?: string | null } | undefined;
            return (
              <div key={m.id} className="member-item">
                <Avatar url={profile?.avatar_url} className="member-avatar" />
                <div className="member-info">
                  <span className="member-name">
                    {profile?.nickname ?? profile?.username ?? '用户'}
                    <RoleBadge role={m.role} />
                  </span>
                  <div className="member-meta">
                    <span className="member-join-time">
                      首次进入 {new Date(m.joined_at).toLocaleString('zh-CN', {
                        month: 'numeric', day: 'numeric',
                        hour: '2-digit', minute: '2-digit',
                      })}
                    </span>
                    {/* 在线状态：仅由 Presence 决定，绿色在线/灰色离线 */}
                    {isOnline
                      ? <span className="member-status online">在线</span>
                      : <span className="member-status offline">离线</span>
                    }
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * GuestList 外层：挂载导游侧 Presence 订阅（仅订阅，不 track，role='guide'）。
 * 导游不计入游客人数；Presence 仅用于读取 tourist 在线集合。
 */
export function GuestList({ go, initialMembers, presenceProvided = false }: GuestListProps) {
  const { currentRoom, user } = useAuth();
  if (presenceProvided) {
    return <GuestListInner go={go} initialMembers={initialMembers} />;
  }
  return (
    <RoomPresenceProvider
      roomId={currentRoom?.id ?? ''}
      userId={user?.id ?? ''}
      role="guide"
    >
      <GuestListInner go={go} initialMembers={initialMembers} />
    </RoomPresenceProvider>
  );
}

// ─── G07 导游字幕记录 ─────────────────────────────────
export function GuideSubtitleRecord({
  go,
  initialSubtitles = [],
}: GuideSubtitleRecordProps) {
  const { currentRoom, user } = useAuth();
  const sortNewestFirst = (items: Subtitle[]) =>
    [...items].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  const mergeSubtitles = (current: Subtitle[], incoming: Subtitle[]) =>
    sortNewestFirst(Array.from(
      new Map([...current, ...incoming].map(item => [item.id, item])).values(),
    ));
  const scopedInitialSubtitles = currentRoom
    ? initialSubtitles.filter(item => item.room_id === currentRoom.id)
    : [];
  const [subtitles, setSubtitles] = useState<Subtitle[]>(() => sortNewestFirst(scopedInitialSubtitles));
  const [loadingSubtitles, setLoadingSubtitles] = useState(true);

  useEffect(() => {
    if (!currentRoom) return;
    markGuideSubtitlesSeen(currentRoom.id);
    if (scopedInitialSubtitles.length > 0) {
      setSubtitles(current => mergeSubtitles(current, scopedInitialSubtitles));
    }
    const load = async () => {
      setLoadingSubtitles(true);
      const rows = await fetchAllSubtitles(currentRoom.id, user?.id);
      if (rows.length > 0) {
        setSubtitles(current => mergeSubtitles(current, rows));
      }
      setLoadingSubtitles(false);
    };
    void load();
    // 复用 GuideScreens 已有的 guide-live channel 通过 shiguang-local-subtitle
    // CustomEvent 广播的字幕，不再单独开 subtitles Realtime channel，
    // 避免额外占用数据库连接配额（修复 DatabaseLackOfConnections）
    const onLocal = (e: Event) => {
      const subtitle = (e as CustomEvent<Subtitle>).detail;
      if (!subtitle || subtitle.room_id !== currentRoom.id) return;
      setSubtitles(prev => [...prev.filter(item => item.id !== subtitle.id), subtitle]
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()));
      markGuideSubtitlesSeen(currentRoom.id);
    };
    window.addEventListener('shiguang-local-subtitle', onLocal);
    return () => { window.removeEventListener('shiguang-local-subtitle', onLocal); };
  }, [currentRoom?.id, user?.id]);

  useEffect(() => {
    if (scopedInitialSubtitles.length === 0) return;
    setSubtitles(current => mergeSubtitles(current, scopedInitialSubtitles));
  }, [initialSubtitles, currentRoom?.id]);

  return (
    <div className="screen padded-screen guide-subtitle-record-screen">
      <div className="mini-header">
        <button className="back-button" onClick={() => go('guide-live')} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>字幕记录</strong>
        <span />
      </div>

      <p className="guide-subtitle-note">
        以下为本次讲解的全部字幕，共 {subtitles.length} 条；实时讲解页仅保留最新 50 条。
      </p>

      {loadingSubtitles && subtitles.length === 0 ? (
        <div className="empty-state">
          <p className="empty-title">正在加载全部字幕…</p>
        </div>
      ) : subtitles.length === 0 ? (
        <div className="empty-state">
          <BookOpen size={40} className="empty-icon" />
          <p className="empty-title">暂无字幕记录</p>
          <small className="empty-desc">开始讲解后，字幕将实时显示在这里</small>
        </div>
      ) : (
        <div className="guide-subtitle-list">
          {subtitles.map(s => (
            <div key={s.id} className="guide-subtitle-item">
              <span className="gsi-time">{new Date(s.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
              <div className="gsi-body">
                <p className="gsi-cn">{s.content_cn}</p>
                {s.content_en && <p className="gsi-en">{s.content_en}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── G08 景区卡片库（素材管理，纯 KC，不推送） ────────
const CATEGORIES = ['全部', '景点导览', '建筑艺术', '文物珍藏', '历史故事', '文化典故'];

export function KnowledgeCardLib({ go }: Props) {
  const { user } = useAuth();
  const [cards, setCards] = useState<KnowledgeCard[]>([]);
  const [category, setCategory] = useState('全部');
  const [search, setSearch] = useState('');
  const [editCard, setEditCard] = useState<KnowledgeCard | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  // 预览弹窗
  const [previewCard, setPreviewCard] = useState<KnowledgeCard | null>(null);

  // 记录来源页，返回时跳回来源而非写死 guide-live
  const backTarget = sessionStorage.getItem('kc_library_from') ?? 'my';

  const loadCards = async () => {
    if (!user?.id) {
      setCards([]);
      return;
    }
    let q = supabase
      .from('knowledge_cards')
      .select('*')
      .eq('created_by', user.id)
      .is('deleted_at', null)
      .order('created_at', { ascending: false });
    if (category !== '全部') q = q.eq('category', category);
    const { data, error } = await q;
    if (error) {
      toast.error(`卡片加载失败：${error.message}`);
      setCards([]);
      return;
    }
    setCards((data ?? []) as KnowledgeCard[]);
  };

  useEffect(() => { void loadCards(); }, [category, user?.id]);

  // 从 card-library 编辑跳转过来时，自动定位并打开编辑弹窗
  useEffect(() => {
    const editId = sessionStorage.getItem('kc_edit_id');
    if (!editId) return;
    sessionStorage.removeItem('kc_edit_id');
    // 等卡片加载完成后再找到目标卡片
    const tryOpen = (retries = 0) => {
      setCards(prev => {
        const target = prev.find(c => c.id === editId);
        if (target) { setEditCard(target); return prev; }
        // 如果还没加载完，最多重试 5 次（每次延迟 300ms）
        if (retries < 5) setTimeout(() => tryOpen(retries + 1), 300);
        return prev;
      });
    };
    tryOpen();
  }, []);

  const filtered = search
    ? cards.filter(c => c.title_cn.includes(search) || (c.title_en ?? '').includes(search))
    : cards;

  const handleDelete = async () => {
    if (!deleteId || !user?.id) return;
    setDeleteBusy(true);
    const targetId = deleteId;
    const { data, error } = await supabase
      .from('knowledge_cards')
      .update({ deleted_at: new Date().toISOString() })
      .eq('id', targetId)
      .eq('created_by', user.id)
      .select('id')
      .maybeSingle();
    setDeleteBusy(false);
    setDeleteId(null);
    if (error) { toast.error('删除失败：' + error.message); return; }
    if (!data) { toast.error('删除失败：卡片不存在或不属于当前导游'); return; }
    toast.success('卡片已下架（软删除）');
    setCards(prev => prev.filter(c => c.id !== targetId));
  };

  return (
    <div className="screen padded-screen kc-library-screen">
      <div className="mini-header">
        <button className="back-button" onClick={() => go(backTarget)} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>景区知识卡片</strong>
        <button className="icon-btn" onClick={() => setEditCard({} as KnowledgeCard)} aria-label="新建">
          <Plus size={20} />
        </button>
      </div>

      <div className="kc-search-wrap">
        <Search size={14} />
        <input placeholder="搜索卡片名称…" value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {/* 分类 tab — sticky */}
      <div className="library-filters-sticky">
        <div className="library-filters">
          {CATEGORIES.map(c => (
            <button key={c} className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>{c}</button>
          ))}
        </div>
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <Landmark size={40} className="empty-icon" />
          <p className="empty-title">暂无卡片</p>
          <small className="empty-desc">点击右上角 + 新建景区知识卡片</small>
          <button className="empty-action-btn" onClick={() => setEditCard({} as KnowledgeCard)}>新建卡片</button>
        </div>
      ) : (
        <div className="kc-list">
          {filtered.map(card => {
            const isPublished = card.status === 'published';
            return (
              <ScenicCardShell
                key={card.id}
                imageUrl={card.image_url}
                titleCn={card.title_cn}
                titleEn={card.title_en}
                descCn={card.desc_cn}
                category={card.category}
                statusTag={
                  <span className={`kc-status-tag ${isPublished ? 'published' : 'draft'}`}>
                    {isPublished ? '已发布' : '草稿'}
                  </span>
                }
                footerActions={
                  <>
                    <button className="sc-btn sc-btn--del" onClick={() => setDeleteId(card.id)} aria-label="删除卡片">
                      <Trash2 size={12} />删除
                    </button>
                    <button className="sc-btn sc-btn--edit" onClick={() => setEditCard(card)} aria-label="编辑卡片">
                      <Edit2 size={12} />编辑
                    </button>
                    <button className="sc-btn sc-btn--prev" onClick={() => setPreviewCard(card)} aria-label="预览卡片">
                      <Eye size={12} />预览
                    </button>
                  </>
                }
              />
            );
          })}
        </div>
      )}

      {editCard !== null && (
        <KnowledgeCardEditModal
          card={editCard}
          onClose={() => setEditCard(null)}
          onSaved={() => { setEditCard(null); loadCards(); }}
          userId={user?.id ?? ''}
        />
      )}

      {/* 预览弹窗 */}
      {previewCard && (
        <div className="kc-preview-overlay" onClick={() => setPreviewCard(null)}>
          <div className="kc-preview-sheet" onClick={e => e.stopPropagation()}>
            <div className="kc-preview-header">
              <h3>{previewCard.title_cn}</h3>
              <button className="modal-close" onClick={() => setPreviewCard(null)}>×</button>
            </div>
            {previewCard.image_url
              ? <img className="knowledge-card-image" src={previewCard.image_url} alt={previewCard.title_cn} />
              : <div className="kc-preview-noimg"><Landmark size={32} /></div>
            }
            {previewCard.title_en && <p className="kc-preview-en">{previewCard.title_en}</p>}
            <p className="knowledge-card-description">{previewCard.desc_cn}</p>
            <div className="kc-preview-meta">
              {previewCard.era && <span><CalendarDays size={11} />{previewCard.era}</span>}
              {previewCard.location && <span><Crown size={11} />{previewCard.location}</span>}
            </div>
            <button className="primary-button green" onClick={() => setPreviewCard(null)}>关闭预览</button>
          </div>
        </div>
      )}

      {/* 删除确认弹层 */}
      {deleteId && (
        <div className="kc-delete-overlay" onClick={() => !deleteBusy && setDeleteId(null)}>
          <div className="kc-delete-sheet" onClick={e => e.stopPropagation()}>
            <div className="kc-delete-icon"><Trash2 size={26} /></div>
            <h3>确认删除卡片？</h3>
            <p>删除后无法恢复，该卡片将从卡片库中移除。</p>
            <div className="kc-delete-actions">
              <button className="kc-delete-cancel" onClick={() => setDeleteId(null)} disabled={deleteBusy}>取消</button>
              <button className="kc-delete-ok" onClick={handleDelete} disabled={deleteBusy}>
                {deleteBusy ? '删除中…' : '确认删除'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── G09 景区卡片新建/编辑 Modal（已导出，供 CardScreens 复用） ──────────
export interface EditModalProps {
  card: Partial<KnowledgeCard>;
  onClose: () => void;
  /** 保存成功后回调，传入服务端返回的最新卡片数据（仅 UPDATE 时有值） */
  onSaved: (updated?: KnowledgeCard) => void;
  userId: string;
}
export function KnowledgeCardEditModal({ card, onClose, onSaved, userId }: EditModalProps) {
  const [form, setForm] = useState({
    title_cn: card.title_cn ?? '',
    title_en: card.title_en ?? '',
    desc_cn: card.desc_cn ?? '',
    desc_en: card.desc_en ?? '',
    category: card.category ?? '景点导览',
    era: card.era ?? '',
    location: card.location ?? '',
    status: card.status ?? 'published',
  });
  const [busy, setBusy] = useState(false);
  const [imageBlob, setImageBlob] = useState<Blob | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(card.image_url ?? null);
  const [imageRemoved, setImageRemoved] = useState(false);
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const imageInputRef = useRef<HTMLInputElement>(null);
  const cardIdRef = useRef(card.id ?? crypto.randomUUID());

  const set = (k: string, v: string) => setForm(p => ({ ...p, [k]: v }));

  useEffect(() => () => {
    if (cropSrc) URL.revokeObjectURL(cropSrc);
    if (imagePreview?.startsWith('blob:')) URL.revokeObjectURL(imagePreview);
  }, [cropSrc, imagePreview]);

  const handleImageChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      toast.error('请选择 JPG、PNG 或 WebP 格式的图片');
      return;
    }
    setCropSrc(current => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(file);
    });
  };

  const handleCropConfirm = (blob: Blob) => {
    setImagePreview(current => {
      if (current?.startsWith('blob:')) URL.revokeObjectURL(current);
      return URL.createObjectURL(blob);
    });
    setImageBlob(blob);
    setImageRemoved(false);
    setCropSrc(current => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  };

  const handleCropCancel = () => {
    setCropSrc(current => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
  };

  const handleRemoveImage = () => {
    setImagePreview(current => {
      if (current?.startsWith('blob:')) URL.revokeObjectURL(current);
      return null;
    });
    setImageBlob(null);
    setImageRemoved(true);
  };

  const handleSave = async (status: 'draft' | 'published') => {
    if (!form.title_cn) { toast.error('请填写中文标题'); return; }
    if (!form.desc_cn) { toast.error('请填写中文描述'); return; }
    setBusy(true);
    const cardId = cardIdRef.current;
    let imageUrl = imageRemoved ? null : (card.image_url ?? null);
    if (imageBlob) {
      const upload = await uploadCardImageBlob(userId, cardId, imageBlob);
      if (!upload.url) {
        setBusy(false);
        toast.error(`图片上传失败：${upload.error ?? '请稍后重试'}`);
        return;
      }
      imageUrl = upload.url;
    }
    const payload = { ...form, status, image_url: imageUrl };
    if (card.id) {
      // UPDATE：按 id 更新原记录，绝不插入新行
      const { data, error } = await supabase
        .from('knowledge_cards')
        .update(payload)
        .eq('id', card.id)
        .eq('created_by', userId)
        .select()
        .single();
      setBusy(false);
      if (error) { toast.error('保存失败：' + error.message); return; }
      toast.success(status === 'draft' ? '已保存草稿' : '卡片已发布');
      onSaved(data as KnowledgeCard);
    } else {
      const { error } = await supabase
        .from('knowledge_cards')
        .insert({ id: cardId, ...payload, created_by: userId });
      setBusy(false);
      if (error) { toast.error('保存失败：' + error.message); return; }
      toast.success(status === 'draft' ? '已保存草稿' : '卡片已发布');
      onSaved();
    }
  };

  // 用 Portal 渲染到 .mobile-app 根节点，避免被祖先 overflow:hidden 裁切
  const appRoot = document.querySelector('.mobile-app') ?? document.body;

  return createPortal(
    <div className="modal-overlay" onClick={onClose}>
      <div className="kc-edit-modal" onClick={e => e.stopPropagation()}>
        <div className="modal-header">
          <strong>{card.id ? '编辑卡片' : '新建景区卡片'}</strong>
          <button onClick={onClose} className="modal-close">×</button>
        </div>
        <div className="kc-edit-scroll">
          <div className="kc-field">
            <label>中文标题 *</label>
            <input className="profile-input" value={form.title_cn} onChange={e => set('title_cn', e.target.value)} placeholder="请输入中文标题" />
          </div>
          <div className="kc-field">
            <label>英文标题（选填）</label>
            <input className="profile-input" value={form.title_en} onChange={e => set('title_en', e.target.value)} placeholder="English title (optional)" />
          </div>
          <div className="kc-field">
            <label>中文描述 *</label>
            <textarea className="profile-input" rows={4} value={form.desc_cn} onChange={e => set('desc_cn', e.target.value)} placeholder="请输入中文描述" />
          </div>
          <div className="kc-field">
            <label>英文描述（选填）</label>
            <textarea className="profile-input" rows={3} value={form.desc_en} onChange={e => set('desc_en', e.target.value)} placeholder="English description (optional)" />
          </div>
          <div className="kc-field">
            <label>分类</label>
            <select className="profile-input" value={form.category} onChange={e => set('category', e.target.value)}>
              {['景点导览', '建筑艺术', '文物珍藏', '历史故事', '文化典故'].map(c => <option key={c}>{c}</option>)}
            </select>
          </div>
          <div className="kc-field">
            <label>年代 / 时间</label>
            <input className="profile-input" value={form.era} onChange={e => set('era', e.target.value)} placeholder="如：明永乐十八年（1420年）" />
          </div>
          <div className="kc-field">
            <label>地点</label>
            <input className="profile-input" value={form.location} onChange={e => set('location', e.target.value)} placeholder="如：北京故宫" />
          </div>
          <div className="kc-field kc-image-field">
            <label>卡片图片（选填）</label>
            <button
              type="button"
              className={`kc-image-upload${imagePreview ? ' has-image' : ''}`}
              onClick={() => imageInputRef.current?.click()}
              disabled={busy}
              aria-label={imagePreview ? '更换卡片图片' : '上传卡片图片'}
            >
              {imagePreview ? (
                <img src={imagePreview} alt="卡片图片预览" />
              ) : (
                <span className="kc-image-upload-empty">
                  <ImagePlus size={26} />
                  <strong>选择卡片图片</strong>
                  <small>支持 JPG、PNG、WebP，上传前可裁剪</small>
                </span>
              )}
              {imagePreview && <span className="kc-image-upload-mask"><ImagePlus size={18} />更换图片</span>}
            </button>
            <input
              ref={imageInputRef}
              type="file"
              accept="image/jpeg,image/png,image/webp"
              hidden
              onChange={handleImageChange}
            />
            {imagePreview && (
              <button type="button" className="kc-image-remove" onClick={handleRemoveImage} disabled={busy}>
                移除图片
              </button>
            )}
          </div>
          <div className="kc-edit-actions">
            <button className="kc-draft-btn" onClick={() => handleSave('draft')} disabled={busy}>保存草稿</button>
            <button className="primary-button green" style={{ flex: 1 }} onClick={() => handleSave('published')} disabled={busy}>
              {busy ? '保存中…' : '发布卡片'}
            </button>
          </div>
        </div>
        {cropSrc && (
          <RoomCoverCropModal
            src={cropSrc}
            title="裁剪卡片图片"
            onConfirm={handleCropConfirm}
            onCancel={handleCropCancel}
          />
        )}
      </div>
    </div>,
    appRoot
  );
}

// ─── G09 独立页面版（路由用） ─────────────────────────
export function KnowledgeCardEdit({ go }: Props) {
  return <KnowledgeCardLib go={go} />;
}

// ─── 知识卡片详情（游客/导游共用） ───────────────────
export function KnowledgeCardDetail({ go }: Props) {
  const { profile } = useAuth();
  const [card, setCard] = useState<KnowledgeCard | null>(null);
  const backTarget = profile?.role === 'guide' ? 'kc-library' : 'listening';

  useEffect(() => {
    // 从 sessionStorage 读取待预览的卡片
    const raw = sessionStorage.getItem('preview_card');
    if (raw) { try { setCard(JSON.parse(raw)); } catch { /* ignore */ } }
  }, []);

  const langMode = (profile as unknown as Record<string,unknown>)?.default_language ?? 'cn';

  return (
    <div className="screen padded-screen kc-detail-screen">
      <div className="mini-header">
        <button className="back-button" onClick={() => go(backTarget)} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>景区介绍</strong>
        <span />
      </div>

      {card ? (
        <article className="kc-detail-article">
          {card.image_url
            ? <img src={card.image_url} className="kc-detail-img" alt={card.title_cn} />
            : <div className="kc-detail-img-placeholder"><Landmark size={40} /></div>
          }
          <h1 className="kc-detail-title-cn">{card.title_cn}</h1>
          {card.title_en && <h2 className="kc-detail-title-en">{card.title_en}</h2>}
          <div className="kc-detail-tags">
            {card.category && <span><Landmark size={11} />{card.category}</span>}
            {card.era && <span><CalendarDays size={11} />{card.era}</span>}
            {card.location && <span><Crown size={11} />{card.location}</span>}
          </div>
          <hr />
          {(langMode === 'cn' || langMode === 'bilingual') && (
            <p className="kc-detail-cn">{card.desc_cn}</p>
          )}
          {(langMode === 'en' || langMode === 'bilingual') && card.desc_en && (
            <>
              <hr className="dashed" />
              <p className="kc-detail-en">{card.desc_en}</p>
            </>
          )}
          <button className="primary-button green" style={{ marginTop: 24 }} onClick={() => go(backTarget)}>返回</button>
        </article>
      ) : (
        <div className="empty-state">
          <Landmark size={40} className="empty-icon" />
          <p className="empty-title">卡片加载中</p>
        </div>
      )}
    </div>
  );
}

// ─── G11 讲解结束结果 ─────────────────────────────────
export function EndResult({ go }: Props) {
  const { currentRoom } = useAuth();

  const stats = [
    { label: '讲解时长', value: currentRoom?.actual_duration ? `${currentRoom.actual_duration} 分钟` : '—', icon: Clock3 },
    { label: '在线人数', value: `${currentRoom?.online_count ?? 0} 人`, icon: UsersRound },
  ];

  return (
    <div className="screen padded-screen end-result-screen">
      <div className="end-result-checkmark">
        <CheckCircle2 size={64} className="end-check-icon" />
      </div>
      <h2 className="end-result-title">讲解已结束</h2>
      <p className="end-result-sub">感谢您的精彩讲解！字幕记录与相册已为游客保留。</p>

      <div className="end-stats-grid">
        {stats.map(s => (
          <div key={s.label} className="end-stat-card">
            <s.icon size={22} className="end-stat-icon" />
            <b>{s.value}</b>
            <small>{s.label}</small>
          </div>
        ))}
      </div>

      <button className="primary-button green" onClick={() => go('records')}>
        <History size={16} />查看讲解记录
      </button>
      <button className="text-button" style={{ marginTop: 12 }} onClick={() => go('guide-home')}>
        返回房间首页
      </button>
    </div>
  );
}
