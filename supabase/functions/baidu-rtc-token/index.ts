import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map(value => value.toString(16).padStart(2, "0")).join("");
}

async function numericUserId(value: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
  let result = 0n;
  for (const byte of digest.slice(0, 6)) result = (result << 8n) + BigInt(byte);
  return String(result > 0n ? result : 1n);
}

async function createRtcToken(
  appId: string,
  appKey: string,
  roomName: string,
  userId: string,
): Promise<{ token: string; expiresAt: number }> {
  const version = "004";
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 2 * 60 * 60;
  const randomBytes = crypto.getRandomValues(new Uint8Array(4));
  const randomString = [...randomBytes].map(value => value.toString(16).padStart(2, "0")).join("");
  const payload = `ACS${appId}${issuedAt}${randomString}${roomName}${userId}${expiresAt}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appKey),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const signature = hex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)));
  return { token: `${version}${signature}${issuedAt}${randomString}${expiresAt}`, expiresAt };
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method Not Allowed" }, 405);

  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) return json({ error: "请先登录" }, 401);

  const appId = String(Deno.env.get("BAIDU_RTC_APP_ID") ?? "").trim();
  const appKey = String(Deno.env.get("BAIDU_RTC_APP_KEY") ?? "").trim();
  if (!appId || !appKey) return json({ error: "百度 RTC 云端密钥尚未配置" }, 503);

  try {
    const { roomName } = await req.json();
    const normalizedRoom = String(roomName ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(normalizedRoom)) {
      return json({ error: "无效的 RTC 房间参数" }, 400);
    }

    const client = createClient(
      Deno.env.get("SUPABASE_URL") ?? "",
      Deno.env.get("SUPABASE_ANON_KEY") ?? "",
      { global: { headers: { Authorization: authorization } } },
    );
    const { data: authData, error: authError } = await client.auth.getUser();
    if (authError || !authData.user) return json({ error: "登录状态无效" }, 401);

    const { data: allowed, error: accessError } = await client.rpc("_is_room_participant", {
      p_room_id: normalizedRoom,
    });
    if (accessError || allowed !== true) return json({ error: "无权进入该语音房间" }, 403);

    const userId = await numericUserId(`${normalizedRoom}:${authData.user.id}`);
    const { token, expiresAt } = await createRtcToken(appId, appKey, normalizedRoom, userId);
    return json({ appId, roomName: normalizedRoom, userId, token, expiresAt });
  } catch (error) {
    console.error("[baidu-rtc-token]", error);
    return json({ error: "百度 RTC 令牌生成失败" }, 500);
  }
});
