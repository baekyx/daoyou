/**
 * 游客房间内相册 Tab（R10/R11/R12 独立页面）
 */
import React, { useEffect, useState } from 'react';
import { Landmark, CalendarDays, Download, Share2, Star, RefreshCw } from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { fetchPhotosSafe } from '@/api/photosSecure';
import { toggleFavorite, fetchFavorites } from '@/api/photos';
import type { Photo } from '@/types/types';
import { toast } from 'sonner';
import { BottomNav } from '@/pages/guide/GuideScreens';

interface Props { go: (id: string) => void }

// ─── R10/R11 相册 Tab ──────────────────────────────────
export function RoomAlbumTab({ go }: Props) {
  const { currentRoom, user } = useAuth();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [loading, setLoading] = useState(true);
  const isArchive = currentRoom?.status === 'ended' || currentRoom?.status === 'archived';

  const load = () => {
    if (!currentRoom) return;
    setLoading(true);
    fetchPhotosSafe(currentRoom.id, 200).then(p => { setPhotos(p); setLoading(false); });
  };

  useEffect(() => { load(); }, [currentRoom?.id]);

  const handlePhotoClick = (photo: Photo) => {
    sessionStorage.setItem('selected_photo_id', photo.id);
    go('room-photo-detail');
  };

  return (
    <div className={`screen padded-screen room-album-screen${isArchive ? ' archive-album-screen' : ' has-tabbar'}`}>
      <div className="mini-header">
        {isArchive ? (
          <button className="back-button" onClick={() => go('recent-rooms')} aria-label="返回最近记录">
            <span className="back-chevron" />
          </button>
        ) : <span />}
        <strong>{isArchive ? '房间照片' : '相册'}</strong>
        <button className="icon-btn" onClick={load} aria-label="刷新"><RefreshCw size={16} /></button>
      </div>

      {currentRoom && (
        <div className="room-album-meta">
          <span className="room-album-name">{currentRoom.name}</span>
          <span className="room-album-count">{photos.length} 张照片</span>
        </div>
      )}

      {loading ? (
        <div className="loading-state"><div className="spinner" /></div>
      ) : photos.length === 0 ? (
        <div className="empty-state room-album-empty">
          <div className="empty-illus-album" />
          <p className="empty-title">照片还在路上</p>
          <small className="empty-desc">摄影师上传后会显示在这里</small>
          <button className="empty-action-btn" onClick={load}><RefreshCw size={13} />稍后刷新</button>
        </div>
      ) : (
        <div className="room-photo-grid">
          {photos.map(p => (
            <button key={p.id} className="room-photo-cell" onClick={() => handlePhotoClick(p)}>
              <img src={p.url} alt="照片" className="room-photo-img" />
              <span className="room-photo-time">{new Date(p.uploaded_at).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}</span>
            </button>
          ))}
        </div>
      )}

      {!isArchive && <BottomNav active="相册" go={go} variant="room" />}
    </div>
  );
}

// ─── R12 照片详情 ─────────────────────────────────────
export function RoomPhotoDetail({ go }: Props) {
  const { currentRoom, user } = useAuth();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [idx, setIdx] = useState(0);
  const [favIds, setFavIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!currentRoom) return;
    fetchPhotosSafe(currentRoom.id, 200).then(list => {
      setPhotos(list);
      const selectedId = sessionStorage.getItem('selected_photo_id');
      if (selectedId) {
        const i = list.findIndex(p => p.id === selectedId);
        if (i >= 0) setIdx(i);
      }
    });
    if (user) {
      fetchFavorites(user.id).then(favs => {
        setFavIds(new Set(favs.filter(f => f.target_type === 'photo').map(f => f.target_id)));
      });
    }
  }, [currentRoom?.id, user?.id]);

  const photo = photos[idx];

  const handleFav = async () => {
    if (!user || !photo) return;
    const isFav = favIds.has(photo.id);
    await toggleFavorite(user.id, 'photo', photo.id, isFav);
    setFavIds(prev => {
      const next = new Set(prev);
      isFav ? next.delete(photo.id) : next.add(photo.id);
      return next;
    });
  };

  const handleSave = () => {
    if (!photo) return;
    const a = document.createElement('a');
    a.href = photo.url;
    a.download = `photo-${photo.id}.jpg`;
    a.target = '_blank';
    a.click();
  };

  const handleShare = () => {
    if (!photo) return;
    if (navigator.share) {
      navigator.share({ url: photo.url }).catch(() => {});
    } else {
      navigator.clipboard.writeText(photo.url);
      toast.success('链接已复制');
    }
  };

  return (
    <div className="screen photo-detail-screen">
      <div className="mini-header photo-detail-header">
        <button className="back-button" onClick={() => go('room-album')} aria-label="返回" style={{ color: '#fff' }}>
          <span className="back-chevron" style={{ borderColor: '#fff' }} />
        </button>
        <strong>{photos.length > 0 ? `${idx + 1} / ${photos.length}` : ''}</strong>
        <span />
      </div>

      <div className="photo-detail-main">
        {photo ? (
          <img src={photo.url} className="photo-detail-img" alt="照片" />
        ) : (
          <div className="photo-detail-placeholder"><Landmark size={32} /></div>
        )}
      </div>

      {photo && (
        <div className="photo-detail-info">
          <span className="photo-detail-time">{new Date(photo.uploaded_at).toLocaleString('zh-CN')}</span>
          <span className="photo-detail-author">{(photo.photographer as Record<string,string>)?.nickname ?? '摄影师'}</span>
        </div>
      )}

      <div className="photo-detail-actions">
        <button onClick={handleSave}><Download size={18} /><span>保存</span></button>
        <button onClick={handleShare}><Share2 size={18} /><span>分享</span></button>
        <button onClick={handleFav} style={{ color: photo && favIds.has(photo.id) ? '#f6a900' : undefined }}>
          <Star size={18} /><span>{photo && favIds.has(photo.id) ? '已收藏' : '收藏'}</span>
        </button>
      </div>

      {photos.length > 1 && (
        <div className="photo-nav-row">
          <button onClick={() => setIdx(i => Math.max(0, i - 1))} disabled={idx === 0}>‹</button>
          <button onClick={() => setIdx(i => Math.min(photos.length - 1, i + 1))} disabled={idx === photos.length - 1}>›</button>
        </div>
      )}
    </div>
  );
}
