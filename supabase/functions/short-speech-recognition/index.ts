import { serve } from "https://deno.land/std/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const jsonHeaders = { ...corsHeaders, "Content-Type": "application/json" };
const TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token";
const ASR_URL = "https://vop.baidu.com/server_api";
const VALID_FORMATS = new Set(["pcm", "wav", "amr", "m4a"]);
const VALID_RATES = new Set([8000, 16000]);
// 百度短语音识别标准版当前支持：普通话、英语、粤语、四川话。
const VALID_DEV_PIDS = new Set([1537, 1737, 1637, 1837]);
const MAX_AUDIO_BYTES = 10 * 1024 * 1024;

let cachedToken = "";
let tokenExpiresAt = 0;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: jsonHeaders });
}

async function getAccessToken(): Promise<string> {
  // 提前 5 分钟刷新，避免请求过程中 token 到期。
  if (cachedToken && Date.now() < tokenExpiresAt - 5 * 60 * 1000) {
    return cachedToken;
  }

  const apiKey = Deno.env.get("BAIDU_API_KEY");
  const secretKey = Deno.env.get("BAIDU_SECRET_KEY");
  if (!apiKey || !secretKey) {
    throw new Error("BAIDU_CREDENTIALS_MISSING");
  }

  const url = new URL(TOKEN_URL);
  url.searchParams.set("grant_type", "client_credentials");
  url.searchParams.set("client_id", apiKey);
  url.searchParams.set("client_secret", secretKey);

  const response = await fetch(url, {
    method: "POST",
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json();

  if (!response.ok || !data.access_token) {
    console.error("[baidu-asr] 获取 access_token 失败", {
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

  let speech: string;
  let len: number;
  let format: string;
  let rate: number;
  let cuid: string;
  let devPid: number;

  try {
    const body = await req.json();
    speech = body.speech;
    len = body.len;
    format = String(body.format ?? "wav").toLowerCase();
    rate = Number(body.rate ?? 16000);
    cuid = String(body.cuid ?? "shiguang-web").slice(0, 60);
    devPid = Number(body.dev_pid ?? 1537);

    if (typeof speech !== "string" || !speech) throw new Error("Missing speech");
    if (!Number.isInteger(len) || len <= 0 || len > MAX_AUDIO_BYTES) {
      throw new Error("Invalid len");
    }
    if (!VALID_FORMATS.has(format)) throw new Error("Invalid format");
    if (!VALID_RATES.has(rate)) throw new Error("Invalid rate");
    if (!VALID_DEV_PIDS.has(devPid)) throw new Error("Invalid dev_pid");
  } catch {
    return jsonResponse(
      {
        error: "Invalid request body",
        detail: "speech、len 必填；format 支持 pcm/wav/amr/m4a；rate 支持 8000/16000",
      },
      400,
    );
  }

  try {
    const token = await getAccessToken();
    const upstream = await fetch(ASR_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        format,
        rate,
        channel: 1,
        cuid,
        token,
        dev_pid: devPid,
        speech,
        len,
      }),
      signal: AbortSignal.timeout(20_000),
    });

    const responseText = await upstream.text();
    if (!upstream.ok) {
      console.error("[baidu-asr] 上游 HTTP 错误", {
        status: upstream.status,
        body: responseText.slice(0, 500),
      });
      return jsonResponse({ error: `Baidu ASR HTTP ${upstream.status}` }, 502);
    }

    return new Response(responseText, { status: 200, headers: jsonHeaders });
  } catch (error) {
    const message = error instanceof Error ? error.message : "UNKNOWN";
    console.error("[baidu-asr] 请求失败", message);

    if (message === "BAIDU_CREDENTIALS_MISSING") {
      return jsonResponse(
        { error: "Server configuration error", detail: "缺少百度语音 API 密钥" },
        500,
      );
    }
    if (message === "BAIDU_AUTH_FAILED") {
      return jsonResponse(
        { error: "Baidu authentication failed", detail: "请检查 API Key、Secret Key 和语音服务权限" },
        502,
      );
    }
    return jsonResponse({ error: "Baidu ASR request failed" }, 502);
  }
});
