import React, { useEffect, useState, useRef } from 'react';
import {
  CalendarDays, Filter, ChevronDown, Download, Share2, Star,
  Plus, Upload as UploadIcon, Search, ChevronRight, CircleDot, Images
} from 'lucide-react';
import { useAuth } from '@/contexts/AuthContext';
import { supabase } from '@/db/supabase';
import { fetchPhotosSafe } from '@/api/photosSecure';
import { uploadPhoto, toggleFavorite, fetchFavorites } from '@/api/photos';
import { fetchActiveRooms, fetchRoomById } from '@/api/rooms';
import type { Photo, Room } from '@/types/types';
import { toast } from 'sonner';
import { BottomNav } from '@/pages/guide/GuideScreens';
import { useRoomPresence } from '@/hooks/use-room-presence';
import {
  formatFileSize,
  prepareImageForUpload,
  readUploadQuality,
  UPLOAD_QUALITY_OPTIONS,
  type UploadQuality,
} from '@/lib/imageCompression';
import {
  getUploadNetworkState,
  isWifiOnlyUploadEnabled,
} from '@/lib/networkPreferences';

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
        <strong style={{ color: '#fff' }}>{photo ? idx + 1 : 0} / {photos.length}</strong>
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
        <div className="photo-detail-empty" role="status">
          <Images size={42} />
          <strong>照片暂时不可用</strong>
          <span>请返回相册刷新后重试</span>
        </div>
      )}

      <div className="photo-info">
        <strong>{photo ? new Date(photo.uploaded_at).toLocaleString('zh-CN') : ''}</strong>
        <span style={{ fontSize: 12, color: '#aaa' }}>
          {(photo?.photographer as any)?.nickname ?? '摄影师'}
        </span>
      </div>

      <div className="photo-actions">
        <button disabled={!photo} onClick={() => photo && window.open(photo.url, '_blank')}>
          <Download /><span>保存</span>
        </button>
        <button disabled={!photo} onClick={() => { if (photo) { navigator.clipboard.writeText(photo.url); toast.success('链接已复制'); } }}>
          <Share2 /><span>分享</span>
        </button>
        <button disabled={!photo} onClick={handleFav} style={{ color: photo && favIds.has(photo.id) ? '#f6a900' : undefined }}>
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

      <button className="scan-room" onClick={() => go('photo-join')}>
        <span><Search /></span>
        <p>
          <strong>输入房间号加入</strong>
          <small>输入房间密码后直接加入</small>
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
  state: 'pending' | 'processing' | 'uploading' | 'done' | 'failed';
  progress: number;
  url?: string;
  uploadSize?: number;
  compressed?: boolean;
}

