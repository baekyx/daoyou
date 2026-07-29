import React, { useEffect, useState, useCallback, useRef } from 'react';
import { Landmark, Crown, Star, CalendarDays, Copy, Search, Send, Edit2, SkipForward, CheckCircle2, RotateCcw, ChevronUp } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { fetchKcPageForPush, fetchPushedKcIds, pushKcCard, fetchKcByPush } from '@/api/cards';
import { fetchSubtitlesSafe } from '@/api/subtitles';
import { toggleFavorite, fetchFavorites } from '@/api/photos';
import type { KnowledgeCard, Subtitle, Favorite } from '@/types/types';
import { toast } from 'sonner';
import { KnowledgeCardEditModal } from '@/pages/guide/GuideExtra';

interface Props { go: (id: string) => void }

const CATEGORIES = ['全部', '景点导览', '建筑艺术', '文物珍藏', '历史故事', '文化典故'];
// PAGE_SIZE 保留给本文件其他地方引用（CardAlert 等），推送列表改用 fetchKcPageForPush

// ─── 景区卡片共用外观骨架（纯视觉，不含数据请求和业务状态） ─────────────────
interface ScenicCardShellProps {
  imageUrl?: string | null;
  titleCn: string;
  titleEn?: string | null;
  descCn?: string | null;
  category?: string | null;
  /** 已推送态：封面置灰 + 已推送 badge */
  isPushed?: boolean;
  /** footer 左侧额外标签节点（如发布状态） */
  statusTag?: React.ReactNode;
  /** footer 右侧操作按钮组 */
  footerActions: React.ReactNode;
  /** 额外 className，附加到外层卡片容器 */
  className?: string;
  /** 封面上额外浮层（如错误提示区） */
  coverOverlay?: React.ReactNode;
}

export function ScenicCardShell({
  imageUrl, titleCn, titleEn, descCn, category,
  isPushed, statusTag, footerActions, className, coverOverlay,
}: ScenicCardShellProps) {
  return (
    <div className={`scenic-card${className ? ` ${className}` : ''}`}>
      {/* 封面 2:1 */}
      <div className="scenic-card__cover">
        {imageUrl
          ? <img src={imageUrl} alt={titleCn} className={`scenic-card__img${isPushed ? ' scenic-card__img--gray' : ''}`} />
          : <div className={`scenic-card__placeholder${isPushed ? ' scenic-card__img--gray' : ''}`}><Landmark size={28} /></div>
        }
        {isPushed && <span className="scenic-card__pushed-badge">已推送</span>}
        {coverOverlay}
      </div>
      {/* 正文：中文标题 → 英文标题（可选）→ 中文简介 */}
      <div className="scenic-card__body">
        <h3 className="scenic-card__title">{titleCn}</h3>
        {titleEn && <p className="scenic-card__title-en">{titleEn}</p>}
        {descCn && <p className="scenic-card__desc">{descCn.slice(0, 60)}…</p>}
      </div>
      {/* footer：左侧分类（+额外标签）/ 右侧操作按钮组 */}
      <div className="scenic-card__footer">
        <div className="scenic-card__tags">
          {category && <span className="scenic-card__cat">{category}</span>}
          {statusTag}
        </div>
        <div className="scenic-card__actions">{footerActions}</div>
      </div>
    </div>
  );
}

/** sessionStorage key：待查看的 room_card_id（仅存 ID，不存整张卡片对象） */
export const ROOM_CARD_ID_KEY = 'room_card_id';
/** sessionStorage key：room-card-detail 返回目标 */
export const ROOM_CARD_RETURN_KEY = 'room_card_return_to';
/** sessionStorage key：当前推送的 kc_card_id（Task2，仅存 ID） */
export const ACTIVE_KC_ID_KEY = 'active_kc_card_id';

