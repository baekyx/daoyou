/**
 * AvatarCropModal — 头像圆形裁剪弹窗 (v2)
 *
 * 核心改进（v2）：
 *   - 手势/坐标系完全复用 RoomCoverCropModal 的 {tx,ty,scale} + transformOrigin:'0 0' 框架
 *     消除原有 offset/zoom 双态嵌套 setState 竞态与初始偏左问题
 *   - 裁剪圆固定直径 clamp(280px, 82vw, 300px)，390px下≈300px
 *   - 图片加载后自动 cover 最小缩放并使图片中心与圆心重合
 *   - minScale 保证图片始终覆盖圆框；边界钳制任何缩放级别均无空白
 *   - maxScale = minScale × 4
 *   - 单指拖动 / 双指 pinch（以 initMid 为锚点，无跳位）/ 桌面滚轮
 *   - 底部滑块与手势共享同一 scale state
 *   - 确认输出 512×512 WebP（降级JPEG），对应圆框正方形区域
 *   - EXIF 自动修正；PNG 白底合成防黑边
 *   - 取消/重开/换图重置所有状态
 */
import React, {
  useState, useCallback, useRef, useEffect,
} from 'react';
import { toast } from 'sonner';

// ─── 常量 ──────────────────────────────────────────────────────────────────
const OUTPUT_SIZE = 512;
/** maxScale = minScale × 此系数 */
const MAX_SCALE_FACTOR = 4;
const WHEEL_SENSITIVITY = 0.0012;

// ─── 类型 ──────────────────────────────────────────────────────────────────
interface Props {
  src: string;
  onConfirm: (croppedFile: File) => void;
  onCancel: () => void;
}

interface Transform { tx: number; ty: number; scale: number }
interface NatSize { w: number; h: number }
/** 圆形裁剪框在 stage 坐标系中的描述（正方形外接框） */
interface CropCircle { cx: number; cy: number; r: number }

// ─── EXIF 方向修正（复用 RoomCoverCropModal 实现） ──────────────────────────
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
  } catch { /* 非JPEG或解析失败 */ }
  return 1;
}

async function buildOrientedCanvas(src: string): Promise<HTMLCanvasElement> {
  const orientation = await getExifOrientation(src);
  const img = new Image();
  img.crossOrigin = 'anonymous';
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

// ─── WebP 检测 ─────────────────────────────────────────────────────────────
let _webpSupported: boolean | null = null;
function supportsWebP(): boolean {
  if (_webpSupported !== null) return _webpSupported;
  const c = document.createElement('canvas');
  c.width = 1; c.height = 1;
  _webpSupported = c.toDataURL('image/webp').startsWith('data:image/webp');
  return _webpSupported;
}

// ─── 边界钳制（RoomCover 相同逻辑，正方形圆框） ────────────────────────────
/**
 * tx/ty = 图片左上角在 stage 坐标中的位置（transformOrigin:'0 0'）
 * 约束：图片四边必须覆盖圆形裁剪框的外接正方形
 */
function clampTransform(
  tx: number, ty: number, scale: number,
  nat: NatSize,
  cc: CropCircle,
): Transform {
  const side = cc.r * 2;
  const boxX = cc.cx - cc.r;
  const boxY = cc.cy - cc.r;
  const imgW = nat.w * scale;
  const imgH = nat.h * scale;
  return {
    tx: Math.min(boxX, Math.max(boxX + side - imgW, tx)),
    ty: Math.min(boxY, Math.max(boxY + side - imgH, ty)),
    scale,
  };
}

// ─── Canvas 导出：512×512 圆框正方形区域 ───────────────────────────────────
async function exportCroppedFile(
  orientedCanvas: HTMLCanvasElement,
  transform: Transform,
  nat: NatSize,
  cc: CropCircle,
): Promise<File> {
  const { tx, ty, scale } = transform;
  const side = cc.r * 2;
  const boxX = cc.cx - cc.r;
  const boxY = cc.cy - cc.r;
  // stage 坐标 → 原始图像像素坐标
  const srcX = Math.max(0, (boxX - tx) / scale);
  const srcY = Math.max(0, (boxY - ty) / scale);
  const srcSize = side / scale;

  return new Promise((resolve, reject) => {
    const out = document.createElement('canvas');
    out.width = OUTPUT_SIZE; out.height = OUTPUT_SIZE;
    const ctx = out.getContext('2d');
    if (!ctx) { reject(new Error('canvas context unavailable')); return; }
    // 白底防 PNG 透明黑边
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE);
    ctx.drawImage(orientedCanvas, srcX, srcY, srcSize, srcSize, 0, 0, OUTPUT_SIZE, OUTPUT_SIZE);

    const useWebP = supportsWebP();
    const mime    = useWebP ? 'image/webp' : 'image/jpeg';
    const quality = useWebP ? 0.86 : 0.9;
    const ext     = useWebP ? 'avatar.webp' : 'avatar.jpg';
    out.toBlob(
      blob => {
        if (!blob) { reject(new Error('canvas toBlob 失败')); return; }
        resolve(new File([blob], ext, { type: mime }));
      },
      mime, quality,
    );
  });
}

