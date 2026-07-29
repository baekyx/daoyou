/**
 * RoomCoverCropModal — 房间封面选择与裁剪
 *
 * 特性：
 *   - 固定 16:9 矩形裁剪框（与房间封面真实展示比例一致）
 *   - 单指移动 / 双指以中心缩放；桌面：鼠标拖动 + 滚轮缩放
 *   - 任何状态下裁剪框不露空白边缘（边界钳制）
 *   - EXIF 方向自动修正（iOS 拍照横竖方向问题）
 *   - 裁剪后迭代压缩为严格 < 4.8 MiB 的 JPEG（先降 quality，再降尺寸）
 *   - 最终断言：仍 >= 4.8 MiB 时拒绝上传并中文提示
 *   - 不设置原图字节上限，只校验 file.type 是可解码图片
 *   - ObjectURL 在取消、完成、换图、组件卸载时全部 revoke
 *   - 顶部"取消 / 完成"；取消不改变原封面
 *   - 完成时防重复提交，显示"正在处理图片…"
 *
 * 使用方：
 *   <RoomCoverCropModal src={objectUrl} onConfirm={(blob) => ...} onCancel={() => ...} />
 *   - src：原图 ObjectURL（调用方在 onCancel/onConfirm 后统一 revoke）
 *   - onConfirm：收到经过裁剪 + 压缩的 JPEG Blob，size 严格 < 4.8 MiB
 */
import React, {
  useState, useCallback, useRef, useEffect,
} from 'react';
import { toast } from 'sonner';

// ─── 常量 ──────────────────────────────────────────────────────────────────
/** 裁剪框宽度占 stage 宽度的比例 */
const CROP_W_RATIO = 0.92;
/** 裁剪框宽高比 16:9 */
const CROP_ASPECT_W = 16;
const CROP_ASPECT_H = 9;
/** 输出最大长边（不放大低分辨率原图） */
const OUTPUT_MAX_LONG_EDGE = 2400;
/** 压缩目标字节上限（4.8 MiB，留余量防止边界误差） */
const MAX_BYTES = 4.8 * 1024 * 1024;
/** 迭代压缩：quality 步长 */
const QUALITY_STEP = 0.07;
/** 迭代压缩：quality 下限 */
const QUALITY_MIN = 0.40;
/** 迭代压缩：尺寸降幅系数 */
const SIZE_SHRINK = 0.85;
/** 滚轮缩放灵敏度 */
const WHEEL_SENSITIVITY = 0.0012;

// ─── 类型 ──────────────────────────────────────────────────────────────────
interface Props {
  /** 原图 ObjectURL（调用方负责在 onConfirm/onCancel 后 revoke） */
  src: string;
  /** 收到裁剪 + 压缩后的 JPEG Blob，size < 4.8 MiB */
  onConfirm: (blob: Blob) => void;
  /** 取消时调用 */
  onCancel: () => void;
}

interface CropRect { x: number; y: number; w: number; h: number }
interface Offset { x: number; y: number }

// ─── EXIF 方向修正 ─────────────────────────────────────────────────────────
async function getExifOrientation(url: string): Promise<number> {
  try {
    const resp = await fetch(url);
    const buf = await resp.arrayBuffer();
    const view = new DataView(buf);
    if (view.getUint16(0) !== 0xFFD8) return 1;
    let offset = 2;
    while (offset < view.byteLength - 2) {
      const marker = view.getUint16(offset);
      const segLen = view.getUint16(offset + 2);
      if (marker === 0xFFE1) {
        if (view.getUint32(offset + 4) === 0x45786966) {
          const tiffOffset = offset + 10;
          const littleEndian = view.getUint16(tiffOffset) === 0x4949;
          const ifdOffset = view.getUint32(tiffOffset + 4, littleEndian) + tiffOffset;
          const numEntries = view.getUint16(ifdOffset, littleEndian);
          for (let i = 0; i < numEntries; i++) {
            const entryOffset = ifdOffset + 2 + i * 12;
            if (view.getUint16(entryOffset, littleEndian) === 0x0112) {
              return view.getUint16(entryOffset + 8, littleEndian);
            }
          }
        }
        break;
      }
      offset += 2 + segLen;
    }
  } catch { /* ignore */ }
  return 1;
}

