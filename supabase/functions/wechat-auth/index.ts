/**
 * wechat-auth Edge Function — A3-1 重写
 *
 * 安全改动：
 *   1. 使用 wechat_identities 私有映射表定位用户，彻底移除 listUsers 全量扫描
 *   2. 使用 admin.createSession (generateLink→verifyOtp 模式) 创建 session，
 *      不再持久化任何密码到 profiles 或其他客户端可读表
 *   3. 基于 IP + openid 哈希的时间窗口频率限制（存不可逆哈希，不存原始值）
 *   4. 错误响应统一，内部异常不泄露到客户端
 *   5. CORS 保持 * 兼容微信小程序
 *
 * 返回契约（与旧版相同）：{ session, is_new_user }
 */

import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

// ── 频率限制：内存滑动窗口（Edge Function 单实例内有效，无需持久化）──────────
// key = sha256(ip + openid)[:16]，value = 时间戳数组
const RATE_WINDOW_MS  = 60_000; // 1 分钟窗口
const RATE_MAX_CALLS  = 5;      // 每 IP+openid 每分钟最多 5 次
const rateBucket = new Map<string, number[]>();

async function rateKey(ip: string, openid: string): Promise<string> {
  const raw = new TextEncoder().encode(ip + ":" + openid);
  const buf = await crypto.subtle.digest("SHA-256", raw);
  return Array.from(new Uint8Array(buf)).slice(0, 8).map(b => b.toString(16).padStart(2,"0")).join("");
}

function checkRate(key: string): boolean {
  const now = Date.now();
  const ts  = (rateBucket.get(key) ?? []).filter(t => now - t < RATE_WINDOW_MS);
  if (ts.length >= RATE_MAX_CALLS) return false;
  ts.push(now);
  rateBucket.set(key, ts);
  // 防止内存无限增长：超过 2000 个 key 时清理最旧一半
  if (rateBucket.size > 2000) {
    const oldest = [...rateBucket.keys()].slice(0, 1000);
    oldest.forEach(k => rateBucket.delete(k));
  }
  return true;
}