// ─── 景区卡片强提醒（游客收到推送时显示） ──
export function CardAlert({ go }: Props) {
  const { currentRoom } = useAuth();
  const [kc, setKc] = useState<KnowledgeCard | null>(null);

  useEffect(() => {
    // Task2：从 sessionStorage 读取 kc_card_id，再通过 RPC 加载最新 KC 内容
    const kcId = sessionStorage.getItem(ACTIVE_KC_ID_KEY);
    if (kcId && currentRoom?.id) {
      fetchKcByPush(currentRoom.id, kcId).then(card => {
        if (card) setKc(card);
      });
    }
  }, [currentRoom?.id]);

  const title = kc?.title_cn ?? '景区卡片';
  const description = kc?.desc_cn ?? '';
  const isDeleted = kc !== null && kc.deleted_at !== null;

  const handleViewDetail = () => {
    // 存 kc_card_id 供详情页使用（不再存整张对象）
    const kcId = sessionStorage.getItem(ACTIVE_KC_ID_KEY);
    if (kcId) sessionStorage.setItem(ACTIVE_KC_ID_KEY, kcId);
    go('room-card-detail');
  };

  return (
    <div className="screen padded-screen">
      <div className="dimmed-listening">
        <div className="mini-header">
          <span />
          <strong>收听中</strong>
          <span />
        </div>
        <div className="listener-host">
          <div className="avatar" />
          <h2>导游正在讲解</h2>
        </div>
        <div className="subtitle-card">
          <p className="zh">各位游客，欢迎来到故宫紫禁城……</p>
        </div>
      </div>

      <div className="knowledge-modal card-alert-sheet">
        <span className="push-badge">导游刚刚推送</span>
        <h2>{title}</h2>
        {isDeleted ? (
          <p style={{ color: 'var(--muted)', textAlign: 'center', padding: '16px 0' }}>卡片已下架</p>
        ) : (
          <>
            {kc?.image_url
              ? <img className="knowledge-card-image" src={kc.image_url} alt={title} />
              : <div className="scenic-art" />}
            <p className="knowledge-card-description">{description}</p>
            <button className="primary-button green" onClick={handleViewDetail}>查看卡片</button>
          </>
        )}
        <button className="text-button" onClick={() => go('listening')}>稍后查看</button>
        <div className="audio-continues"><span style={{ fontSize: 12, color: 'var(--muted)' }}>讲解音频将继续播放</span></div>
      </div>
    </div>
  );
}

