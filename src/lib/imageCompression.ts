export type UploadQuality = 'original' | 'hd' | 'standard';

export const UPLOAD_QUALITY_OPTIONS: Array<{
  value: UploadQuality;
  label: string;
  description: string;
}> = [
  { value: 'original', label: '原图', description: '不压缩，保留原始尺寸与画质' },
  { value: 'hd', label: '高清', description: '最长边 1920px，适合大屏浏览' },
  { value: 'standard', label: '标准', description: '最长边 1280px，上传更快、更省流量' },
];

export function readUploadQuality(): UploadQuality {
  const stored = localStorage.getItem('shiguang-upload-quality');
  if (stored === 'original' || stored === 'hd' || stored === 'standard') return stored;
  // 兼容旧版“省流”设置。
  if (stored === 'economy') return 'standard';
  return 'hd';
}

export function formatFileSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('无法读取图片'));
    };
    image.src = url;
  });
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error('图片压缩失败'));
    }, type, quality);
  });
}

export async function prepareImageForUpload(
  file: File,
  quality: UploadQuality,
): Promise<{ file: File; compressed: boolean }> {
  if (quality === 'original') return { file, compressed: false };

  const image = await loadImage(file);
  const maxEdge = quality === 'hd' ? 1920 : 1280;
  const longestEdge = Math.max(image.naturalWidth, image.naturalHeight);
  const scale = Math.min(1, maxEdge / Math.max(1, longestEdge));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('当前浏览器不支持图片压缩');

  // JPEG 不支持透明通道，先铺白底，避免透明 PNG 压缩后出现黑底。
  context.fillStyle = '#fff';
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);

  const outputQuality = quality === 'hd' ? 0.88 : 0.78;
  const blob = await canvasToBlob(canvas, 'image/jpeg', outputQuality);
  // 小图或本身已高度压缩时，不使用体积更大的转换结果。
  if (blob.size >= file.size) return { file, compressed: false };

  const baseName = file.name.replace(/\.[^.]+$/, '') || 'photo';
  return {
    file: new File([blob], `${baseName}-${quality}.jpg`, {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    }),
    compressed: true,
  };
}