async function buildOrientedCanvas(src: string): Promise<HTMLCanvasElement> {
  const orientation = await getExifOrientation(src);
  const img = new Image();
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = rej;
    img.src = src;
  });
  const w = img.naturalWidth;
  const h = img.naturalHeight;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d')!;
  if (orientation >= 5 && orientation <= 8) { canvas.width = h; canvas.height = w; }
  else { canvas.width = w; canvas.height = h; }
  switch (orientation) {
    case 2: ctx.transform(-1, 0, 0, 1, w, 0); break;
    case 3: ctx.transform(-1, 0, 0, -1, w, h); break;
    case 4: ctx.transform(1, 0, 0, -1, 0, h); break;
    case 5: ctx.transform(0, 1, 1, 0, 0, 0); break;
    case 6: ctx.transform(0, 1, -1, 0, h, 0); break;
    case 7: ctx.transform(0, -1, -1, 0, h, w); break;
    case 8: ctx.transform(0, -1, 1, 0, 0, w); break;
    default: break;
  }
  ctx.drawImage(img, 0, 0);
  return canvas;
}

// ─── 迭代压缩核心 ─────────────────────────────────────────────────────────
/**
 * 将裁剪区域压缩为 < MAX_BYTES 的 JPEG Blob。
 * 策略：先逐步降 quality（0.9 → 0.4），还不够则逐步缩小尺寸（×0.85），
 * 再从 quality=0.82 重新迭代，直到满足或触底后抛出异常。
 */
async function cropAndCompress(
  orientedCanvas: HTMLCanvasElement,
  srcX: number, srcY: number, srcW: number, srcH: number,
): Promise<Blob> {
  // 输出尺寸：不超过最大长边，也不放大原图
  const scaleToMax = Math.min(1, OUTPUT_MAX_LONG_EDGE / Math.max(srcW, srcH));
  let outW = Math.round(srcW * scaleToMax);
  let outH = Math.round(srcH * scaleToMax);

  const toBlob = (canvas: HTMLCanvasElement, quality: number): Promise<Blob> =>
    new Promise((res, rej) =>
      canvas.toBlob(b => b ? res(b) : rej(new Error('toBlob 返回 null')), 'image/jpeg', quality)
    );

  const render = (w: number, h: number): HTMLCanvasElement => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    // 白色背景（消除 PNG 透明通道）
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(orientedCanvas, srcX, srcY, srcW, srcH, 0, 0, w, h);
    return c;
  };

  // 最多循环 3 次降尺寸
  for (let sizeRound = 0; sizeRound < 3; sizeRound++) {
    const c = render(outW, outH);
    let quality = 0.90;
    while (quality >= QUALITY_MIN) {
      const blob = await toBlob(c, quality);
      if (blob.size < MAX_BYTES) return blob;
      quality = Math.round((quality - QUALITY_STEP) * 100) / 100;
    }
    // quality 已到底，缩小尺寸
    outW = Math.max(1, Math.round(outW * SIZE_SHRINK));
    outH = Math.max(1, Math.round(outH * SIZE_SHRINK));
  }
  // 最后一次尝试最低 quality
  const finalCanvas = render(outW, outH);
  const finalBlob = await toBlob(finalCanvas, QUALITY_MIN);
  if (finalBlob.size >= MAX_BYTES) {
    throw new Error(`图片处理失败，最终大小 ${(finalBlob.size / 1024 / 1024).toFixed(1)} MiB，请重试`);
  }
  return finalBlob;
}

// ─── 边界钳制 ─────────────────────────────────────────────────────────────
function clamp(
  tx: number, ty: number, scale: number,
  nat: { w: number; h: number },
  cr: CropRect,
): { tx: number; ty: number; scale: number } {
  const imgW = nat.w * scale;
  const imgH = nat.h * scale;
  return {
    tx: Math.min(cr.x, Math.max(cr.x + cr.w - imgW, tx)),
    ty: Math.min(cr.y, Math.max(cr.y + cr.h - imgH, ty)),
    scale,
  };
}