// ─── 导游卡片推送选择页（无限滚动，单列，三操作按钮，已推送置底） ───────────
export function CardLibrary({ go }: Props) {
  const { user, currentRoom } = useAuth();

  // 搜索 / 分类
  const [category, setCategory] = useState('全部');
  const [search, setSearch] = useState('');
  const [searchInput, setSearchInput] = useState('');

  // 分类栏横向滚动渐隐提示：canScrollRight=true 时显示右侧渐隐
  const filterScrollRef = useRef<HTMLDivElement>(null);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // 检查分类栏是否可向右滚动（1px 容差防浮点误差）
  const checkFilterScroll = useCallback(() => {
    const el = filterScrollRef.current;
    if (!el) return;
    setCanScrollRight(el.scrollWidth - el.scrollLeft - el.clientWidth > 1);
  }, []);

  useEffect(() => {
    const el = filterScrollRef.current;
    if (!el) return;
    checkFilterScroll();
    el.addEventListener('scroll', checkFilterScroll, { passive: true });
    const ro = new ResizeObserver(checkFilterScroll);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', checkFilterScroll); ro.disconnect(); };
  }, [checkFilterScroll]);

  // 本页内联编辑：目标卡片（null = 不显示抽屉）
  const [editTarget, setEditTarget] = useState<KnowledgeCard | null>(null);

  // 已加载卡片全集（权威来源）：仅追加、id 去重；category/search/room 变化时重置
  const [loadedItems, setLoadedItems] = useState<KnowledgeCard[]>([]);
  // 已推送 id 集合（权威来源：DB card_pushes.kc_card_id，本次推送成功后追加）
  const [pushedKcIds, setPushedKcIds] = useState<Set<string>>(new Set());
  // 本次会话内跳过的 id（仅内存，刷新/重进恢复，不写 DB）
  const [skipIds, setSkipIds] = useState<Set<string>>(new Set());
  // 已跳过卡片快照 Map<id, card>：切换分类/搜索后仍能显示其他分类的跳过卡片
  const [skipMap, setSkipMap] = useState<Map<string, KnowledgeCard>>(new Map());

  // 分页游标
  const cursorRef = useRef<{ createdAt: string; id: string } | undefined>(undefined);
  const hasMoreRef = useRef(true);
  const loadingRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [allLoaded, setAllLoaded] = useState(false);

  // 推送中的 id
  const [pushBusy, setPushBusy] = useState<string | null>(null);
  // 推送失败的 id → 错误消息
  const [pushErrors, setPushErrors] = useState<Map<string, string>>(new Map());

  // 底部哨兵 ref（IntersectionObserver 触发加载）
  const sentinelRef = useRef<HTMLDivElement>(null);

  // ── 重置：筛选变化/房间切换时清空分页和列表，skipIds 跨筛选持续保留 ──
  const reset = useCallback(() => {
    setLoadedItems([]);
    setPushedKcIds(new Set());
    // ⚠️ skipIds 不在此清空：切换搜索词/分类后跳过记录仍保留
    cursorRef.current = undefined;
    hasMoreRef.current = true;
    loadingRef.current = false;
    setLoading(false);
    setLoadError(false);
    setAllLoaded(false);
  }, []);

  // ── 加载一批（追加到全集，不重置） ──
  const loadBatch = useCallback(async (
    cat: string,
    q: string,
    cursor: { createdAt: string; id: string } | undefined,
    currentPushedIds: Set<string>,
  ) => {
    if (!currentRoom || loadingRef.current || !hasMoreRef.current) return;
    loadingRef.current = true;
    setLoading(true);
    setLoadError(false);

    let cards: KnowledgeCard[] = [];
    let hasMore = false;
    try {
      const result = await fetchKcPageForPush(cursor, cat, q);
      cards = result.cards;
      hasMore = result.hasMore;
      console.log(`[CardLibrary] 加载 ${cards.length} 张卡片，pushedIds=${currentPushedIds.size}，hasMore=${hasMore}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[CardLibrary] fetchKcPageForPush 失败:', msg);
      setLoadError(true);
      loadingRef.current = false;
      setLoading(false);
      return; // 保留已有全集，不清空，等用户重试
    }

    if (cards.length > 0) {
      const last = cards[cards.length - 1];
      cursorRef.current = { createdAt: last.created_at, id: last.id };

      // 追加到全集（id 去重）
      setLoadedItems(prev => {
        const existingIds = new Set(prev.map(c => c.id));
        const fresh = cards.filter(c => !existingIds.has(c.id));
        return fresh.length === 0 ? prev : [...prev, ...fresh];
      });
    }

    hasMoreRef.current = hasMore;
    if (!hasMore) setAllLoaded(true);
    loadingRef.current = false;
    setLoading(false);
  }, [currentRoom?.id]);

  // ── 初始加载（category/search/room 变化时重置后首批） ──
  useEffect(() => {
    if (!currentRoom) return;
    reset();
    // fetchPushedKcIds 失败时降级空 Set，保证卡片查询链不中断
    fetchPushedKcIds(currentRoom.id).then(ids => {
      console.log(`[CardLibrary] pushedKcIds 加载完成，数量=${ids.size}`);
      setPushedKcIds(ids);
      loadBatch(category, search, undefined, ids);
    });
  }, [category, search, currentRoom?.id]);

  // ── IntersectionObserver：哨兵进入视口时触发下一批 ──
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(entries => {
      if (entries[0].isIntersecting && !loadingRef.current && hasMoreRef.current) {
        setPushedKcIds(prev => {
          loadBatch(category, search, cursorRef.current, prev);
          return prev;
        });
      }
    }, { rootMargin: '120px' });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [category, search, loadBatch]);

  // ── 跳过：仅加入内存 Set + 写卡片快照 ──
  const handleSkip = useCallback((kc: KnowledgeCard) => {
    setSkipIds(prev => new Set([...prev, kc.id]));
    setSkipMap(prev => { const m = new Map(prev); m.set(kc.id, kc); return m; });
  }, []);

  // ── 编辑：在本页打开内联 Modal，不跳转路由 ──
  const handleEdit = useCallback((kc: KnowledgeCard) => {
    setEditTarget(kc);
  }, []);

  // ── 编辑保存成功回调：按 card.id 局部更新全集，确保 UPDATE 而非 INSERT ──
  const handleEditSaved = useCallback(async (updatedCard: KnowledgeCard) => {
    setLoadedItems(prev =>
      prev.map(c => c.id === updatedCard.id ? { ...c, ...updatedCard } : c)
    );
    setEditTarget(null);
  }, []);

  // ── 推送 ──
  const handlePush = useCallback(async (kc: KnowledgeCard) => {
    if (!currentRoom || !user) return;
    if (kc.deleted_at) { toast.error('该卡片已下架，无法推送'); return; }
    // 前端 Set 已标记已推送：直接静默返回，不弹 toast
    if (pushedKcIds.has(kc.id)) return;
    setPushBusy(kc.id);
    setPushErrors(prev => { const m = new Map(prev); m.delete(kc.id); return m; });

    const { push, error } = await pushKcCard(currentRoom.id, kc.id, user.id);
    setPushBusy(null);

    // 幂等判断：PostgreSQL 唯一键冲突（23505）或后端消息含"already"视为已推送成功
    const isIdempotent = error && (
      error.includes('23505') ||
      error.toLowerCase().includes('already') ||
      error.toLowerCase().includes('duplicate')
    );

    if (error && !push && !isIdempotent) {
      // 真实网络/权限错误：保留原位，显示可重试错误
      setPushErrors(prev => new Map([...prev, [kc.id, error]]));
      toast.error(`推送失败：${error}`);
      return;
    }

    // 成功（含幂等重复）：更新 pushedKcIds + 清理 skip 快照；全集不变，派生分区自动重算
    setPushedKcIds(prev => {
      const next = new Set([...prev, kc.id]);
      console.log(`[CardLibrary] 推送成功 ${kc.id}，pushedKcIds.size=${next.size}`);
      return next;
    });
    setSkipIds(prev => { const s = new Set(prev); s.delete(kc.id); return s; });
    setSkipMap(prev => { const m = new Map(prev); m.delete(kc.id); return m; });
    if (!isIdempotent) toast.success(`「${kc.title_cn}」已推送给游客`);
  }, [currentRoom?.id, user?.id, pushedKcIds]);

  // ── 重试加载 ──
  const handleRetry = () => {
    hasMoreRef.current = true;
    setPushedKcIds(prev => {
      loadBatch(category, search, cursorRef.current, prev);
      return prev;
    });
  };

  // ── 从全集派生三个分区（纯计算，无异步竞态） ──
  // pushedItems：全集中 pushedKcIds 包含的卡片（保持加载顺序）
  const pushedItems = loadedItems.filter(c => pushedKcIds.has(c.id));
  // unpushedItems：全集中未推送的卡片
  const unpushedItems = loadedItems.filter(c => !pushedKcIds.has(c.id));
  // visibleUnpushed：未推送中排除已跳过
  const visibleUnpushed = unpushedItems.filter(c => !skipIds.has(c.id));

  // 开发日志：分区数量
  console.log(`[CardLibrary] 派生分区: loaded=${loadedItems.length} pushed=${pushedItems.length} unpushed=${unpushedItems.length} visible=${visibleUnpushed.length}`);

  // 已跳过卡片列表：从快照 Map 取出全部，不受当前筛选限制
  const skippedCards = Array.from(skipMap.values());

  // ── 已跳过内联展开开关：手势/点击触发，筛选切换时收起但不清 skipMap ──
  const [showSkippedInline, setShowSkippedInline] = useState(false);

  // 筛选/搜索切换时收起已跳过区（skipMap 保留）
  useEffect(() => { setShowSkippedInline(false); }, [category, search]);

  // 跳过数量变 0 时自动收起
  useEffect(() => {
    if (skipMap.size === 0) setShowSkippedInline(false);
  }, [skipMap.size]);

  // ── 恢复跳过：从 skipIds + skipMap 同时移除 ──
  const handleRestore = useCallback((id: string) => {
    setSkipIds(prev => { const s = new Set(prev); s.delete(id); return s; });
    setSkipMap(prev => { const m = new Map(prev); m.delete(id); return m; });
  }, []);

  // ── 列表容器 ref：用于绑定上拉/滚轮手势 ──
  const listRef = useRef<HTMLDivElement>(null);

  // ── 手势监听：在列表已到底时，继续上拉 ≥40px 或继续向下滚轮展开已跳过区 ──
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;

    // 判断是否已滚动到底（含 2px 容差）
    const isAtBottom = () =>
      el.scrollHeight - el.scrollTop - el.clientHeight < 2;

    let touchStartY = 0;
    let atBottomOnTouchStart = false;

    const onTouchStart = (e: TouchEvent) => {
      touchStartY = e.touches[0].clientY;
      atBottomOnTouchStart = isAtBottom();
    };
    const onTouchEnd = (e: TouchEvent) => {
      if (!atBottomOnTouchStart) return;
      const dy = touchStartY - e.changedTouches[0].clientY; // 正值 = 向上滑
      if (dy >= 40 && skipMap.size > 0 && !showSkippedInline) {
        setShowSkippedInline(true);
      }
    };
    // 桌面端：在列表底部向下滚动（deltaY>0）时展开
    const onWheel = (e: WheelEvent) => {
      if (isAtBottom() && e.deltaY > 0 && skipMap.size > 0 && !showSkippedInline) {
        setShowSkippedInline(true);
      }
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('wheel', onWheel, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('wheel', onWheel);
    };
  // showSkippedInline/skipMap.size 变化时重绑，保证闭包拿到最新值
  }, [showSkippedInline, skipMap.size]);

  return (
    <div className="screen padded-screen">
      <div className="mini-header">
        <button className="back-button" onClick={() => go('guide-live')} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>选择卡片推送</strong>
        <span />
      </div>

      {/* 搜索栏 */}
      <div className="kc-search-wrap" style={{ margin: '8px 0' }}>
        <Search size={14} />
        <input
          placeholder="搜索卡片名称…"
          value={searchInput}
          onChange={e => setSearchInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') setSearch(searchInput); }}
          onBlur={() => setSearch(searchInput)}
        />
      </div>

      {/* 分类过滤 — wrapper 提供 relative 定位，右侧渐隐层叠在其上 */}
      <div className={`clp-filters-wrap${canScrollRight ? ' has-fade' : ''}`}>
        <div className="clp-filters" ref={filterScrollRef}>
          {CATEGORIES.map(c => (
            <button key={c} className={category === c ? 'active' : ''} onClick={() => setCategory(c)}>{c}</button>
          ))}
        </div>
      </div>

      {/* 卡片列表 */}
      <div className="clp-list" ref={listRef}>

        {/* 未推送卡片 */}
        {visibleUnpushed.map(kc => {
          const alreadyPushed = pushedKcIds.has(kc.id);
          return (
          <ScenicCardShell
            key={kc.id}
            imageUrl={kc.image_url}
            titleCn={kc.title_cn}
            titleEn={kc.title_en}
            descCn={kc.desc_cn}
            category={kc.category}
            isPushed={alreadyPushed}
            className={alreadyPushed ? 'scenic-card--pushed' : undefined}
            coverOverlay={
              !alreadyPushed && pushErrors.has(kc.id) ? (
                <div className="scenic-card__push-error">
                  {pushErrors.get(kc.id)}
                  <button className="scenic-card__retry-link" onClick={() => handlePush(kc)}>重试</button>
                </div>
              ) : undefined
            }
            footerActions={
              <>
                <button className="sc-btn sc-btn--edit" onClick={() => handleEdit(kc)} aria-label="编辑">
                  <Edit2 size={12} />编辑
                </button>
                {/* 已推送时跳过按钮保留位置但置灰禁用，维持三列对齐 */}
                {alreadyPushed
                  ? <button className="sc-btn sc-btn--skip-disabled" disabled aria-disabled="true" aria-label="跳过（不可用）">
                      <SkipForward size={12} />跳过
                    </button>
                  : <button className="sc-btn sc-btn--skip" onClick={() => handleSkip(kc)} aria-label="跳过">
                      <SkipForward size={12} />跳过
                    </button>
                }
                {alreadyPushed
                  ? <button className="sc-btn sc-btn--done" disabled aria-label="已推送" aria-disabled="true">
                      <CheckCircle2 size={12} />已推送
                    </button>
                  : <button
                      className={`sc-btn sc-btn--push${pushBusy === kc.id ? ' sc-btn--busy' : ''}`}
                      onClick={() => handlePush(kc)}
                      disabled={pushBusy === kc.id}
                      aria-label="推送"
                    >
                      <Send size={12} />{pushBusy === kc.id ? '推送中' : '推送'}
                    </button>
                }
              </>
            }
          />
          );
        })}

        {/* 空状态：知识卡片查询成功且已完成加载，但全集确实为 0（与分区无关） */}
        {!loading && !loadError && loadedItems.length === 0 && allLoaded && (
          <div className="empty-state">
            <Landmark size={40} className="empty-icon" />
            <p className="empty-title">暂无可用卡片</p>
            <small className="empty-desc">
              {search ? '未找到匹配卡片，请换个关键词' : '在「我的 → 景区知识卡片」中新建并发布卡片'}
            </small>
          </div>
        )}

        {/* 已推送分组（置底） */}
        {pushedItems.length > 0 && (
          <>
            <div className="clp-section-divider">
              <span>已推送 · {pushedItems.length} 张</span>
            </div>
            {pushedItems.map(kc => (
              <ScenicCardShell
                key={kc.id}
                imageUrl={kc.image_url}
                titleCn={kc.title_cn}
                titleEn={kc.title_en}
                descCn={kc.desc_cn}
                category={kc.category}
                isPushed
                className="scenic-card--pushed"
                footerActions={
                  <>
                    <button className="sc-btn sc-btn--edit" onClick={() => handleEdit(kc)} aria-label="编辑">
                      <Edit2 size={12} />编辑
                    </button>
                    {/* 跳过按钮保留位置但置灰禁用，维持三列对齐 */}
                    <button className="sc-btn sc-btn--skip-disabled" disabled aria-disabled="true" aria-label="跳过（不可用）">
                      <SkipForward size={12} />跳过
                    </button>
                    <button className="sc-btn sc-btn--done" disabled aria-label="已推送" aria-disabled="true">
                      <CheckCircle2 size={12} />已推送
                    </button>
                  </>
                }
              />
            ))}
          </>
        )}

        {/* 底部哨兵（IntersectionObserver 触发点） */}
        <div ref={sentinelRef} className="clp-sentinel" />

        {/* 加载中指示 */}
        {loading && (
          <p className="clp-loading-hint">加载中…</p>
        )}

        {/* 加载失败 */}
        {loadError && !loading && (
          <div className="clp-error-row">
            <span>加载失败</span>
            <button className="clp-retry-link" onClick={handleRetry}>重试</button>
          </div>
        )}

        {/* 无更多 */}
        {allLoaded && !loading && (visibleUnpushed.length > 0 || pushedItems.length > 0) && (
          <p className="clp-end-hint">— 没有更多卡片 —</p>
        )}

        {/* ── 已跳过内联区：普通列表末尾，不 fixed/sticky ── */}
        {skippedCards.length > 0 && (
          <>
            {/* 提示条：未展开时显示，点击也可展开（无障碍兜底） */}
            {!showSkippedInline && (
              <button
                className="clp-skipped-hint"
                onClick={() => setShowSkippedInline(true)}
                aria-expanded={false}
                aria-label={`上拉查看已跳过的 ${skippedCards.length} 张卡片`}
              >
                <ChevronUp size={14} className="clp-skipped-hint__icon" aria-hidden />
                上拉查看已跳过 {skippedCards.length} 张
              </button>
            )}

            {/* 展开后：标题 + 全部已跳过卡片 */}
            {showSkippedInline && (
              <>
                <div className="clp-section-divider">
                  <span>已跳过 · {skippedCards.length} 张</span>
                </div>
                {skippedCards.map(kc => {
                  const alreadyPushed = pushedKcIds.has(kc.id);
                  return (
                  <ScenicCardShell
                    key={kc.id}
                    imageUrl={kc.image_url}
                    titleCn={kc.title_cn}
                    titleEn={kc.title_en}
                    descCn={kc.desc_cn}
                    category={kc.category}
                    isPushed={alreadyPushed}
                    className={alreadyPushed ? 'scenic-card--pushed' : 'scenic-card--skipped'}
                    footerActions={
                      <>
                        <button className="sc-btn sc-btn--edit" onClick={() => handleEdit(kc)} aria-label="编辑">
                          <Edit2 size={12} />编辑
                        </button>
                        {alreadyPushed
                          ? <button className="sc-btn sc-btn--skip-disabled" disabled aria-disabled="true" aria-label="跳过（不可用）">
                              <SkipForward size={12} />跳过
                            </button>
                          : <button className="sc-btn sc-btn--restore" onClick={() => handleRestore(kc.id)} aria-label="恢复">
                              <RotateCcw size={12} />恢复
                            </button>
                        }
                        {alreadyPushed
                          ? <button className="sc-btn sc-btn--done" disabled aria-label="已推送" aria-disabled="true">
                              <CheckCircle2 size={12} />已推送
                            </button>
                          : <button
                              className={`sc-btn sc-btn--push${pushBusy === kc.id ? ' sc-btn--busy' : ''}`}
                              onClick={() => handlePush(kc)}
                              disabled={pushBusy === kc.id}
                              aria-label="推送"
                            >
                              <Send size={12} />{pushBusy === kc.id ? '推送中' : '推送'}
                            </button>
                        }
                      </>
                    }
                  />
                  );
                })}
              </>
            )}
          </>
        )}

        <div className="clp-bottom-space" />
      </div>

      {/* 内联编辑抽屉：复用 KnowledgeCardEditModal，不跳路由 */}
      {editTarget !== null && user && (
        <KnowledgeCardEditModal
          card={editTarget}
          onClose={() => setEditTarget(null)}
          onSaved={(updated) => {
            if (updated) handleEditSaved(updated);
            else setEditTarget(null);
          }}
          userId={user.id}
        />
      )}
    </div>
  );
}

// ─── 卡片详情（游客/导游共用）——Task2：按 kc_card_id 通过 RPC 精确加载 KC ──
// 进入条件：sessionStorage.active_kc_card_id 有值
// 返回路径：sessionStorage.room_card_return_to（默认 listening）
export function RoomCardDetail({ go }: Props) {
  const { currentRoom, subtitlePrefs } = useAuth();
  const [kc, setKc] = useState<KnowledgeCard | null>(null);
  const [loadState, setLoadState] = useState<'loading' | 'ok' | 'deleted' | 'not-found'>('loading');
  const returnTo = sessionStorage.getItem(ROOM_CARD_RETURN_KEY) ?? 'listening';

  useEffect(() => {
    const kcId = sessionStorage.getItem(ACTIVE_KC_ID_KEY);
    if (!kcId || !currentRoom?.id) { setLoadState('not-found'); return; }
    fetchKcByPush(currentRoom.id, kcId).then(card => {
      if (!card) { setLoadState('not-found'); return; }
      setKc(card);
      // 软删除卡片显示"已下架"，不换成别的卡片
      setLoadState(card.deleted_at ? 'deleted' : 'ok');
    }).catch(() => setLoadState('not-found'));
  }, [currentRoom?.id]);

  const handleBack = () => {
    sessionStorage.removeItem(ACTIVE_KC_ID_KEY);
    sessionStorage.removeItem(ROOM_CARD_RETURN_KEY);
    go(returnTo);
  };

  if (loadState === 'loading') {
    return (
      <div className="screen padded-screen">
        <div className="mini-header">
          <button className="back-button" onClick={handleBack} aria-label="返回"><span className="back-chevron" /></button>
          <strong>卡片详情</strong><span />
        </div>
        <p style={{ textAlign: 'center', color: 'var(--muted)', padding: '40px 0' }}>加载中…</p>
      </div>
    );
  }

  if (loadState === 'not-found') {
    return (
      <div className="screen padded-screen">
        <div className="mini-header">
          <button className="back-button" onClick={handleBack} aria-label="返回"><span className="back-chevron" /></button>
          <strong>卡片详情</strong><span />
        </div>
        <div className="empty-state" style={{ marginTop: 48 }}>
          <Landmark size={40} className="empty-icon" />
          <p className="empty-title">找不到该卡片</p>
          <small className="empty-desc">请返回重试，或联系导游重新推送</small>
          <button className="empty-action-btn" onClick={handleBack}>返回</button>
        </div>
      </div>
    );
  }

  if (loadState === 'deleted') {
    return (
      <div className="screen padded-screen">
        <div className="mini-header">
          <button className="back-button" onClick={handleBack} aria-label="返回"><span className="back-chevron" /></button>
          <strong>卡片详情</strong><span />
        </div>
        <div className="empty-state" style={{ marginTop: 48 }}>
          <Landmark size={40} className="empty-icon" />
          <p className="empty-title">卡片已下架</p>
          <small className="empty-desc">该卡片已被导游下架，历史推送记录仍保留</small>
          <button className="empty-action-btn" onClick={handleBack}>返回</button>
        </div>
      </div>
    );
  }

  const showCn = subtitlePrefs.mode !== 'en';
  const showEn = subtitlePrefs.mode !== 'cn';
  const titleCn = kc?.title_cn ?? '景区卡片';
  const titleEn = kc?.title_en;
  const contentCn = kc?.desc_cn ?? '';
  const contentEn = kc?.desc_en;

  return (
    <div className="screen padded-screen">
      <div className="mini-header">
        <button className="back-button" onClick={handleBack} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>景区介绍</strong>
        <span />
      </div>
      <article>
        {showCn && <h1>{titleCn}</h1>}
        {showEn && titleEn && <h3>{titleEn}</h3>}
        <div className="tag-row">
          {kc?.category && <span><Landmark />{kc.category}</span>}
          {kc?.era && <span><CalendarDays />{kc.era}</span>}
          {kc?.location && <span><Crown />{kc.location}</span>}
        </div>
        <hr />
        {kc?.image_url
          ? <img className="knowledge-card-image" src={kc.image_url} alt={titleCn} />
          : <div className="scenic-art" style={{ height: 180, marginBottom: 16 }} />}
        {showCn && contentCn && <p className="detail-zh">{contentCn}</p>}
        {showCn && showEn && contentCn && contentEn && <hr className="dashed" />}
        {showEn && contentEn && <p className="detail-en">{contentEn}</p>}
        <div className="built-note"><CalendarDays />导游推送</div>
        <button className="primary-button green" onClick={handleBack}>返回</button>
      </article>
    </div>
  );
}

// ─── KC 原卡详情（仅 knowledge_cards，不读 room_cards） ──
export function CardDetail({ go }: Props) {
  const { profile, subtitlePrefs } = useAuth();
  const [card, setCard] = useState<KnowledgeCard | null>(null);
  const backTarget = profile?.role === 'guide' ? 'kc-library' : 'listening';

  useEffect(() => {
    const raw = sessionStorage.getItem('preview_card');
    if (raw) { try { setCard(JSON.parse(raw)); } catch { /* ignore */ } }
  }, []);

  const showCn = subtitlePrefs.mode !== 'en';
  const showEn = subtitlePrefs.mode !== 'cn';
  const titleCn = card?.title_cn ?? '景区卡片';
  const titleEn = card?.title_en;
  const contentCn = card?.desc_cn ?? '';
  const contentEn = card?.desc_en;

  return (
    <div className="screen padded-screen">
      <div className="mini-header">
        <button className="back-button" onClick={() => go(backTarget)} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>KC 原卡预览</strong>
        <span />
      </div>

      <article>
        {showCn && <h1>{titleCn}</h1>}
        {showEn && titleEn && <h3>{titleEn}</h3>}
        <div className="tag-row">
          {card?.category && <span><Landmark />{card.category}</span>}
          {card?.era && <span><CalendarDays />{card.era}</span>}
          {card?.location && <span><Crown />{card.location}</span>}
        </div>
        <hr />
        {card?.image_url
          ? <img className="knowledge-card-image" src={card.image_url} alt={titleCn} />
          : <div className="scenic-art" style={{ height: 180, marginBottom: 16 }} />}
        {showCn && contentCn && <p className="detail-zh">{contentCn}</p>}
        {showCn && showEn && contentCn && contentEn && <hr className="dashed" />}
        {showEn && contentEn && <p className="detail-en">{contentEn}</p>}
        <div className="built-note"><CalendarDays />我的 KC 原始素材</div>
        <button className="primary-button green" onClick={() => go(backTarget)}>返回</button>
      </article>
    </div>
  );
}



// ─── 字幕历史 ──────────────────────────────────────────
export function SubtitleHistory({ go }: Props) {
  const { user, currentRoom } = useAuth();
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [favIds, setFavIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState('');
  const [fontSize, setFontSize] = useState<'small' | 'medium' | 'large'>('medium');

  useEffect(() => {
    if (!currentRoom) return;
    fetchSubtitlesSafe(currentRoom.id, 100).then(subs => setSubtitles(subs.reverse()));
    if (user) {
      fetchFavorites(user.id).then(favs => {
        setFavIds(new Set(favs.filter(f => f.target_type === 'subtitle').map(f => f.target_id)));
      });
    }
  }, [currentRoom?.id, user?.id]);

  const filtered = search
    ? subtitles.filter(s => s.content_cn.includes(search) || (s.content_en ?? '').includes(search))
    : subtitles;

  const fontSizeMap = { small: 13, medium: 15, large: 17 };

  const handleFav = async (s: Subtitle) => {
    if (!user) return;
    const isFav = favIds.has(s.id);
    await toggleFavorite(user.id, 'subtitle', s.id, isFav);
    setFavIds(prev => {
      const next = new Set(prev);
      if (isFav) next.delete(s.id); else next.add(s.id);
      return next;
    });
  };

  return (
    <div className="screen sh-screen">
      {/* 顶部固定头部 */}
      <div className="mini-header">
        <button className="back-button" onClick={() => go('listening')} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>讲解记录</strong>
        <span />
      </div>

      {/* 搜索框：全宽圆角 */}
      <div className="sh-search-bar">
        <Search size={15} className="sh-search-icon" />
        <input
          placeholder="搜索字幕内容"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {/* 字号控制行 */}
      <div className="sh-font-row">
        <span className="sh-font-label">字号</span>
        <div className="sh-font-seg">
          {(['small', 'medium', 'large'] as const).map(s => (
            <button
              key={s}
              className={fontSize === s ? 'active' : ''}
              onClick={() => setFontSize(s)}
            >
              {s === 'small' ? '小' : s === 'medium' ? '中' : '大'}
            </button>
          ))}
        </div>
      </div>

      {/* 字幕卡片列表 */}
      <div className="sh-list">
        {filtered.length === 0 ? (
          <div className="sh-empty">
            <p>{search ? '未找到匹配内容' : '暂无字幕记录'}</p>
          </div>
        ) : filtered.map(s => (
          <div key={s.id} className="sh-card">
            {/* 正文：中文 + 英文 单列 */}
            <div className="sh-body">
              {s.content_cn && (
                <p className="sh-cn" style={{ fontSize: fontSizeMap[fontSize] }}>
                  {s.content_cn}
                </p>
              )}
              {s.content_en && (
                <p className="sh-en" style={{ fontSize: fontSizeMap[fontSize] - 2 }}>
                  {s.content_en}
                </p>
              )}
            </div>
            {/* 底部操作行 */}
            <div className="sh-footer">
              <span className="sh-time">
                {new Date(s.created_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
              </span>
              <div className="sh-actions">
                <button
                  className="sh-action-btn"
                  aria-label="复制"
                  onClick={() => {
                    navigator.clipboard.writeText(s.content_cn).then(() => toast.success('已复制')).catch(() => {
                      const ta = document.createElement('textarea');
                      ta.value = s.content_cn;
                      document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta);
                      toast.success('已复制');
                    });
                  }}
                >
                  <Copy size={16} />
                </button>
                <button
                  className={`sh-action-btn${favIds.has(s.id) ? ' sh-fav-active' : ''}`}
                  aria-label={favIds.has(s.id) ? '取消收藏' : '收藏'}
                  onClick={() => handleFav(s)}
                >
                  <Star size={16} />
                </button>
              </div>
            </div>
          </div>
        ))}
        {/* 列表底部安全区 */}
        <div className="sh-bottom-space" />
      </div>
    </div>
  );
}
