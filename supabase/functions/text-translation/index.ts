import { serve } from "https://deno.land/std/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token";
const TRANSLATION_URL = "https://aip.baidubce.com/rpc/2.0/mt/texttrans/v1";
const LANGUAGE_CODE = /^[a-zA-Z-]{2,12}$/;

let cachedToken = "";
let tokenExpiresAt = 0;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }

  const apiKey =
    Deno.env.get("BAIDU_TRANSLATION_API_KEY") ?? Deno.env.get("BAIDU_API_KEY");
  const secretKey =
    Deno.env.get("BAIDU_TRANSLATION_SECRET_KEY") ?? Deno.env.get("BAIDU_SECRET_KEY");
  if (!apiKey || !secretKey) throw new Error("BAIDU_CREDENTIALS_MISSING");

  const url = new URL(TOKEN_URL);
  url.searchParams.set("grant_type", "client_credentials");
  url.searchParams.set("client_id", apiKey);
  url.searchParams.set("client_secret", secretKey);

  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json() as {
    access_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };

  if (!response.ok || !data.access_token) {
    console.error("[baidu-translation] 获取 access_token 失败", {
      status: response.status,
      error: data.error,
      error_description: data.error_description,
    });
    throw new Error("BAIDU_AUTH_FAILED");
  }

  cachedToken = data.access_token;
  tokenExpiresAt = Date.now() + Number(data.expires_in ?? 2_592_000) * 1000;
  return cachedToken;
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, 405);
  }

  let q: string;
  let from: string;
  let to: string;
  try {
    const body = await req.json();
    q = String(body.q ?? "").trim();
    from = String(body.from ?? "auto").trim();
    to = String(body.to ?? "").trim();
    if (!q || q.length > 6000) throw new Error("Invalid q");
    if (!LANGUAGE_CODE.test(from) || !LANGUAGE_CODE.test(to) || to === "auto") {
      throw new Error("Invalid language");
    }
  } catch {
    return jsonResponse(
      { error: "Invalid request body", detail: "q、to 必填，q 最长 6000 字符" },
      400,
    );
  }

  try {
    const token = await getAccessToken();
    const url = new URL(TRANSLATION_URL);
    url.searchParams.set("access_token", token);
    const upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json;charset=utf-8" },
      body: JSON.stringify({ q, from, to }),
      signal: AbortSignal.timeout(15_000),
    });
    const responseText = await upstream.text();

    if (!upstream.ok) {
      console.error("[baidu-translation] 上游 HTTP 错误", upstream.status);
      return jsonResponse({ error: `Baidu translation HTTP ${upstream.status}` }, 502);
    }

    return new Response(responseText, { status: 200, headers: jsonHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN";
    console.error("[baidu-translation] 请求失败", message);
    if (message === "BAIDU_CREDENTIALS_MISSING") {
      return jsonResponse({ error: "Server configuration error", detail: "缺少百度 API 密钥" }, 500);
    }
    if (message === "BAIDU_AUTH_FAILED") {
      return jsonResponse({ error: "Baidu authentication failed" }, 502);
    }
    return jsonResponse({ error: "Baidu translation request failed" }, 502);
  }
});
