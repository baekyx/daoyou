import { supabase } from "@/db/supabase";
import type { Photo, Favorite } from "@/types/types";

// ===== 照片 =====
export async function fetchPhotos(roomId: string): Promise<Photo[]> {
  const { data } = await supabase
    .from("photos")
    .select("*, photographer:profiles!photos_photographer_id_fkey(id,username,nickname)")
    .eq("room_id", roomId)
    .order("uploaded_at", { ascending: false })
    .limit(200);
  return Array.isArray(data) ? data : [];
}

export async function uploadPhoto(
  roomId: string,
  photographerId: string,
  file: File
): Promise<{ photo: Photo | null; error: string | null }> {
  const ext = file.name.split(".").pop() ?? "jpg";
  const safeName = `${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`;
  const path = `${roomId}/${photographerId}/${safeName}`;

  const { data: storageData, error: storageError } = await supabase.storage
    .from("photos")
    .upload(path, file, { contentType: file.type });

  if (storageError || !storageData) {
    return { photo: null, error: storageError?.message ?? "上传失败" };
  }

  const { data: urlData } = supabase.storage.from("photos").getPublicUrl(storageData.path);

  const { data, error } = await supabase
    .from("photos")
    .insert({
      room_id: roomId,
      photographer_id: photographerId,
      url: urlData.publicUrl,
    })
    .select()
    .maybeSingle();

  return { photo: data, error: error?.message ?? null };
}

// ===== 收藏 =====
export async function fetchFavorites(userId: string): Promise<Favorite[]> {
  const { data } = await supabase
    .from("favorites")
    .select("*")
    .eq("user_id", userId)
    .order("created_at", { ascending: false })
    .limit(100);
  return Array.isArray(data) ? data : [];
}

export async function toggleFavorite(
  userId: string,
  targetType: "subtitle" | "photo",
  targetId: string,
  isFav: boolean
): Promise<{ error: string | null }> {
  if (isFav) {
    const { error } = await supabase
      .from("favorites")
      .delete()
      .eq("user_id", userId)
      .eq("target_type", targetType)
      .eq("target_id", targetId);
    return { error: error?.message ?? null };
  } else {
    const { error } = await supabase
      .from("favorites")
      .insert({ user_id: userId, target_type: targetType, target_id: targetId });
    return { error: error?.message ?? null };
  }
}