// ─── 主组件 ────────────────────────────────────────────────────────────────
export function AvatarCropModal({ src, onConfirm, onCancel }: Props) {
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef   = useRef<HTMLImageElement>(null);

  const [nat, setNat] = useState<NatSize>({ w: 0, h: 0 });
  const [transform, setTransform] = useState<Transform>({ tx: 0, ty: 0, scale: 1 });
  const [cc, setCc] = useState<CropCircle>({ cx: 0, cy: 0, r: 0 });
  const [minScale, setMinScale] = useState(1);
  const [maxScale, setMaxScale] = useState(4);
  const [imgLoaded, setImgLoaded] = useState(false);
  const [busy, setBusy] = useState(false);

  // stale-closure 防护 refs
  const txRef  = useRef(transform);
  const ccRef  = useRef(cc);
  const natRef = useRef(nat);
  const minSRef = useRef(minScale);
  const maxSRef = useRef(maxScale);
  useEffect(() => { txRef.current = transform; }, [transform]);
  useEffect(() => { ccRef.current = cc; }, [cc]);
  useEffect(() => { natRef.current = nat; }, [nat]);
  useEffect(() => { minSRef.current = minScale; minSRef.current = minScale; }, [minScale]);
  useEffect(() => { maxSRef.current = maxScale; }, [maxScale]);

  // ── 图片加载完成后初始化 transform ──────────────────────────────────────
  const handleImgLoad = useCallback(() => {
    const img   = imgRef.current;
    const stage = stageRef.current;
    if (!img || !stage) return;

    const natW = img.naturalWidth;
    const natH = img.naturalHeight;
    setNat({ w: natW, h: natH });

    const stageW = stage.clientWidth;
    const stageH = stage.clientHeight;

    // 裁剪圆直径：clamp(280, 82vw, 300)，圆心在 stage 中央
    const diam = Math.min(300, Math.max(280, stageW * 0.82));
    const r    = diam / 2;
    const cx   = stageW / 2;
    const cy   = stageH / 2;
    const newCc: CropCircle = { cx, cy, r };
    setCc(newCc);

    // minScale：cover 圆框正方形
    const side = diam;
    const minS = Math.max(side / natW, side / natH);
    const maxS = minS * MAX_SCALE_FACTOR;
    setMinScale(minS);
    setMaxScale(maxS);

    // 初始：图片中心与圆心重合，scale = minScale
    const imgDispW = natW * minS;
    const imgDispH = natH * minS;
    const tx = cx - imgDispW / 2;
    const ty = cy - imgDispH / 2;
    setTransform(clampTransform(tx, ty, minS, { w: natW, h: natH }, newCc));
    setImgLoaded(true);
  }, []);

  // ── 手势处理（与 RoomCoverCropModal 完全相同框架） ──────────────────────
  const gestureRef = useRef<{
    type: 'none' | 'drag' | 'pinch';
    lastX: number; lastY: number;
    initDist: number; initScale: number;
    initMidX: number; initMidY: number;
    initTx: number; initTy: number;
  }>({ type: 'none', lastX: 0, lastY: 0, initDist: 0, initScale: 1,
       initMidX: 0, initMidY: 0, initTx: 0, initTy: 0 });

  const onTouchStart = useCallback((e: TouchEvent) => {
    e.preventDefault();
    const g = gestureRef.current;
    if (e.touches.length === 1) {
      g.type = 'drag';
      g.lastX = e.touches[0].clientX; g.lastY = e.touches[0].clientY;
    } else if (e.touches.length === 2) {
      const t0 = e.touches[0]; const t1 = e.touches[1];
      g.type      = 'pinch';
      g.initDist  = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      g.initScale = txRef.current.scale;
      g.initMidX  = (t0.clientX + t1.clientX) / 2;
      g.initMidY  = (t0.clientY + t1.clientY) / 2;
      g.initTx    = txRef.current.tx;
      g.initTy    = txRef.current.ty;
    }
  }, []);

  const onTouchMove = useCallback((e: TouchEvent) => {
    e.preventDefault();
    const g = gestureRef.current;
    const n = natRef.current; const circle = ccRef.current;
    if (!circle.r || !n.w) return;

    if (g.type === 'drag' && e.touches.length === 1) {
      const dx = e.touches[0].clientX - g.lastX;
      const dy = e.touches[0].clientY - g.lastY;
      g.lastX = e.touches[0].clientX; g.lastY = e.touches[0].clientY;
      setTransform(prev => clampTransform(prev.tx + dx, prev.ty + dy, prev.scale, n, circle));
    } else if (g.type === 'pinch' && e.touches.length === 2) {
      const t0 = e.touches[0]; const t1 = e.touches[1];
      const dist     = Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY);
      const minS     = minSRef.current;
      const newScale = Math.min(minS * MAX_SCALE_FACTOR, Math.max(minS, g.initScale * (dist / g.initDist)));
      const sd       = newScale / g.initScale;
      const midX     = (t0.clientX + t1.clientX) / 2;
      const midY     = (t0.clientY + t1.clientY) / 2;
      // 以 initMid 为锚点（消除跳位）
      const newTx = midX - sd * (g.initMidX - g.initTx);
      const newTy = midY - sd * (g.initMidY - g.initTy);
      setTransform(clampTransform(newTx, newTy, newScale, n, circle));
    }
  }, []);

  const onTouchEnd = useCallback((e: TouchEvent) => {
    if (e.touches.length === 0) {
      gestureRef.current.type = 'none';
    } else if (e.touches.length === 1) {
      gestureRef.current.type  = 'drag';
      gestureRef.current.lastX = e.touches[0].clientX;
      gestureRef.current.lastY = e.touches[0].clientY;
    }
  }, []);

  const onMouseDown = useCallback((e: MouseEvent) => {
    gestureRef.current.type  = 'drag';
    gestureRef.current.lastX = e.clientX;
    gestureRef.current.lastY = e.clientY;
  }, []);

  const onMouseMove = useCallback((e: MouseEvent) => {
    if (gestureRef.current.type !== 'drag') return;
    const dx = e.clientX - gestureRef.current.lastX;
    const dy = e.clientY - gestureRef.current.lastY;
    gestureRef.current.lastX = e.clientX;
    gestureRef.current.lastY = e.clientY;
    const n = natRef.current; const circle = ccRef.current;
    setTransform(prev => clampTransform(prev.tx + dx, prev.ty + dy, prev.scale, n, circle));
  }, []);

  const onMouseUp = useCallback(() => { gestureRef.current.type = 'none'; }, []);

  const onWheel = useCallback((e: WheelEvent) => {
    e.preventDefault();
    const n = natRef.current; const circle = ccRef.current;
    if (!circle.r || !n.w) return;
    const minS   = minSRef.current;
    const factor = e.deltaY < 0 ? 1 + WHEEL_SENSITIVITY * 80 : 1 - WHEEL_SENSITIVITY * 80;
    setTransform(prev => {
      const newScale = Math.min(minS * MAX_SCALE_FACTOR, Math.max(minS, prev.scale * factor));
      const sd = newScale / prev.scale;
      return clampTransform(
        e.offsetX - sd * (e.offsetX - prev.tx),
        e.offsetY - sd * (e.offsetY - prev.ty),
        newScale, n, circle,
      );
    });
  }, []);

  // 事件绑定（同 RoomCoverCropModal）
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    stage.addEventListener('touchstart', onTouchStart, { passive: false });
    stage.addEventListener('touchmove',  onTouchMove,  { passive: false });
    stage.addEventListener('touchend',   onTouchEnd);
    stage.addEventListener('mousedown',  onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup',   onMouseUp);
    stage.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      stage.removeEventListener('touchstart', onTouchStart);
      stage.removeEventListener('touchmove',  onTouchMove);
      stage.removeEventListener('touchend',   onTouchEnd);
      stage.removeEventListener('mousedown',  onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup',   onMouseUp);
      stage.removeEventListener('wheel', onWheel);
    };
  }, [onTouchStart, onTouchMove, onTouchEnd, onMouseDown, onMouseMove, onMouseUp, onWheel]);

  // ── 缩放滑块 ─────────────────────────────────────────────────────────────
  const handleSlider = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newScale = Number(e.target.value);
    const n = natRef.current; const circle = ccRef.current;
    setTransform(prev => clampTransform(prev.tx, prev.ty, newScale, n, circle));
  }, []);

  // ── 确认导出 ─────────────────────────────────────────────────────────────
  const handleConfirm = useCallback(async () => {
    if (busy || !imgLoaded || !cc.r) return;
    setBusy(true);
    try {
      let orientedCanvas: HTMLCanvasElement;
      try {
        orientedCanvas = await buildOrientedCanvas(src);
      } catch {
        toast.error('图片解码失败，请重试或更换图片');
        setBusy(false);
        return;
      }
      const file = await exportCroppedFile(orientedCanvas, txRef.current, natRef.current, ccRef.current);
      onConfirm(file);
    } catch (err) {
      console.error('[AvatarCropper] 导出失败', err);
      toast.error('图片处理失败，请重新选择图片');
      setBusy(false);
    }
  }, [busy, imgLoaded, cc.r, src, onConfirm]);

  // ── render ───────────────────────────────────────────────────────────────
  const { tx, ty, scale } = transform;
  const { cx: ccx, cy: ccy, r } = cc;
  const diam = r * 2;

  return (
    <div className="rcc-overlay">
      {/* 顶部操作栏（与 RoomCoverCropModal 结构一致） */}
      <div className="rcc-topbar">
        <button className="rcc-topbar-btn" onClick={onCancel} disabled={busy}>取消</button>
        <span className="rcc-topbar-title">调整头像</span>
        <button
          className="rcc-topbar-btn rcc-topbar-confirm"
          onClick={handleConfirm}
          disabled={busy || !imgLoaded}
        >
          {busy ? '处理中…' : '完成'}
        </button>
      </div>

      {/* 裁剪舞台 */}
      <div className="rcc-stage" ref={stageRef} style={{ touchAction: 'none', cursor: 'grab' }}>
        {/* 图片预览（transformOrigin:'0 0'，与 RoomCover 相同坐标系） */}
        <img
          ref={imgRef}
          src={src}
          alt="头像预览"
          className="rcc-img"
          style={{
            transform: `translate(${tx}px,${ty}px) scale(${scale})`,
            transformOrigin: '0 0',
            opacity: imgLoaded ? 1 : 0,
          }}
          onLoad={handleImgLoad}
          draggable={false}
        />

        {/* 圆外四角半透明遮罩 */}
        {r > 0 && (() => {
          const boxX = ccx - r; const boxY = ccy - r;
          return <>
            <div className="rcc-mask" style={{ top: 0, left: 0, width: '100%', height: boxY }} />
            <div className="rcc-mask" style={{ top: boxY + diam, left: 0, width: '100%', bottom: 0 }} />
            <div className="rcc-mask" style={{ top: boxY, left: 0, width: boxX, height: diam }} />
            <div className="rcc-mask" style={{ top: boxY, left: boxX + diam, right: 0, height: diam }} />
            {/* 圆形边界描边 */}
            <div style={{
              position: 'absolute',
              left: boxX, top: boxY,
              width: diam, height: diam,
              borderRadius: '50%',
              border: '2px solid rgba(255,255,255,0.85)',
              pointerEvents: 'none',
            }} />
          </>;
        })()}

        {!imgLoaded && (
          <div style={{
            position: 'absolute', inset: 0,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: '#aaa', fontSize: 14,
          }}>加载中…</div>
        )}
      </div>

      {/* 缩放滑块 */}
      <div style={{
        padding: '10px 24px 4px',
        display: 'flex', alignItems: 'center', gap: 10,
        background: '#111', flexShrink: 0,
      }}>
        <span style={{ color: '#777', fontSize: 11, whiteSpace: 'nowrap' }}>缩小</span>
        <input
          type="range"
          min={minScale}
          max={maxScale}
          step={(maxScale - minScale) / 200}
          value={scale}
          onChange={handleSlider}
          style={{ flex: 1, accentColor: '#22c55e', cursor: 'pointer', touchAction: 'none' }}
        />
        <span style={{ color: '#777', fontSize: 11, whiteSpace: 'nowrap' }}>放大</span>
      </div>

      {/* 底部提示 + 按钮（适配安全区） */}
      <div className="rcc-hint" style={{ background: '#111', color: '#888' }}>
        单指移动 · 双指缩放 · 滑杆缩放
      </div>
    </div>
  );
}

// ─── 向后兼容别名（旧调用方使用 onClose prop） ─────────────────────────────
export function AvatarCropModalLegacy(props: Omit<Props, 'onCancel'> & { onClose: () => void }) {
  const { onClose, ...rest } = props;
  return <AvatarCropModal {...rest} onCancel={onClose} />;
}