export function Upload({ go }: Props) {
  const { user, currentRoom, setCurrentRoom } = useAuth();
  const [items, setItems] = useState<UploadItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [access, setAccess] = useState<'checking' | 'approved' | 'blocked'>('checking');
  const [accessMessage, setAccessMessage] = useState('');
  const [quality, setQuality] = useState<UploadQuality>(() => readUploadQuality());
  const fileRef = useRef<HTMLInputElement>(null);
  const { trackPresence, untrackPresence } = useRoomPresence();

  useEffect(() => {
    if (access !== 'approved') return;
    trackPresence();
    return () => { void untrackPresence(); };
  }, [access, trackPresence, untrackPresence]);

  useEffect(() => {
    let mounted = true;
    if (!user || !currentRoom) {
      setAccess('blocked');
      setAccessMessage('请先从拍摄任务中选择一个房间');
      return;
    }

    (async () => {
      setAccess('checking');
      const [{ data, error }, latestRoom] = await Promise.all([
        supabase
          .from('memberships')
          .select('approval_status,left_at')
          .eq('room_id', currentRoom.id)
          .eq('user_id', user.id)
          .eq('role', 'photographer')
          .maybeSingle(),
        fetchRoomById(currentRoom.id),
      ]);
      if (!mounted) return;

      if (latestRoom) setCurrentRoom(latestRoom);
      if (error || !data) {
        setAccess('blocked');
        setAccessMessage('没有找到该房间的摄影任务，请返回任务列表重新进入');
        return;
      }
      if (data.approval_status !== 'approved' || data.left_at) {
        setAccess('blocked');
        setAccessMessage(data.approval_status === 'pending'
          ? '请重新输入房间密码，验证后即可上传照片'
          : '该摄影任务目前没有上传权限');
        return;
      }
      if ((latestRoom ?? currentRoom).status === 'ended') {
        setAccess('blocked');
        setAccessMessage('本次讲解已经结束，不能继续上传照片');
        return;
      }
      setAccess('approved');
      setAccessMessage('');
    })();

    return () => { mounted = false; };
  }, [currentRoom?.id, user?.id, setCurrentRoom]);

  const handleSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    const maxSourceSize = quality === 'original' ? 20 : 50;
    const validFiles = files.filter(file => (
      (/^image\/(jpeg|png|webp)$/i.test(file.type) || /\.(jpe?g|png|webp)$/i.test(file.name))
      && file.size <= maxSourceSize * 1024 * 1024
    ));
    const rejectedCount = files.length - validFiles.length;
    if (rejectedCount > 0) {
      toast.error(`${rejectedCount} 张照片格式不支持或超过 ${maxSourceSize}MB`);
    }
    const newItems: UploadItem[] = validFiles.map(f => ({ file: f, state: 'pending', progress: 0 }));
    setItems(prev => [...prev, ...newItems]);
    e.target.value = '';
  };

  const selectQuality = (nextQuality: UploadQuality) => {
    setQuality(nextQuality);
    localStorage.setItem('shiguang-upload-quality', nextQuality);
  };

  const handleUpload = async () => {
    if (access !== 'approved' || !currentRoom || !user) {
      toast.error(accessMessage || '当前房间没有照片上传权限');
      return;
    }
    if (!navigator.onLine) {
      toast.error('当前设备离线，请联网后重试');
      return;
    }
    const networkState = getUploadNetworkState();
    const wifiOnly = isWifiOnlyUploadEnabled();
    if (wifiOnly && !networkState.allowed) {
      toast.error(networkState.reason ?? '当前网络不是 Wi-Fi');
      return;
    }
    if (wifiOnly && !networkState.detectable) {
      toast.warning('当前浏览器无法识别 Wi-Fi，已继续上传，请留意流量使用');
    }
    setBusy(true);
    const pending = items.filter(i => i.state === 'pending');
    let successCount = 0;
    let failedCount = 0;
    try {
      for (let i = 0; i < pending.length; i++) {
        const item = pending[i];
        setItems(prev => prev.map(p => (
          p.file === item.file ? { ...p, state: 'processing', progress: 15 } : p
        )));
        let prepared;
        try {
          prepared = await prepareImageForUpload(item.file, quality);
        } catch (error) {
          failedCount += 1;
          const message = error instanceof Error ? error.message : '图片处理失败';
          setItems(prev => prev.map(p => (
            p.file === item.file ? { ...p, state: 'failed', progress: 0 } : p
          )));
          toast.error(`${item.file.name}：${message}`);
          continue;
        }
        setItems(prev => prev.map(p => (
          p.file === item.file
            ? {
              ...p,
              state: 'uploading',
              progress: 45,
              uploadSize: prepared.file.size,
              compressed: prepared.compressed,
            }
            : p
        )));
        try {
          const { photo, error } = await uploadPhoto(currentRoom.id, user.id, prepared.file);
          if (error || !photo) {
            failedCount += 1;
            setItems(prev => prev.map(p => p.file === item.file ? { ...p, state: 'failed', progress: 0 } : p));
            toast.error(`${item.file.name} 上传失败：${error ?? '服务未返回照片记录'}`);
          } else {
            successCount += 1;
            setItems(prev => prev.map(p => p.file === item.file ? { ...p, state: 'done', progress: 100, url: photo.url } : p));
          }
        } catch (error) {
          failedCount += 1;
          const message = error instanceof Error ? error.message : '网络请求异常';
          setItems(prev => prev.map(p => p.file === item.file ? { ...p, state: 'failed', progress: 0 } : p));
          toast.error(`${item.file.name} 上传失败：${message}`);
        }
      }
    } finally {
      setBusy(false);
    }
    if (successCount > 0 && failedCount === 0) toast.success(`${successCount} 张照片上传完成`);
    else if (successCount > 0) toast.warning(`${successCount} 张上传成功，${failedCount} 张失败`);
    else if (failedCount > 0) toast.error(`${failedCount} 张照片上传失败，可点击重试`);
  };

  return (
    <div className="screen padded-screen upload-screen">
      <div className="mini-header">
        <button className="back-button" onClick={() => go('photographer-tasks')} aria-label="返回">
          <span className="back-chevron" />
        </button>
        <strong>上传照片</strong>
        <span />
      </div>

      <div className="upload-zone-wrap">
        <div className="upload-task-context">
          <span>当前任务</span>
          <strong>{currentRoom?.name ?? '未选择房间'}</strong>
          {currentRoom && <small>房间号 {currentRoom.room_number}</small>}
        </div>
        {access === 'checking' ? (
          <div className="loading-state"><div className="spinner" /><span>检查上传权限中…</span></div>
        ) : access === 'blocked' ? (
          <div className="empty-state">
            <Images size={36} className="empty-icon" />
            <p className="empty-title">暂时不能上传</p>
            <small className="empty-desc">{accessMessage}</small>
          </div>
        ) : (
          <>
            <button className="upload-zone" onClick={() => fileRef.current?.click()}>
              <span><Plus /></span>
              <strong>选择照片</strong>
              <small>{quality === 'original' ? '原图单张不超过 20MB' : '源文件单张不超过 50MB'}</small>
            </button>
            <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp" multiple style={{ display: 'none' }} onChange={handleSelect} />
          </>
        )}
      </div>

      {access === 'approved' && (
        <section className="upload-quality-card" aria-labelledby="upload-quality-title">
          <div className="upload-quality-heading">
            <strong id="upload-quality-title">上传画质</strong>
            <span>本次选择会自动保存</span>
          </div>
          <div className="upload-quality-options">
            {UPLOAD_QUALITY_OPTIONS.map(option => (
              <button
                key={option.value}
                type="button"
                className={quality === option.value ? 'active' : ''}
                aria-pressed={quality === option.value}
                onClick={() => selectQuality(option.value)}
                disabled={busy}
              >
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </button>
            ))}
          </div>
        </section>
      )}

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
                {(item.state === 'processing' || item.state === 'uploading') && (
                  <div style={{ height: 4, background: '#dce9e0', borderRadius: 2, overflow: 'hidden', marginTop: 4 }}>
                    <div style={{ height: '100%', width: `${item.progress}%`, background: 'var(--green)', transition: 'width .3s' }} />
                  </div>
                )}
                <small style={{ color: 'var(--muted)', fontSize: 11 }}>
                  {item.state === 'pending'
                    ? `${formatFileSize(item.file.size)} · 待上传`
                    : item.state === 'processing'
                      ? '正在按所选画质处理…'
                      : item.state === 'uploading'
                        ? `${item.compressed ? '已压缩 · ' : ''}${formatFileSize(item.uploadSize ?? item.file.size)} · 上传中…`
                        : item.state === 'done'
                          ? `✓ 已上传 · ${formatFileSize(item.uploadSize ?? item.file.size)}`
                          : '✗ 上传失败'}
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

      <button className="primary-button green" onClick={handleUpload} disabled={access !== 'approved' || busy || items.filter(i => i.state === 'pending').length === 0}>
        {busy ? '上传中…' : `开始上传（${items.filter(i => i.state === 'pending').length} 张）`}
      </button>
      <button className="manage-history" onClick={() => go('photographer-tasks')}>返回任务列表</button>
    </div>
  );
}
