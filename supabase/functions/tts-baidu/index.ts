import { serve } from "https://deno.land/std/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token";
const TTS_URL = "https://tsn.baidu.com/text2audio";
const MAX_TEXT_LENGTH = 512;

let cachedToken = "";
let tokenExpiresAt = 0;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }

  const apiKey = Deno.env.get("BAIDU_TTS_API_KEY") ?? Deno.env.get("BAIDU_API_KEY");
  const secretKey =
    Deno.env.get("BAIDU_TTS_SECRET_KEY") ?? Deno.env.get("BAIDU_SECRET_KEY");
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
    console.error("[baidu-tts] 获取 access_token 失败", {
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

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

serve(async (req: Request): Promise<Response> => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method Not Allowed" }, 405);
  }

  let text: string;
  let speed: number;
  let pitch: number;
  let volume: number;
  let voice: number;
  try {
    const body = await req.json();
    text = String(body.text ?? "").trim();
    speed = Number(body.speed ?? 5);
    pitch = Number(body.pitch ?? 5);
    volume = Number(body.volume ?? 5);
    voice = Number(body.voice ?? 0);
    if (!text || text.length > MAX_TEXT_LENGTH) throw new Error("Invalid text");
    if (![speed, pitch, volume].every((value) => Number.isInteger(value) && value >= 0 && value <= 15)) {
      throw new Error("Invalid voice settings");
    }
    if (!Number.isInteger(voice) || voice < 0) throw new Error("Invalid voice");
  } catch {
    return jsonResponse(
      { error: "Invalid request body", detail: `text 必填且不超过 ${MAX_TEXT_LENGTH} 个字符` },
      400,
    );
  }

  try {
    const token = await getAccessToken();
    const form = new URLSearchParams({
      tex: text,
      tok: token,
      cuid: "shiguang-web",
      ctp: "1",
      lan: "zh",
      spd: String(speed),
      pit: String(pitch),
      vol: String(volume),
      per: String(voice),
      aue: "3",
    });

    const upstream = await fetch(TTS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(30_000),
    });
    const contentType = upstream.headers.get("content-type") ?? "";

    if (!upstream.ok) {
      console.error("[baidu-tts] 上游 HTTP 错误", upstream.status);
      return jsonResponse({ error: `Baidu TTS HTTP ${upstream.status}` }, 502);
    }
    if (!contentType.toLowerCase().startsWith("audio/")) {
      const detail = await upstream.text();
      console.error("[baidu-tts] 业务错误", detail.slice(0, 500));
      return jsonResponse(
        { error: "Baidu TTS failed", detail: "请确认已开通短文本在线合成权限和可用额度" },
        502,
      );
    }

    const audio = new Uint8Array(await upstream.arrayBuffer());
    return jsonResponse({
      audioUrl: `data:audio/mpeg;base64,${bytesToBase64(audio)}`,
      audioLength: 0,
      usageCharacters: text.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN";
    console.error("[baidu-tts] 请求失败", message);
    if (message === "BAIDU_CREDENTIALS_MISSING") {
      return jsonResponse({ error: "Server configuration error", detail: "缺少百度 API 密钥" }, 500);
    }
    if (message === "BAIDU_AUTH_FAILED") {
      return jsonResponse({ error: "Baidu authentication failed" }, 502);
    }
    return jsonResponse({ error: "Baidu TTS request failed" }, 502);
  }
});
