import { supabase } from "@/db/supabase";
import type { Profile } from "@/types/types";

/** 获取当前用户 profile（仅读取非敏感字段，禁止读取 wechat_pwd / wechat_openid 等凭据列） */
export async function fetchProfile(userId: string): Promise<Profile | null> {
  const { data } = await supabase
    .from("profiles")
    .select("id, username, nickname, avatar_url, phone, role, gender, created_at, updated_at")
    .eq("id", userId)
    .maybeSingle();
  return data;
}

/** 更新 profile（昵称/头像/手机号/性别） */
export async function updateProfile(
  userId: string,
  updates: Partial<Pick<Profile, "nickname" | "avatar_url" | "phone" | "gender">>
): Promise<{ error: string | null }> {
  const { data, error } = await supabase
    .from("profiles")
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq("id", userId)
    .select("id")
    .maybeSingle();
  if (error) return { error: error.message };
  if (!data) return { error: "资料不存在、无更新权限或修改未写入" };
  return { error: null };
}

/**
 * 上传头像，返回附带 cache-busting 时间戳的公开 URL。
 * 固定路径 userId/avatar.jpg（upsert 覆盖同一路径，同一用户不会堆积旧文件）。
 * 裁剪层已保证输入是 512×512 JPEG；此处只负责上传与返回 URL。
 */
export async function uploadAvatar(userId: string, file: File): Promise<string | null> {
  // 固定路径：userId/avatar.jpg，upsert 覆盖旧头像
  const path = `${userId}/avatar.jpg`;
  const { data, error } = await supabase.storage
    .from("avatars")
    .upload(path, file, { upsert: true, contentType: "image/jpeg" });
  if (error || !data) {
    console.error("[Avatar] 上传失败", error);
    return null;
  }
  const { data: urlData } = supabase.storage.from("avatars").getPublicUrl(data.path);
  // cache-busting：追加时间戳，防止浏览器缓存旧头像
  return `${urlData.publicUrl}?t=${Date.now()}`;
}

/**
 * 上传头像并同步更新 profiles.avatar_url，返回最终 URL（含 cache-busting）。
 * 调用方只需处理成功/失败，不需要额外 updateProfile。
 */
export async function uploadAvatarAndSave(userId: string, file: File): Promise<string | null> {
  const url = await uploadAvatar(userId, file);
  if (!url) return null;
  const { error } = await updateProfile(userId, { avatar_url: url });
  if (error) {
    console.error("[Avatar] profile 写入失败", error);
    return null;
  }
  return url;
}

/** 更新用户角色（通过 SECURITY DEFINER 函数绕过 RLS）——仅用于首次注册 */
export async function updateRole(userId: string, role: string): Promise<{ error: string | null }> {
  const { error } = await supabase.rpc("set_my_role", { new_role: role });
  // userId 参数由 RLS 函数内部通过 auth.uid() 确定，无需传入
  void userId;
  return { error: error?.message ?? null };
}

/**
 * 已登录用户身份切换（仅供 IdentityAccount 共享组件调用）。
 * 调用独立 switch_my_role RPC，与首次注册的 set_my_role 完全分离。
 * 返回 { role: 切换后的角色, error: 错误信息 }
 */
export async function switchRole(newRole: string): Promise<{ role: string | null; error: string | null }> {
  const { data, error } = await supabase.rpc("switch_my_role", { p_role: newRole });
  if (error) {
    // 将后端异常消息转换为友好中文提示
    const msg = error.message ?? '';
    let friendly = '身份切换失败，请稍后重试';
    if (msg.includes('非法身份值')) friendly = '不支持的身份类型';
    else if (msg.includes('未登录')) friendly = '请先登录后再切换身份';
    else if (msg.includes('profile 不存在')) friendly = '账号信息异常，请重新登录';
    else if (msg) friendly = msg;
    return { role: null, error: friendly };
  }
  return { role: data as string, error: null };
}
export async function registerUser(
  username: string,
  password: string,
  role: string
): Promise<{ session: unknown; error: string | null }> {
  const { data, error } = await supabase.functions.invoke("register-user", {
    body: { username, password, role },
    method: "POST",
  });
  if (error) {
    const msg = await error?.context?.text?.();
    let parsed = msg;
    try {
      parsed = JSON.parse(msg ?? "")?.error ?? msg;
    } catch { /* ignore */ }
    return { session: null, error: parsed ?? error.message };
  }
  return { session: data?.session ?? null, error: null };
}