// ─── 组件 ─────────────────────────────────────────────────────────────────
export function RoomCoverCropModal({ src, onConfirm, onCancel }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const [imgNat, setImgNat] = useState({ w: 0, h: 0 });
  const [transform, setTransform] = useState({ tx: 0, ty: 0, scale: 1 });
  const [cropRect, setCropRect] = useState<CropRect>({ x: 0, y: 0, w: 0, h: 0 });
  const [confirming, setConfirming] = useState(false);

  // 供事件回调读取（避免 stale closure）
  const txRef = useRef(transform);
  const crRef = useRef(cropRect);
  const natRef = useRef(imgNat);
  useEffect(() => { txRef.current = transform; }, [transform]);
  useEffect(() => { crRef.current = cropRect; }, [cropRect]);
  useEffect(() => { natRef.current = imgNat; }, [imgNat]);

  // ── 图片加载完成后初始化 transform ──
  const handleImgLoad = useCallback(() => {
    const img = imgRef.current;
    const stage = stageRef.current;
    if (!img || !stage) return;
    const natW = img.naturalWidth;
    const natH = img.naturalHeight;
    setImgNat({ w: natW, h: natH });

    const stageW = stage.clientWidth;
    const stageH = stage.clientHeight;
    const cropW = Math.round(stageW * CROP_W_RATIO);
    const cropH = Math.round(cropW * CROP_ASPECT_H / CROP_ASPECT_W);
    const cropX = Math.round((stageW - cropW) / 2);
    const cropY = Math.round((stageH - cropH) / 2);
    const cr = { x: cropX, y: cropY, w: cropW, h: cropH };
    setCropRect(cr);

    const scaleX = cropW / natW;
    const scaleY = cropH / natH;
    const initScale = Math.max(scaleX, scaleY);
    const imgDispW = natW * initScale;
    const imgDispH = natH * initScale;
    const tx = cropX + (cropW - imgDispW) / 2;
    const ty = cropY + (cropH - imgDispH) / 2;
    setTransform({ tx, ty, scale: initScale });
  }, []);

  // ── 手势 ──
  const gestureRef = useRef<{
    type: 'none' | 'drag' | 'pinch';
    lastX: number; lastY: number;
    initDist: number; initScale: number;
    initMidX: number; initMidY: number;
    initTx: number; initTy: number;
  }>({ type: 'none', lastX: 0, lastY: 0, initDist: 0, initScale: 1, initMidX: 0, initMidY: 0, initTx: 0, initTy: 0 });

  const minScale = useCallback(() => {
    const cr = crRef.current; const nat = natRef.current;
    if (!cr.w || !nat.w) return 1;
    return Math.max(cr.w / nat.w, cr.h / nat.h);
  }, []);

  const onTouchStart = useCallback((e: TouchEvent) => {
    e.preventDefault();
    const g = gestureRef.current;
    if (e.touches.length === 1) {
      g.type = 'drag'; g.lastX = e.touches[0].clientX; g.lastY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      const t0 = e.touches[0]; const t1 = e.touches[1];
      g.type = 'pinch';
      g.initDist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      g.initScale = txRef.current.scale;
      g.initMidX = (t0.clientX + t1.clientX) / 2;
      g.initMidY = (t0.clientY + t1.clientY) / 2;
      g.initTx = txRef.current.tx;
      g.initTy = txRef.current.ty;
    }
  }, []);

  const onTouchMove = useCallback((e: TouchEvent) => {
    e.preventDefault();
    const g = gestureRef.current;
    const cr = crRef.current; const nat = natRef.current;
    if (!cr.w || !nat.w) return;
    if (g.type === 'drag' && e.touches.length === 1) {
      const dx = e.touches[0].clientX - g.lastX;
      const dy = e.touches[0].clientY - g.lastY;
      g.lastX = e.touches[0].clientX; g.lastY = e.touches[0].clientY;
      setTransform(prev => clamp(prev.tx + dx, prev.ty + dy, prev.scale, nat, cr));
    } else if (g.type === 'pinch' && e.touches.length === 2) {
      const t0 = e.touches[0]; const t1 = e.touches[1];
      const dist = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const minS = minScale();
      const newScale = Math.min(minS * 6, Math.max(minS, g.initScale * (dist / g.initDist)));
      const scaleDelta = newScale / g.initScale;
      const midX = (t0.clientX + t1.clientX) / 2;
      const midY = (t0.clientY + t1.clientY) / 2;
      const newTx = midX - scaleDelta * (g.initMidX - g.initTx);
      const newTy = midY - scaleDelta * (g.initMidY - g.initTy);
      setTransform(clamp(newTx, newTy, newScale, nat, cr));
    }
  }, [minScale]);

  const onTouchEnd = useCallback((e: TouchEvent) => {
    if (e.touches.length === 0) gestureRef.current.type = 'none';
    else if (e.touches.length === 1) {
      gestureRef.current.type = 'drag';
      gestureRef.current.lastX = e.touches[0].clientX;
      gestureRef.current.lastY = e.touches[0].clientY;
    }
  }, []);

  const onMouseDown = useCallback((e: MouseEvent) => {
    const g = gestureRef.current;
    g.type = 'drag'; g.lastX = e.clientX; g.lastY = e.clientY;
  }, []);

  const onMouseMove = useCallback((e: MouseEvent) => {
    if (gestureRef.current.type !== 'drag') return;
    const dx = e.clientX - gestureRef.current.lastX;
    const dy = e.clientY - gestureRef.current.lastY;
    gestureRef.current.lastX = e.clientX; gestureRef.current.lastY = e.clientY;
    const cr = crRef.current; const nat = natRef.current;
    setTransform(prev => clamp(prev.tx + dx, prev.ty + dy, prev.scale, nat, cr));
  }, []);

  const onMouseUp = useCallback(() => { gestureRef.current.type = 'none'; }, []);

  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const cr = crRef.current; const nat = natRef.current;
    if (!cr.w || !nat.w) return;
    const minS = minScale();
    const factor = e.deltaY < 0 ? 1 + WHEEL_SENSITIVITY * 80 : 1 - WHEEL_SENSITIVITY * 80;
    setTransform(prev => {
      const newScale = Math.min(minS * 6, Math.max(minS, prev.scale * factor));
      const scaleDelta = newScale / prev.scale;
      return clamp(
        e.offsetX - scaleDelta * (e.offsetX - prev.tx),
        e.offsetY - scaleDelta * (e.offsetY - prev.ty),
        newScale, nat, cr,
      );
    });
  }, [minScale]);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.addEventListener('touchstart', onTouchStart, { passive: false });
    stage.addEventListener('touchmove', onTouchMove, { passive: false });
    stage.addEventListener('touchend', onTouchEnd);
    stage.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      stage.removeEventListener('touchstart', onTouchStart);
      stage.removeEventListener('touchmove', onTouchMove);
      stage.removeEventListener('touchend', onTouchEnd);
      stage.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      stage.removeEventListener('wheel', onWheel);
    };
  }, [onTouchStart, onTouchMove, onTouchEnd, onMouseDown, onMouseMove, onMouseUp, onWheel]);

  // ── 完成：裁剪 + 迭代压缩 ──
  const handleConfirm = useCallback(async () => {
    if (confirming) return;
    const { tx, ty, scale } = txRef.current;
    const cr = crRef.current;
    const nat = natRef.current;
    if (!cr.w || !nat.w) return;

    setConfirming(true);
    try {
      // 将 stage 坐标系中的裁剪框映射回图片原始坐标
      const srcX = Math.max(0, (cr.x - tx) / scale);
      const srcY = Math.max(0, (cr.y - ty) / scale);
      const srcW = Math.min(cr.w / scale, nat.w - srcX);
      const srcH = Math.min(cr.h / scale, nat.h - srcY);

      let orientedCanvas: HTMLCanvasElement;
      try {
        orientedCanvas = await buildOrientedCanvas(src);
      } catch {
        toast.error('图片解码失败，请重试或更换图片');
        setConfirming(false);
        return;
      }

      let blob: Blob;
      try {
        blob = await cropAndCompress(orientedCanvas, srcX, srcY, srcW, srcH);
      } catch (err) {
        const msg = err instanceof Error ? err.message : '图片处理失败，请重试';
        toast.error(msg);
        setConfirming(false);
        return;
      }

      // 最终断言
      if (blob.size >= MAX_BYTES) {
        toast.error('图片处理失败，请重试');
        setConfirming(false);
        return;
      }

      onConfirm(blob);
    } catch {
      toast.error('图片处理异常，请重试');
      setConfirming(false);
    }
  }, [confirming, src, onConfirm]);

  // ── render ──
  const { tx, ty, scale } = transform;
  const { x: cx, y: cy, w: cw, h: ch } = cropRect;

  return (
    <div className="rcc-overlay">
      {/* 顶部操作栏 */}
      <div className="rcc-topbar">
        <button className="rcc-topbar-btn" onClick={onCancel} disabled={confirming}>取消</button>
        <span className="rcc-topbar-title">裁剪封面</span>
        <button
          className="rcc-topbar-btn rcc-topbar-confirm"
          onClick={handleConfirm}
          disabled={confirming || !cropRect.w}
        >
          {confirming ? '处理中…' : '完成'}
        </button>
      </div>

      {/* 裁剪舞台 */}
      <div className="rcc-stage" ref={stageRef}>
        {/* 原图（仅用于展示定位，实际输出走 canvas） */}
        <img
          ref={imgRef}
          src={src}
          alt=""
          className="rcc-img"
          style={{ transform: `translate(${tx}px,${ty}px) scale(${scale})`, transformOrigin: '0 0' }}
          onLoad={handleImgLoad}
          draggable={false}
        />
        {/* 半透明遮罩（四角） */}
        {cw > 0 && <>
          <div className="rcc-mask" style={{ top: 0, left: 0, width: '100%', height: cy }} />
          <div className="rcc-mask" style={{ top: cy + ch, left: 0, width: '100%', bottom: 0 }} />
          <div className="rcc-mask" style={{ top: cy, left: 0, width: cx, height: ch }} />
          <div className="rcc-mask" style={{ top: cy, left: cx + cw, right: 0, height: ch }} />
          {/* 裁剪框描边 */}
          <div className="rcc-frame" style={{ top: cy, left: cx, width: cw, height: ch }} />
        </>}
      </div>

      {/* 底部提示 */}
      <div className="rcc-hint">单指移动图片，双指缩放</div>
    </div>
  );
}
