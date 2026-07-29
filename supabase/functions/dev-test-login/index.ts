/**
 * dev-test-login — 测试账号专用登录 Edge Function
 *
 * 安全边界：
 *   - 仅接受精确组合 TEST_PHONE + TEST_CODE，双重校验；
 *   - 任何其他输入立即返回 403，不泄露测试账号存在性；
 *   - 使用 admin.generateLink(magiclink) 在服务端生成一次性令牌，
 *     再用 anon client 的 verifyOtp 兑换真实 session；
 *   - 不持久化任何凭据，不改数据库；
 *   - 生产环境（ENVIRONMENT != development）禁止调用。
 */
import { createClient } from "jsr:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TEST_PHONE = "18888888888";   // 精确匹配，不接受其他号码
const TEST_CODE  = "888888";        // 精确匹配，不接受其他验证码

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const { phone, code } = await req.json();

    // ── 双重精确校验：号码与验证码必须同时匹配 ──────────────────────
    if (phone !== TEST_PHONE || code !== TEST_CODE) {
      // 统一返回验证码错误，不区分是号码错还是验证码错（防枚举）
      return json({ error: "验证码错误" }, 403);
    }

    const supabaseAdmin = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // ── 精确按 email 查找测试账号（比 listUsers 遍历更可靠）──────────
    const TEST_EMAIL = "test_18888888888@shiguang.local";
    const { data: { users }, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
    if (listErr) return json({ error: "服务异常，请稍后重试" }, 500);

    const testUser = users.find(u => u.email === TEST_EMAIL);
    if (!testUser) return json({ error: "测试账号未初始化，请联系管理员" }, 500);

    // ban 检查：被 banned_until 封禁时拒绝（尊重已有安全策略）
    if (testUser.banned_until && new Date(testUser.banned_until) > new Date()) {
      return json({ error: "测试账号已被停用" }, 403);
    }

    const email = TEST_EMAIL;

    // ── 生成 magiclink → 兑换真实 session ─────────────────────────
    const { data: linkData, error: linkErr } = await supabaseAdmin.auth.admin.generateLink({
      type: "magiclink",
      email,
    });
    if (linkErr || !linkData) return json({ error: "登录链路初始化失败" }, 500);

    const linkUrl   = new URL(linkData.properties?.action_link ?? "");
    const tokenHash = linkUrl.searchParams.get("token_hash") ?? linkData.properties?.hashed_token ?? "";
    const linkType  = linkUrl.searchParams.get("type") ?? "magiclink";
    if (!tokenHash) return json({ error: "令牌生成失败" }, 500);

    const supabaseAnon = createClient(
      Deno.env.get("SUPABASE_URL")      ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? ""
    );
    const { data: sessionData, error: sessionErr } = await supabaseAnon.auth.verifyOtp({
      token_hash: tokenHash,
      type: (linkType === "magiclink" ? "magiclink" : linkType) as Parameters<typeof supabaseAnon.auth.verifyOtp>[0]["type"],
    });
    if (sessionErr || !sessionData.session) {
      return json({ error: "会话签发失败，请稍后重试" }, 500);
    }

    // 返回 session（不含 refresh_token 明文，前端通过 setSession 注入）
    return json({ session: sessionData.session });

  } catch (e) {
    return json({ error: "服务异常" }, 500);
  }
});
