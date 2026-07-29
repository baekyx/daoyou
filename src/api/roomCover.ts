/**
 * roomCover.ts — 房间封面上传
 *
 * 上传流程：
 *   1. 调用方（RoomCoverCropModal）裁剪 + 压缩完成后，传入已满足 < 4.8 MiB 的 JPEG Blob
 *   2. 此处仅负责上传到 room-covers/{guideId}/{roomId}.jpg，upsert 覆盖旧封面
 *   3. 返回带 cache-busting 时间戳的公开 URL
 *
 * 故意不在此处做压缩，保持职责单一（便于测试 compressRoomCoverBlob）。
 */
import { supabase } from "@/db/supabase";

const BUCKET = "room-covers";

/**
 * 上传房间封面 Blob。
 * 固定路径 {guideId}/{roomId}.jpg，upsert 覆盖同一路径旧文件。
 * 返回带 cache-busting 的公开 URL；失败返回 null。
 */
export async function uploadRoomCoverBlob(
  guideId: string,
  roomId: string,
  blob: Blob,
): Promise<string | null> {
  const path = `${guideId}/${roomId}.jpg`;
  const { data, error } = await supabase.storage
    .from(BUCKET)
    .upload(path, blob, { upsert: true, contentType: "image/jpeg" });
  if (error || !data) {
    console.error("[RoomCover] 上传失败", error);
    return null;
  }
  const { data: urlData } = supabase.storage.from(BUCKET).getPublicUrl(data.path);
  return `${urlData.publicUrl}?t=${Date.now()}`;
}