// ── 主处理器 ────────────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  // ① 解析请求体
  let code: string;
  try {
    const body = await req.json();
    code = body?.code ?? "";
    if (!code) return json({ error: "缺少 code 参数" }, 400);
  } catch {
    return json({ error: "请求体格式错误" }, 400);
  }

  const APPID  = Deno.env.get("WECHAT_APPID");
  const SECRET = Deno.env.get("WECHAT_APPSECRET");
  if (!APPID || !SECRET) return json({ error: "服务配置错误，请稍后重试" }, 500);

  // ② 用 code 换 openid（先取 openid 再做频率限制，防止 code 枚举）
  let openid    = "";
  let access_token = "";
  try {
    const tokenUrl = `https://api.weixin.qq.com/sns/oauth2/access_token` +
      `?appid=${APPID}&secret=${SECRET}&code=${encodeURIComponent(code)}&grant_type=authorization_code`;
    const tokenRes  = await fetch(tokenUrl);
    const tokenData = await tokenRes.json();
    if (tokenData.errcode) {
      return json({ error: "微信授权失败，请重试" }, 400);
    }
    openid       = tokenData.openid       ?? "";
    access_token = tokenData.access_token ?? "";
    if (!openid) return json({ error: "微信未返回用户标识" }, 400);
  } catch {
    return json({ error: "微信服务暂时不可用，请稍后重试" }, 502);
  }

  // ③ 频率限制（IP + openid 哈希，不存原始值）
  const clientIp = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rk = await rateKey(clientIp, openid);
  if (!checkRate(rk)) {
    return json({ error: "请求过于频繁，请稍后重试" }, 429);
  }

  // ④ 初始化 service_role admin 客户端
  const supabaseAdmin = createClient(
    Deno.env.get("SUPABASE_URL")              ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { autoRefreshToken: false, persistSession: false } }
  );

  // ⑤ 通过 wechat_identities 精确查找用户（service_role 可绕过 RLS）
  //    wechat_identities 对 anon/authenticated 完全禁止，仅 service_role 可读
  const { data: identityRow, error: identityErr } = await supabaseAdmin
    .from("wechat_identities")
    .select("user_id")
    .eq("openid", openid)
    .eq("appid", APPID)
    .maybeSingle();

  if (identityErr) {
    return json({ error: "服务内部错误，请稍后重试" }, 500);
  }

  let userId     = identityRow?.user_id as string | undefined;
  const isNewUser = !userId;

  if (isNewUser) {
    // ⑥-a 首次登录：拉取微信用户信息（昵称、头像）
    let nickname   = "";
    let avatar_url = "";
    try {
      const infoUrl = `https://api.weixin.qq.com/sns/userinfo` +
        `?access_token=${access_token}&openid=${openid}&lang=zh_CN`;
      const infoRes  = await fetch(infoUrl);
      const infoData = await infoRes.json();
      nickname   = (infoData.nickname    ?? "").slice(0, 50);
      avatar_url = (infoData.headimgurl  ?? "").slice(0, 500);
    } catch {
      // 用户信息拉取失败不影响登录
    }

    // 使用虚构 email（openid 哈希，不含原始 openid）
    const oidHash  = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(openid)))
    ).map(b => b.toString(16).padStart(2,"0")).join("").slice(0, 24);
    const email = `wx_${oidHash}@wechat.miaoda.internal`;

    // 创建 auth 用户（不设 password，使用 email_confirm=true 跳过验证流程）
    const { data: newUserData, error: createErr } = await supabaseAdmin.auth.admin.createUser({
      email,
      email_confirm: true,
      user_metadata: { role: "tourist", nickname, avatar_url },
    });
    if (createErr || !newUserData.user) {
      return json({ error: "账号创建失败，请稍后重试" }, 500);
    }
    userId = newUserData.user.id;

    // 写入 wechat_identities（service_role 写，客户端不可见）
    const { error: mapErr } = await supabaseAdmin
      .from("wechat_identities")
      .insert({ user_id: userId, openid, appid: APPID });
    if (mapErr) {
      // 幂等保护：若并发已插入则忽略唯一冲突
      if (!mapErr.code?.includes("23505")) {
        return json({ error: "账号初始化失败，请稍后重试" }, 500);
      }
    }

    // 更新 profiles 昵称/头像（handle_new_user trigger 已建行）
    if (nickname || avatar_url) {
      await supabaseAdmin
        .from("profiles")
        .update({
          nickname:   nickname   || null,
          avatar_url: avatar_url || null,
        })
        .eq("id", userId);
    }
    // ⚠️  绝不写入 wechat_pwd、wechat_openid 或任何密码到 profiles
  }

  // ⑦ 使用 admin.generateLink(magiclink) 换取短期 token，再 verifyOtp 拿 session
  //    整个流程在服务端完成，不产生持久化凭据
  const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
    type: "magiclink",
    email: (await supabaseAdmin.auth.admin.getUserById(userId!)).data.user?.email ?? "",
  });
  if (linkErr || !linkData) {
    return json({ error: "登录链路初始化失败，请稍后重试" }, 500);
  }

  // 从 magic link URL 中提取 token_hash 和 type
  const linkUrl   = new URL(linkData.properties?.action_link ?? "");
  const tokenHash = linkUrl.searchParams.get("token_hash") ?? linkData.properties?.hashed_token ?? "";
  const linkType  = linkUrl.searchParams.get("type") ?? "magiclink";

  if (!tokenHash) {
    return json({ error: "登录令牌生成失败，请稍后重试" }, 500);
  }

  // 用 anon 客户端以 verifyOtp 方式兑换 session（与前端现有 session 契约相同）
  const supabaseAnon = createClient(
    Deno.env.get("SUPABASE_URL")   ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? ""
  );
  const { data: sessionData, error: sessionErr } = await supabaseAnon.auth.verifyOtp({
    token_hash: tokenHash,
    type: (linkType === "magiclink" ? "magiclink" : linkType) as Parameters<typeof supabaseAnon.auth.verifyOtp>[0]["type"],
  });
  if (sessionErr || !sessionData.session) {
    return json({ error: "登录失败，请稍后重试" }, 500);
  }

  // ⑧ 返回 session（与旧版契约相同字段）
  return json({
    session:     sessionData.session,
    is_new_user: isNewUser,
  });
});
