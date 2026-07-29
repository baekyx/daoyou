/**
 * delete-account Edge Function — 通用三角色硬注销 v2
 * 仅删除当前 JWT 对应 auth.uid() 的账号及其全部关联数据。
 * 绝不接受前端传入任意 user_id 或 role。
 *
 * ──────────────────────────────────────────────────────────────
 * 真实 Storage buckets（经迁移文件和上传代码核实，无猜测）：
 *
 *   avatars     路径: {uid}/avatar.jpg（固定，upsert 覆盖）
 *               归属: profiles.avatar_url
 *               注意: /avatars/*.webp 是本地 public/ 静态文件，不在此 bucket，不删
 *
 *   room-covers 路径: {guideId}/{roomId}.{ext}
 *               归属: rooms.cover_url，rooms.guide_id = uid
 *               路径首段 = guideId，可从 rooms 表直接构造
 *
 *   photos      路径: {roomId}/{photographerId}/{filename}
 *               归属: photos.url（URL 正则提取相对路径）
 *               已在 v1 中实现，保持不变
 *
 *   audio       路径: {roomId}/{timestamp}_audio.webm
 *               归属: subtitles.chinese_audio_url（非空且属于导游的房间）
 *               路径首段 = roomId，不含用户 ID，通过 rooms.guide_id 间接归属
 *               注意: audio_url 为英文 TTS（Edge Function 生成），不属于用户上传内容，不删
 *               注意: subtitles 表 room_id → rooms(id) ON DELETE CASCADE，
 *                     删 rooms 前必须先收集并删除 Storage 文件
 *
 * ──────────────────────────────────────────────────────────────
 * 删除顺序（fail-closed：任一步骤出错立即返回 500）：
 *
 *   所有角色：
 *     0.  avatars Storage 文件（路径固定：{uid}/avatar.jpg）
 *
 *   导游专属（必须在删 rooms 之前收集文件路径）：
 *     1.  查询 rooms WHERE guide_id=uid → 收集 roomIds、cover_url 路径
 *     2.  查询 subtitles WHERE room_id IN roomIds → 收集 chinese_audio_url 路径
 *     3.  删除 room-covers Storage 文件（cover_url 字段提取相对路径）
 *     4.  删除 audio Storage 文件（chinese_audio_url 字段提取相对路径，跳过空值）
 *     5.  查询 photos WHERE room_id IN roomIds → 删除 photos Storage 文件
 *     6.  删除 photos 表行（room_id IN roomIds）
 *     7.  删除 knowledge_cards（created_by=uid，无 CASCADE）
 *     8.  删除 rooms 行（CASCADE 自动删：subtitles/questions/card_pushes/
 *                        room_members/room_barrages/room_cards/
 *                        room_secrets/room_join_rate_limits）
 *
 *   所有角色公共清理（不含已被导游 rooms CASCADE 删除的表）：
 *     9.  photos Storage + photos 表（photographer_id=uid）
 *     10. room_members（user_id=uid）
 *     11. memberships（user_id=uid）
 *     12. room_barrages（user_id=uid）
 *     13. questions（user_id=uid）
 *     14. favorites（user_id=uid）
 *     15. card_pushes（pushed_by=uid）
 *     16. feedbacks（user_id=uid）
 *     17. knowledge_cards（created_by=uid，非导游角色）
 *     18. wechat_identities（user_id=uid）
 *     19. profiles（id=uid）
 *     20. auth.users（最后，不可逆）
 *
 * 对外正式发布前需由产品方补充真实运营主体名称、注册地址和有效联系方式。
 */
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const PHOTOS_BUCKET = "photos";
const AVATARS_BUCKET = "avatars";
const ROOM_COVERS_BUCKET = "room-covers";
const AUDIO_BUCKET = "audio";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function err500(msg: string): Response {
  return new Response(
    JSON.stringify({ error: msg }),
    { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

/**
 * 从完整 Supabase Storage 公开 URL 中提取 bucket 后的相对路径。
 * 匹配格式: .../storage/v1/object/public/{bucket}/{relPath}
 * 返回 null 表示无法解析（空值、外部 CDN、默认静态图），调用方跳过该条目。
 */
function extractStoragePath(url: string | null | undefined, bucket: string): string | null {
  if (!url || !url.includes("/storage/v1/")) return null;
  const marker = `/object/public/${bucket}/`;
  const idx = url.indexOf(marker);
  if (idx === -1) return null;
  const raw = url.slice(idx + marker.length);
  // 去掉 cache-busting 参数（?t=...）
  const path = raw.split("?")[0];
  return path ? decodeURIComponent(path) : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // ── 1. JWT 验证，获取 uid ──────────────────────────────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "未授权" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "认证失败，请重新登录" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const uid = user.id;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // ── 2. 查询用户角色（服务端读取，不信任前端） ──────────────────
  const { data: profileRow, error: profileFetchErr } = await admin
    .from("profiles")
    .select("role")
    .eq("id", uid)
    .single();
  if (profileFetchErr) {
    return err500(`查询用户角色失败，注销已中止: ${profileFetchErr.message}`);
  }
  const role = profileRow?.role as string | null;

  // ── 0. 所有角色：删除头像 Storage 文件 ────────────────────────
  // 路径固定：{uid}/avatar.jpg（uploadAvatarFile 函数中 upsert 固定此路径）
  // 仅删除 Supabase avatars bucket 中用户自己的文件；
  // 本地 public/avatars/*.webp 默认图不在 bucket 中，不做任何操作
  const avatarPath = `${uid}/avatar.jpg`;
  const { error: avatarStorageErr } = await admin.storage
    .from(AVATARS_BUCKET)
    .remove([avatarPath]);
  // 头像文件可能从未上传（用户使用默认图），此时 remove 返回的 error 为
  // "Object not found"，属于正常情况，不视为 fail-closed 错误
  if (avatarStorageErr && !avatarStorageErr.message.includes("not found")) {
    return err500(`头像 Storage 文件删除失败，注销已中止: ${avatarStorageErr.message}`);
  }

  // ── 3. 导游专属清理（必须在删 rooms 之前收集文件定位信息） ──────
  if (role === "guide") {
    // 3-1. 查询导游所有房间
    const { data: rooms, error: roomsFetchErr } = await admin
      .from("rooms")
      .select("id, cover_url")
      .eq("guide_id", uid);
    if (roomsFetchErr) {
      return err500(`查询导游房间失败，注销已中止: ${roomsFetchErr.message}`);
    }
    const roomList = rooms ?? [];
    const roomIds = roomList.map((r: { id: string }) => r.id);

    if (roomIds.length > 0) {
      // 3-2. 收集房间封面路径（cover_url → 相对路径）
      //      路径格式：{guideId}/{roomId}.{ext}，从 URL 提取
      const coverPaths: string[] = [];
      for (const room of roomList) {
        const p = extractStoragePath(
          (room as { id: string; cover_url: string | null }).cover_url,
          ROOM_COVERS_BUCKET
        );
        if (p) coverPaths.push(p);
      }

      // 3-3. 收集音频路径（subtitles.chinese_audio_url，跳过空值和外部 URL）
      //      路径格式：{roomId}/{timestamp}_audio.webm，从 URL 提取
      //      audio_url（英文 TTS）属于系统生成内容，不是用户上传，不删除
      const { data: subtitleRows, error: subtitleFetchErr } = await admin
        .from("subtitles")
        .select("chinese_audio_url")
        .in("room_id", roomIds)
        .neq("chinese_audio_url", "");
      if (subtitleFetchErr) {
        return err500(`查询字幕音频失败，注销已中止: ${subtitleFetchErr.message}`);
      }
      const audioPaths: string[] = [];
      for (const row of (subtitleRows ?? [])) {
        const p = extractStoragePath(
          (row as { chinese_audio_url: string }).chinese_audio_url,
          AUDIO_BUCKET
        );
        if (p) audioPaths.push(p);
      }

      // 3-4. 查询房间内所有照片 URL（必须在删 rooms 前，rooms CASCADE 会先删 photos 关联）
      // 注意：photos 表 room_id → rooms(id) ON DELETE CASCADE，
      //       删 rooms 后 photos 行消失，Storage 文件孤儿残留；所以必须先删 Storage
      const { data: roomPhotos, error: roomPhotosFetchErr } = await admin
        .from("photos")
        .select("url")
        .in("room_id", roomIds);
      if (roomPhotosFetchErr) {
        return err500(`查询房间照片失败，注销已中止: ${roomPhotosFetchErr.message}`);
      }
      const roomPhotoPaths: string[] = [];
      for (const p of (roomPhotos ?? [])) {
        const path = extractStoragePath(
          (p as { url: string }).url,
          PHOTOS_BUCKET
        );
        if (path) roomPhotoPaths.push(path);
      }

      // 3-5. 删除 room-covers Storage 文件
      if (coverPaths.length > 0) {
        const { error: coverStorageErr } = await admin.storage
          .from(ROOM_COVERS_BUCKET)
          .remove(coverPaths);
        if (coverStorageErr) {
          return err500(`room-covers Storage 删除失败，注销已中止: ${coverStorageErr.message}`);
        }
      }

      // 3-6. 删除 audio Storage 文件（仅 chinese_audio_url，即导游/ASR 产生的原声录音）
      if (audioPaths.length > 0) {
        const { error: audioStorageErr } = await admin.storage
          .from(AUDIO_BUCKET)
          .remove(audioPaths);
        if (audioStorageErr) {
          return err500(`audio Storage 删除失败，注销已中止: ${audioStorageErr.message}`);
        }
      }

      // 3-7. 删除房间内照片 Storage 文件（摄影师上传，属于该房间）
      if (roomPhotoPaths.length > 0) {
        const { error: roomPhotosStorageErr } = await admin.storage
          .from(PHOTOS_BUCKET)
          .remove(roomPhotoPaths);
        if (roomPhotosStorageErr) {
          return err500(`房间照片 Storage 删除失败，注销已中止: ${roomPhotosStorageErr.message}`);
        }
      }

      // 3-8. 删除 photos 表行（room_id IN roomIds）
      const { error: roomPhotosDelErr } = await admin
        .from("photos")
        .delete()
        .in("room_id", roomIds);
      if (roomPhotosDelErr) {
        return err500(`photos 表删除失败，注销已中止: ${roomPhotosDelErr.message}`);
      }

      // 3-9. 删除 knowledge_cards（created_by=uid，无 ON DELETE CASCADE，需手动删）
      const { error: kcErr } = await admin
        .from("knowledge_cards")
        .delete()
        .eq("created_by", uid);
      if (kcErr) {
        return err500(`knowledge_cards 表删除失败，注销已中止: ${kcErr.message}`);
      }

      // 3-10. 删除 rooms 行（CASCADE 自动删除：subtitles / questions / card_pushes /
      //        room_members / room_barrages / room_cards / room_secrets / room_join_rate_limits）
      const { error: roomsDelErr } = await admin
        .from("rooms")
        .delete()
        .eq("guide_id", uid);
      if (roomsDelErr) {
        return err500(`rooms 表删除失败，注销已中止: ${roomsDelErr.message}`);
      }
    } else {
      // 无房间，仍需清理 knowledge_cards
      const { error: kcErr } = await admin
        .from("knowledge_cards")
        .delete()
        .eq("created_by", uid);
      if (kcErr) {
        return err500(`knowledge_cards 表删除失败，注销已中止: ${kcErr.message}`);
      }
    }
  }

  // ── 4. 所有角色公共清理 ────────────────────────────────────────

  // 4-1. photos Storage + photos 表（摄影师自己上传的照片）
  const { data: ownPhotos, error: ownPhotosFetchErr } = await admin
    .from("photos")
    .select("url")
    .eq("photographer_id", uid);
  if (ownPhotosFetchErr) {
    return err500(`查询本人照片失败，注销已中止: ${ownPhotosFetchErr.message}`);
  }
  if (Array.isArray(ownPhotos) && ownPhotos.length > 0) {
    const paths: string[] = [];
    for (const p of ownPhotos) {
      const path = extractStoragePath((p as { url: string }).url, PHOTOS_BUCKET);
      if (path) paths.push(path);
    }
    if (paths.length > 0) {
      const { error: storageErr } = await admin.storage
        .from(PHOTOS_BUCKET)
        .remove(paths);
      if (storageErr) {
        return err500(`photos Storage 删除失败，注销已中止: ${storageErr.message}`);
      }
    }
    const { error: photosDelErr } = await admin
      .from("photos")
      .delete()
      .eq("photographer_id", uid);
    if (photosDelErr) {
      return err500(`photos 表删除失败，注销已中止: ${photosDelErr.message}`);
    }
  }

  // 4-2. room_members
  const { error: membersErr } = await admin
    .from("room_members")
    .delete()
    .eq("user_id", uid);
  if (membersErr) {
    return err500(`room_members 表删除失败，注销已中止: ${membersErr.message}`);
  }

  // 4-3. memberships
  const { error: membershipsErr } = await admin
    .from("memberships")
    .delete()
    .eq("user_id", uid);
  if (membershipsErr) {
    return err500(`memberships 表删除失败，注销已中止: ${membershipsErr.message}`);
  }

  // 4-4. room_barrages
  const { error: barragesErr } = await admin
    .from("room_barrages")
    .delete()
    .eq("user_id", uid);
  if (barragesErr) {
    return err500(`room_barrages 表删除失败，注销已中止: ${barragesErr.message}`);
  }

  // 4-5. questions
  const { error: questionsErr } = await admin
    .from("questions")
    .delete()
    .eq("user_id", uid);
  if (questionsErr) {
    return err500(`questions 表删除失败，注销已中止: ${questionsErr.message}`);
  }

  // 4-6. favorites
  const { error: favoritesErr } = await admin
    .from("favorites")
    .delete()
    .eq("user_id", uid);
  if (favoritesErr) {
    return err500(`favorites 表删除失败，注销已中止: ${favoritesErr.message}`);
  }

  // 4-7. card_pushes
  const { error: cardPushesErr } = await admin
    .from("card_pushes")
    .delete()
    .eq("pushed_by", uid);
  if (cardPushesErr) {
    return err500(`card_pushes 表删除失败，注销已中止: ${cardPushesErr.message}`);
  }

  // 4-8. feedbacks
  const { error: feedbacksErr } = await admin
    .from("feedbacks")
    .delete()
    .eq("user_id", uid);
  if (feedbacksErr) {
    return err500(`feedbacks 表删除失败，注销已中止: ${feedbacksErr.message}`);
  }

  // 4-9. knowledge_cards（非导游角色若有创建）
  if (role !== "guide") {
    const { error: kcErr } = await admin
      .from("knowledge_cards")
      .delete()
      .eq("created_by", uid);
    if (kcErr) {
      return err500(`knowledge_cards 表删除失败，注销已中止: ${kcErr.message}`);
    }
  }

  // 4-10. wechat_identities
  const { error: wechatErr } = await admin
    .from("wechat_identities")
    .delete()
    .eq("user_id", uid);
  if (wechatErr) {
    return err500(`wechat_identities 表删除失败，注销已中止: ${wechatErr.message}`);
  }

  // 4-11. profiles
  const { error: profilesErr } = await admin
    .from("profiles")
    .delete()
    .eq("id", uid);
  if (profilesErr) {
    return err500(`profiles 表删除失败，注销已中止: ${profilesErr.message}`);
  }

  // ── 5. 全部关联数据确认删除后，最后删除 auth.users（不可逆） ───
  const { error: deleteUserErr } = await admin.auth.admin.deleteUser(uid);
  if (deleteUserErr) {
    return err500(`auth.users 删除失败: ${deleteUserErr.message}`);
  }

  return new Response(
    JSON.stringify({ success: true }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
 *
 * 真实表结构（全部经迁移文件核实）：
 *   profiles        id PK → auth.users(id) ON DELETE CASCADE
 *   rooms           guide_id → profiles(id) ON DELETE CASCADE
 *   room_members    user_id → profiles(id) ON DELETE CASCADE
 *   room_barrages   user_id → profiles(id) ON DELETE CASCADE
 *   questions       user_id → profiles(id) ON DELETE CASCADE
 *   photos          photographer_id → profiles(id) ON DELETE CASCADE
 *   favorites       user_id → profiles(id) ON DELETE CASCADE
 *   feedbacks       user_id → auth.users(id) ON DELETE CASCADE
 *   memberships     user_id → auth.users(id) ON DELETE CASCADE
 *   cards           created_by → profiles(id) ON DELETE CASCADE
 *   card_pushes     pushed_by → profiles(id) ON DELETE CASCADE
 *   knowledge_cards created_by → auth.users(id)（无 CASCADE，需手动删除）
 *   room_cards      room_id → rooms(id) ON DELETE CASCADE（随 rooms 级联）
 *   room_secrets    room_id → rooms(id) ON DELETE CASCADE（随 rooms 级联）
 *   room_join_rate_limits room_id → rooms(id) ON DELETE CASCADE（随 rooms 级联）
 *   subtitles       room_id → rooms(id) ON DELETE CASCADE（随 rooms 级联）
 *   wechat_identities user_id → auth.users(id) ON DELETE CASCADE
 *
 * 清理顺序（fail-closed：任一步骤出错立即返回 500）：
 *   导游角色额外清理：
 *     A. 查询并删除 photos Storage 文件（该导游房间内摄影师的照片）
 *     B. photos 表行（room_id IN 导游的 rooms）
 *     C. knowledge_cards 表行（created_by=uid，无 CASCADE 需手动删）
 *     D. rooms 表行（CASCADE 会自动删除 subtitles/questions/card_pushes/
 *                    room_members/room_barrages/room_cards/room_secrets/
 *                    room_join_rate_limits）
 *   所有角色公共清理：
 *     E. photos 表行（photographer_id=uid，摄影师上传的照片行）
 *     F. photos Storage 文件（photographer_id=uid 的 Storage 文件）
 *     G. room_members 表行（user_id=uid）
 *     H. memberships 表行（user_id=uid）
 *     I. room_barrages 表行（user_id=uid）
 *     J. questions 表行（user_id=uid）
 *     K. favorites 表行（user_id=uid）
 *     L. card_pushes 表行（pushed_by=uid）
 *     M. feedbacks 表行（user_id=uid）
 *     N. knowledge_cards 表行（created_by=uid，非导游也可能创建）
 *     O. wechat_identities 表行（user_id=uid）
 *     P. profiles 表行（id=uid）
 *     Q. auth.users（最后，不可逆）
 *
 * 对外正式发布前需由产品方补充真实运营主体名称、注册地址和有效联系方式。
 */
import { createClient } from "npm:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
const PHOTOS_BUCKET = "photos";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/** 统一 500 响应 */
function err500(msg: string): Response {
  return new Response(
    JSON.stringify({ error: msg }),
    { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // ── 1. 从 Authorization header 提取 JWT，确认身份 ──────────────
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return new Response(JSON.stringify({ error: "未授权" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const userClient = createClient(SUPABASE_URL, ANON_KEY, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user }, error: authErr } = await userClient.auth.getUser();
  if (authErr || !user) {
    return new Response(JSON.stringify({ error: "认证失败，请重新登录" }), {
      status: 401,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const uid = user.id;

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  // ── 2. 查询当前用户角色（从 profiles 真实字段读取，禁止信任前端传入） ──
  const { data: profileRow, error: profileFetchErr } = await admin
    .from("profiles")
    .select("role")
    .eq("id", uid)
    .single();
  if (profileFetchErr) {
    return err500(`查询用户角色失败，注销已中止: ${profileFetchErr.message}`);
  }
  const role = profileRow?.role as string | null;

  // ── 3. 导游专属：删除其创建的房间下所有照片 Storage 文件 + photos 行 + rooms ──
  if (role === "guide") {
    // 3a. 查询该导游创建的所有房间 ID
    const { data: rooms, error: roomsFetchErr } = await admin
      .from("rooms")
      .select("id")
      .eq("guide_id", uid);
    if (roomsFetchErr) {
      return err500(`查询导游房间失败，注销已中止: ${roomsFetchErr.message}`);
    }
    const roomIds = (rooms ?? []).map((r: { id: string }) => r.id);

    if (roomIds.length > 0) {
      // 3b. 查询这些房间内所有照片的 URL（用于删除 Storage 文件）
      const { data: roomPhotos, error: roomPhotosFetchErr } = await admin
        .from("photos")
        .select("url")
        .in("room_id", roomIds);
      if (roomPhotosFetchErr) {
        return err500(`查询房间照片失败，注销已中止: ${roomPhotosFetchErr.message}`);
      }

      // 3c. 删除 Storage 文件
      const storagePaths: string[] = [];
      for (const p of (roomPhotos ?? [])) {
        const match = p.url?.match(/\/photos\/(.+)$/);
        if (match?.[1]) storagePaths.push(decodeURIComponent(match[1]));
      }
      if (storagePaths.length > 0) {
        const { error: storageErr } = await admin.storage
          .from(PHOTOS_BUCKET)
          .remove(storagePaths);
        if (storageErr) {
          return err500(`Storage 文件删除失败，注销已中止: ${storageErr.message}`);
        }
      }

      // 3d. 删除 photos 表行（room_id IN 导游房间）
      const { error: roomPhotosDelErr } = await admin
        .from("photos")
        .delete()
        .in("room_id", roomIds);
      if (roomPhotosDelErr) {
        return err500(`photos 表删除失败，注销已中止: ${roomPhotosDelErr.message}`);
      }

      // 3e. 删除 knowledge_cards（created_by=uid，无 CASCADE，需手动删除）
      const { error: kcErr } = await admin
        .from("knowledge_cards")
        .delete()
        .eq("created_by", uid);
      if (kcErr) {
        return err500(`knowledge_cards 表删除失败，注销已中止: ${kcErr.message}`);
      }

      // 3f. 删除 rooms 行（CASCADE 自动删除：subtitles, questions, card_pushes,
      //      room_members, room_barrages, room_cards, room_secrets, room_join_rate_limits）
      const { error: roomsDelErr } = await admin
        .from("rooms")
        .delete()
        .eq("guide_id", uid);
      if (roomsDelErr) {
        return err500(`rooms 表删除失败，注销已中止: ${roomsDelErr.message}`);
      }
    } else {
      // 无房间，仍需清理 knowledge_cards
      const { error: kcErr } = await admin
        .from("knowledge_cards")
        .delete()
        .eq("created_by", uid);
      if (kcErr) {
        return err500(`knowledge_cards 表删除失败，注销已中止: ${kcErr.message}`);
      }
    }
  }

  // ── 4. 所有角色公共清理 ────────────────────────────────────────

  // 4a. photos Storage + photos 表（摄影师自己上传的）
  const { data: ownPhotos, error: ownPhotosFetchErr } = await admin
    .from("photos")
    .select("url")
    .eq("photographer_id", uid);
  if (ownPhotosFetchErr) {
    return err500(`查询本人照片失败，注销已中止: ${ownPhotosFetchErr.message}`);
  }
  if (Array.isArray(ownPhotos) && ownPhotos.length > 0) {
    const paths: string[] = [];
    for (const p of ownPhotos) {
      const match = p.url?.match(/\/photos\/(.+)$/);
      if (match?.[1]) paths.push(decodeURIComponent(match[1]));
    }
    if (paths.length > 0) {
      const { error: storageErr } = await admin.storage
        .from(PHOTOS_BUCKET)
        .remove(paths);
      if (storageErr) {
        return err500(`Storage 文件删除失败，注销已中止: ${storageErr.message}`);
      }
    }
    const { error: photosDelErr } = await admin
      .from("photos")
      .delete()
      .eq("photographer_id", uid);
    if (photosDelErr) {
      return err500(`photos 表删除失败，注销已中止: ${photosDelErr.message}`);
    }
  }

  // 4b. room_members（用户加入其他房间的成员记录）
  const { error: membersErr } = await admin
    .from("room_members")
    .delete()
    .eq("user_id", uid);
  if (membersErr) {
    return err500(`room_members 表删除失败，注销已中止: ${membersErr.message}`);
  }

  // 4c. memberships（摄影师审批成员关系）
  const { error: membershipsErr } = await admin
    .from("memberships")
    .delete()
    .eq("user_id", uid);
  if (membershipsErr) {
    return err500(`memberships 表删除失败，注销已中止: ${membershipsErr.message}`);
  }

  // 4d. room_barrages（弹幕）
  const { error: barragesErr } = await admin
    .from("room_barrages")
    .delete()
    .eq("user_id", uid);
  if (barragesErr) {
    return err500(`room_barrages 表删除失败，注销已中止: ${barragesErr.message}`);
  }

  // 4e. questions（游客提问）
  const { error: questionsErr } = await admin
    .from("questions")
    .delete()
    .eq("user_id", uid);
  if (questionsErr) {
    return err500(`questions 表删除失败，注销已中止: ${questionsErr.message}`);
  }

  // 4f. favorites（收藏）
  const { error: favoritesErr } = await admin
    .from("favorites")
    .delete()
    .eq("user_id", uid);
  if (favoritesErr) {
    return err500(`favorites 表删除失败，注销已中止: ${favoritesErr.message}`);
  }

  // 4g. card_pushes（推送记录，非导游角色也可能有）
  const { error: cardPushesErr } = await admin
    .from("card_pushes")
    .delete()
    .eq("pushed_by", uid);
  if (cardPushesErr) {
    return err500(`card_pushes 表删除失败，注销已中止: ${cardPushesErr.message}`);
  }

  // 4h. feedbacks
  const { error: feedbacksErr } = await admin
    .from("feedbacks")
    .delete()
    .eq("user_id", uid);
  if (feedbacksErr) {
    return err500(`feedbacks 表删除失败，注销已中止: ${feedbacksErr.message}`);
  }

  // 4i. knowledge_cards（非导游角色若有创建，一并清理）
  if (role !== "guide") {
    const { error: kcErr } = await admin
      .from("knowledge_cards")
      .delete()
      .eq("created_by", uid);
    if (kcErr) {
      return err500(`knowledge_cards 表删除失败，注销已中止: ${kcErr.message}`);
    }
  }

  // 4j. wechat_identities
  const { error: wechatErr } = await admin
    .from("wechat_identities")
    .delete()
    .eq("user_id", uid);
  if (wechatErr) {
    return err500(`wechat_identities 表删除失败，注销已中止: ${wechatErr.message}`);
  }

  // 4k. profiles（主键 id）
  const { error: profilesErr } = await admin
    .from("profiles")
    .delete()
    .eq("id", uid);
  if (profilesErr) {
    return err500(`profiles 表删除失败，注销已中止: ${profilesErr.message}`);
  }

  // ── 5. 全部关联数据已确认删除，最后删除 auth.users（不可逆） ──
  const { error: deleteUserErr } = await admin.auth.admin.deleteUser(uid);
  if (deleteUserErr) {
    return err500(`auth.users 删除失败: ${deleteUserErr.message}`);
  }

  return new Response(
    JSON.stringify({ success: true }),
    { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
