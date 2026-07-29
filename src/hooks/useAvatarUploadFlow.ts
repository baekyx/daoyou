/**
 * useAvatarUploadFlow
 *
 * 三角色（导游 / 游客 / 摄影师）头像上传共用 hook。
 * 统一处理：文件选择校验、ObjectURL 创建与 revoke、裁剪弹窗控制、
 * 上传到 Supabase Storage、成功/失败中文提示、防重复提交。
 *
 * 使用方式：
 *   const { cropSrc, fileRef, handleFileChange, handleCropConfirm, handleCropClose }
 *     = useAvatarUploadFlow({ userId, onSuccess });
 *
 *   <button onClick={() => fileRef.current?.click()}>更换头像</button>
 *   <input ref={fileRef} type="file" accept={AVATAR_ACCEPT} hidden onChange={handleFileChange} />
 *   {cropSrc && (
 *     <AvatarCropModal src={cropSrc} onConfirm={handleCropConfirm} onCancel={handleCropClose} />
 *   )}
 */
import { useState, useCallback, useRef } from 'react';
import { toast } from 'sonner';
import { uploadAvatarAndSave } from '@/api/users';

/** 允许的图片 MIME 类型 */
export const AVATAR_ACCEPT = 'image/jpeg,image/png,image/webp';
/** 单文件大小上限 10 MB */
export const AVATAR_MAX_BYTES = 10 * 1024 * 1024;

interface Options {
  /** 当前登录用户 ID */
  userId: string | undefined;
  /**
   * 头像上传并写入 profiles 成功后的回调。
   * 参数为含 cache-busting 的新头像 URL。
   */
  onSuccess?: (url: string) => void | Promise<void>;
}

interface AvatarUploadFlow {
  /** 待裁剪的 ObjectURL；非 null 时应渲染 AvatarCropModal */
  cropSrc: string | null;
  /** 绑定到 <input type="file"> 的 ref */
  fileRef: React.RefObject<HTMLInputElement | null>;
  /** onChange 处理函数，绑定到隐藏 input */
  handleFileChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /** AvatarCropModal onConfirm：裁剪完成后上传 */
  handleCropConfirm: (croppedFile: File) => Promise<void>;
  /** AvatarCropModal onCancel：取消裁剪，revoke ObjectURL，保留原头像 */
  handleCropClose: () => void;
  /** 上传进行中标志（可用于禁用保存按钮等） */
  uploading: boolean;
}

export function useAvatarUploadFlow({ userId, onSuccess }: Options): AvatarUploadFlow {
  const [cropSrc, setCropSrc] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  /** 文件选择：校验类型/大小，通过则创建 ObjectURL 并打开裁剪弹窗 */
  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // 重置 input，允许重复选择同一文件
    e.target.value = '';
    if (!file) return;

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
      toast.error('请选择 JPG / PNG / WebP 格式的图片');
      return;
    }
    if (file.size > AVATAR_MAX_BYTES) {
      toast.error('图片大小不能超过 10 MB');
      return;
    }

    // 若上一张 ObjectURL 未释放，先 revoke
    setCropSrc(prev => {
      if (prev) URL.revokeObjectURL(prev);
      return URL.createObjectURL(file);
    });
  }, []);

  /** 裁剪确认：上传至 Supabase Storage 并写入 profiles.avatar_url */
  const handleCropConfirm = useCallback(async (croppedFile: File) => {
    if (!userId || uploading) return;

    // 关闭裁剪弹窗（同时 ObjectURL 将在下方 revoke）
    setCropSrc(prev => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });

    setUploading(true);
    toast.loading('头像上传中…', { id: 'avatar-upload' });

    try {
      const url = await uploadAvatarAndSave(userId, croppedFile);
      if (url) {
        toast.success('头像已更新', { id: 'avatar-upload' });
        await onSuccess?.(url);
      } else {
        toast.error('头像上传失败，请重试', { id: 'avatar-upload' });
      }
    } catch {
      toast.error('头像上传出错，请检查网络后重试', { id: 'avatar-upload' });
    } finally {
      setUploading(false);
    }
  }, [userId, uploading, onSuccess]);

  /** 取消裁剪：释放 ObjectURL，不改变现有头像 */
  const handleCropClose = useCallback(() => {
    setCropSrc(prev => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  }, []);

  return { cropSrc, fileRef, handleFileChange, handleCropConfirm, handleCropClose, uploading };
}
