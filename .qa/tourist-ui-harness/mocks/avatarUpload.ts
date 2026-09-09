import { useRef } from 'react';

export const AVATAR_ACCEPT = 'image/jpeg,image/png,image/webp';

export function useAvatarUploadFlow() {
  return {
    cropSrc: null,
    fileRef: useRef<HTMLInputElement>(null),
    handleFileChange: () => undefined,
    handleCropConfirm: async () => undefined,
    handleCropClose: () => undefined,
    uploading: false,
  };
}
