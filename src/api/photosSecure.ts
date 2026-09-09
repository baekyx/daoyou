/**
 * photosSecure.ts — 照片安全读取层（A3-3）
 *
 * fetchPhotosSafe()：通过 RPC get_room_photos() 读取，
 *   权限：该房导游 OR 有效 room_members OR approved photographer（memberships）。
 *   返回摄影者公开字段（nickname/username/avatar），不含 phone/gender/微信字段。
 *   支持分页（limit 1-200，游标 before）。
 *
 * 旧 fetchPhotos()（photos.ts）：暂保留为兼容层（被 PhotographerScreens.tsx 读取摄影师本人照片），
 * 列入 Cutover 清单，待 photos SELECT policy 收紧后替换。
 *
 * Cutover 待撤销：
 *   - photos 表 `photos: 任何已登录可查看` SELECT policy（roles=authenticated, qual=true）
 *   - photos.ts 中 fetchPhotos() 的直接表查询
 */
import { supabase } from "@/db/supabase";
import type { Photo } from "@/types/types";

export interface PhotoWithPhotographer extends Photo {
  photographer_nickname: string | null;
  photographer_username: string | null;
  photographer_avatar: string | null;
}

/**
 * 安全读取房间照片（通过 SECURITY DEFINER RPC）
 * @param roomId  房间 ID
 * @param limit   条数上限 1-200，默认 50
 * @param before  游标：只返回此 uploaded_at 之前的记录（可选）
 */
export async function fetchPhotosSafe(
  roomId: string,
  limit = 50,
  before?: string
): Promise<PhotoWithPhotographer[]> {
  const { data, error } = await supabase.rpc("get_room_photos", {
    p_room_id: roomId,
    p_limit: Math.min(Math.max(limit, 1), 200),
    p_before: before ?? null,
  });
  if (error || !data) return [];
  return Array.isArray(data) ? (data as PhotoWithPhotographer[]) : [];
}

/** 严格读取版：保留请求错误，供需要展示失败状态的管理页面使用。 */
export async function fetchPhotosSafeStrict(
  roomId: string,
  limit = 50,
  before?: string
): Promise<PhotoWithPhotographer[]> {
  const { data, error } = await supabase.rpc("get_room_photos", {
    p_room_id: roomId,
    p_limit: Math.min(Math.max(limit, 1), 200),
    p_before: before ?? null,
  });
  if (error) throw new Error(error.message || "照片读取失败");
  return Array.isArray(data) ? (data as PhotoWithPhotographer[]) : [];
}
