/**
 * 景区卡片图片上传。
 *
 * 路径固定为 card-images/{guideId}/{cardId}.jpg，编辑时覆盖原图，
 * 避免重复上传产生无主文件。调用方负责在上传前完成 16:9 裁剪与压缩。
 */
import { supabase } from '@/db/supabase';

const BUCKET = 'card-images';

export async function uploadCardImageBlob(
  guideId: string,
  cardId: string,
  blob: Blob,
): Promise<{ url: string | null; error: string | null }> {
  const path = `${guideId}/${cardId}.jpg`;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, {
      upsert: true,
      contentType: 'image/jpeg',
      cacheControl: '3600',
    });

  if (error || !data) {
    console.error('[CardImage] 上传失败', error);
    return { url: null, error: error?.message ?? '图片上传失败' };
  }

  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
  return {
    url: `${urlData.publicUrl}?t=${Date.now()}`,
    error: null,
  };
}
