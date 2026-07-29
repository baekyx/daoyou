import React, { useEffect, useState, useRef } from 'react';
import {
  CalendarDays, Filter, ChevronDown, Download, Share2, Star,
  Plus, Upload as UploadIcon, QrCode, ChevronRight, CircleDot
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { fetchPhotosSafe } from '@/api/photosSecure';
import { uploadPhoto, toggleFavorite, fetchFavorites } from '@/api/photos';
import { fetchActiveRooms } from '@/api/rooms';
import type { Photo, Room } from '@/types/types';
import { toast } from 'sonner';
import { BottomNav } from '@/pages/guide/GuideScreens';

interface Props { go: (id: string) => void }

// ─── 电子相册 ─────────────────────────────────────────
export function Album({ go }: Props) {
  const { currentRoom, user } = useAuth();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [favIds, setFavIds] = useState<Set<string>>(new Set());
  const [selectedPhoto, setSelectedPhoto] = useState<Photo | null>(null);

  useEffect(() => {
    if (!currentRoom) return;
    fetchPhotosSafe(currentRoom.id, 200).then(setPhotos);
    if (user) {
      fetchFavorites(user.id).then(favs => {
        setFavIds(new Set(favs.filter(f => f.target_type === 'photo').map(f => f.target_id)));
      });
    }
  }, [currentRoom?.id, user?.id]);

  const selectPhoto = (photo: Photo) => {
    setSelectedPhoto(photo);
    go('photo');
  };

  return (
    <div className="screen padded-screen">
      <div className="mini-header">
        <button className="back-button" onClick={() => go('listening')} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>旅行相册</strong>
        <span />
      </div>

      <div className="album-filter">
        <button><CalendarDays />全部日期<ChevronDown /></button>
        <span>筛选<Filter /></span>
      </div>

      {photos.length === 0 ? (
        <p style={{ textAlign: 'center', color: 'var(--muted)', padding: '32px 0' }}>暂无照片</p>
      ) : (
        <div className="exact-photo-grid">
          {photos.map(p => (
            <button key={p.id} onClick={() => selectPhoto(p)}>
              <span
                className="album-photo"
                style={{ backgroundImage: `url(${p.url})`, backgroundSize: 'cover', backgroundPosition: 'center' }}
              />
              <small>{new Date(p.uploaded_at).toLocaleDateString('zh-CN')}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── 照片详情 ─────────────────────────────────────────
export function PhotoDetail({ go }: Props) {
  const { currentRoom, user } = useAuth();
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [idx, setIdx] = useState(0);
  const [favIds, setFavIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!currentRoom) return;
    fetchPhotosSafe(currentRoom.id, 200).then(p => { setPhotos(p); });
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
      if (isFav) next.delete(photo.id); else next.add(photo.id);
      return next;
    });
  };

  return (
    <div className="screen photo-screen">
      <div className="mini-header" style={{ background: '#000', color: '#fff' }}>
        <button className="back-button" onClick={() => go('album')} aria-label="返回" style={{ color: '#fff' }}>
          <span className="back-chevron" style={{ borderColor: '#fff' }} />
        </button>
        <strong style={{ color: '#fff' }}>{idx + 1} / {photos.length}</strong>
        <span />
      </div>

      {photo ? (
        <div className="detail-group-photo" style={{
          backgroundImage: `url(${photo.url})`,
          backgroundSize: 'cover',
          backgroundPosition: 'center',
          height: 320,
          marginTop: 20,
        }} />
      ) : (
        <div className="detail-group-photo" />
      )}

      <div className="photo-info">
        <strong>{photo ? new Date(photo.uploaded_at).toLocaleString('zh-CN') : ''}</strong>
        <span style={{ fontSize: 12, color: '#aaa' }}>
          {(photo?.photographer as any)?.nickname ?? '摄影师'}
        </span>
      </div>

      <div className="photo-actions">
        <button onClick={() => photo && window.open(photo.url, '_blank')}>
          <Download /><span>保存</span>
        </button>
        <button onClick={() => { if (photo) { navigator.clipboard.writeText(photo.url); toast.success('链接已复制'); } }}>
          <Share2 /><span>分享</span>
        </button>
        <button onClick={handleFav} style={{ color: photo && favIds.has(photo.id) ? '#f6a900' : undefined }}>
          <Star /><span>{photo && favIds.has(photo.id) ? '已收藏' : '收藏'}</span>
        </button>
      </div>
    </div>
  );
}

// ─── 摄影师首页 ───────────────────────────────────────
export function PhotographerHome({ go }: Props) {
  const { user, profile, setCurrentRoom } = useAuth();
  const [rooms, setRooms] = useState<Room[]>([]);

  useEffect(() => {
    if (!user) return;
    fetchActiveRooms().then(setRooms);
  }, [user]);

  const mainRoom = rooms.find(r => r.status === 'live');

  return (
    <div className="screen padded-screen has-tabbar">
      <div className="photographer-hero">
        <p>你好，{profile?.nickname ?? profile?.username ?? '摄影师'}</p>
        <h1>拍摄任务</h1>
        <i />
        <div className="photographer-cutout" />
      </div>

      {mainRoom ? (
        <div className="main-shooting-card">
          <div className="main-shoot-photo" />
          <div>
            <em>主任务</em>
            <h2>{mainRoom.name}</h2>
            <p><CircleDot />拍摄中</p>
            <p style={{ fontSize: 12, color: 'var(--muted)' }}>房间号 {mainRoom.room_number}</p>
          </div>
          <button
            className="primary-button green"
            style={{ position: 'absolute', bottom: 14, right: 14, width: 'auto', padding: '0 16px' }}
            onClick={() => { setCurrentRoom(mainRoom); go('upload'); }}
          >
            进入上传<ChevronRight />
          </button>
        </div>
      ) : (
        <div className="main-shooting-card" style={{ justifyContent: 'center', alignItems: 'center', display: 'flex', flexDirection: 'column' }}>
          <p style={{ color: 'var(--muted)' }}>暂无进行中的拍摄任务</p>
        </div>
      )}

      <button className="scan-room">
        <span><QrCode /></span>
        <p>
          <strong>扫码加入房间</strong>
          <small>扫描导游提供的房间二维码</small>
        </p>
        <b><ChevronRight /></b>
      </button>

      <BottomNav active="任务" go={go} variant="photographer" />
    </div>
  );
}

// ─── 照片上传 ─────────────────────────────────────────
interface UploadItem {
  file: File;
  state: 'pending' | 'uploading' | 'done' | 'failed';
  progress: number;
  url?: string;
}

export function Upload({ go }: Props) {
  const { user, currentRoom } = useAuth();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const handleSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const newItems: UploadItem[] = files.map(f => ({ file: f, state: 'pending', progress: 0 }));
    setItems(prev => [...prev, ...newItems]);
  };

  const handleUpload = async () => {
    if (!currentRoom || !user) { toast.error('请先加入房间'); return; }
    setBusy(true);
    const pending = items.filter(i => i.state === 'pending');
    for (let i = 0; i < pending.length; i++) {
      const item = pending[i];
      setItems(prev => prev.map(p => p.file === item.file ? { ...p, state: 'uploading', progress: 30 } : p));
      const { photo, error } = await uploadPhoto(currentRoom.id, user.id, item.file);
      if (error || !photo) {
        setItems(prev => prev.map(p => p.file === item.file ? { ...p, state: 'failed', progress: 0 } : p));
        toast.error(`${item.file.name} 上传失败`);
      } else {
        setItems(prev => prev.map(p => p.file === item.file ? { ...p, state: 'done', progress: 100, url: photo.url } : p));
      }
    }
    setBusy(false);
    if (items.every(i => i.state === 'done' || i.state === 'failed')) {
      toast.success('上传完成');
    }
  };

  return (
    <div className="screen padded-screen">
      <div className="mini-header">
        <button className="back-button" onClick={() => go('photographer-tasks')} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>上传照片</strong>
        <span />
      </div>

      <div className="upload-zone-wrap">
        <p style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 12 }}>
          {currentRoom ? `当前任务：${currentRoom.name}` : '未选择房间'}
        </p>
        <button className="upload-zone" onClick={() => fileRef.current?.click()}>
          <span><Plus /></span>
          <strong>选择照片</strong>
          <small>支持 JPG / PNG，单张不超过 20MB</small>
        </button>
        <input ref={fileRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleSelect} />
      </div>

      {items.length > 0 && (
        <div className="upload-list">
          {items.map((item, i) => (
            <div key={i} className={`upload-item upload-item-${item.state}`}>
              {item.url ? (
                <span className="upload-thumb" style={{
                  backgroundImage: `url(${item.url})`, backgroundSize: 'cover', backgroundPosition: 'center',
                  width: 48, height: 48, borderRadius: 8, display: 'block', flexShrink: 0,
                }} />
              ) : (
                <span className="upload-thumb" style={{ width: 48, height: 48, borderRadius: 8, background: '#eee', display: 'block', flexShrink: 0 }} />
              )}
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ fontSize: 13, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {item.file.name}
                </strong>
                {item.state === 'uploading' && (
                  <div style={{ height: 4, background: '#dce9e0', borderRadius: 2, overflow: 'hidden', marginTop: 4 }}>
                    <div style={{ height: '100%', width: `${item.progress}%`, background: 'var(--green)', transition: 'width .3s' }} />
                  </div>
                )}
                <small style={{ color: 'var(--muted)', fontSize: 11 }}>
                  {item.state === 'pending' ? '待上传' : item.state === 'uploading' ? '上传中…' : item.state === 'done' ? '✓ 已上传' : '✗ 上传失败'}
                </small>
              </div>
              {item.state === 'failed' && (
                <button onClick={() => setItems(prev => prev.map((p, j) => j === i ? { ...p, state: 'pending' } : p))} style={{ fontSize: 12, color: 'var(--green)', background: 'none', border: 'none', cursor: 'pointer' }}>
                  重试
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      <button className="primary-button green" onClick={handleUpload} disabled={busy || items.filter(i => i.state === 'pending').length === 0}>
        {busy ? '上传中…' : `继续上传（${items.filter(i => i.state === 'pending').length} 张）`}
      </button>
      <button className="manage-history" onClick={() => go('photographer-tasks')}>返回任务列表</button>
    </div>
  );
}
