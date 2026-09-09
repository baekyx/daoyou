import type { IncomingMessage, ServerResponse } from "node:http";
import { createHash, createHmac, randomBytes } from "node:crypto";
import type { Plugin } from "vite";
import WebSocket, { WebSocketServer } from "ws";

const TOKEN_URL = "https://aip.baidubce.com/oauth/2.0/token";
const ASR_URL = "https://vop.baidu.com/server_api";
const REALTIME_ASR_URL = "wss://vop.baidu.com/realtime_asr";
const TRANSLATION_URL = "https://aip.baidubce.com/rpc/2.0/mt/texttrans/v1";
const TTS_URL = "https://tsn.baidu.com/text2audio";
const ROUTE_PREFIX = "/api/local/baidu/";
const REALTIME_ASR_PATH = `${ROUTE_PREFIX}realtime-asr`;
const MAX_BODY_BYTES = 15 * 1024 * 1024;

type Credentials = {
  apiKey: string;
  secretKey: string;
  speechAppId?: string;
  speechApiKey?: string;
  translationApiKey?: string;
  translationSecretKey?: string;
  ttsApiKey?: string;
  ttsSecretKey?: string;
  rtcAppId?: string;
  rtcAppKey?: string;
};

type TokenCacheEntry = {
  token: string;
  expiresAt: number;
};

const tokenCache = new Map<string, TokenCacheEntry>();

function sendJson(res: ServerResponse, body: unknown, status = 200) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function isTrustedLocalRequest(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) {
    const remoteAddress = req.socket.remoteAddress?.replace(/^::ffff:/, "") ?? "";
    return remoteAddress === "127.0.0.1" || remoteAddress === "::1";
  }
  try {
    const parsed = new URL(origin);
    const host = req.headers.host ?? "";
    const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
    const isPrivateLan =
      hostname === "127.0.0.1" ||
      hostname === "localhost" ||
      hostname === "::1" ||
      /^10\./.test(hostname) ||
      /^192\.168\./.test(hostname) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(hostname) ||
      /^(fc|fd|fe8|fe9|fea|feb)/i.test(hostname);
    return (
      isPrivateLan &&
      parsed.host === host
    );
  } catch {
    return false;
  }
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("REQUEST_TOO_LARGE");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

function rtcNumericUserId(userKey: string): string {
  const digest = createHash("sha256").update(userKey).digest();
  const value = digest.readUIntBE(0, 6);
  return String(Math.max(1, value));
}

function createRtcToken(
  appId: string,
  appKey: string,
  roomName: string,
  userId: string,
): { token: string; expiresAt: number } {
  const version = "004";
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + 2 * 60 * 60;
  const randomString = randomBytes(4).toString("hex");
  const payload = `ACS${appId}${issuedAt}${randomString}${roomName}${userId}${expiresAt}`;
  const signature = createHmac("sha1", appKey).update(payload).digest("hex");
  return {
    token: `${version}${signature}${issuedAt}${randomString}${expiresAt}`,
    expiresAt,
  };
}

async function handleRtcToken(
  req: IncomingMessage,
  res: ServerResponse,
  credentials: Credentials,
) {
  const appId = String(credentials.rtcAppId ?? "").trim();
  const appKey = String(credentials.rtcAppKey ?? "").trim();
  if (!appId || !appKey) {
    sendJson(res, { error: "百度 RTC 尚未配置" }, 503);
    return;
  }

  const body = await readJson(req);
  const roomName = String(body.roomName ?? "").trim();
  const userKey = String(body.userKey ?? "").trim();
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(roomName) ||
    !userKey ||
    userKey.length > 256
  ) {
    sendJson(res, { error: "无效的 RTC 房间或用户参数" }, 400);
    return;
  }

  const userId = rtcNumericUserId(`${roomName}:${userKey}`);
  const { token, expiresAt } = createRtcToken(appId, appKey, roomName, userId);
  sendJson(res, { appId, roomName, userId, token, expiresAt });
}

async function getAccessToken(credentials: Credentials): Promise<string> {
  const cached = tokenCache.get(credentials.apiKey);
  if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
    return cached.token;
  }

  const url = new URL(TOKEN_URL);
  url.searchParams.set("grant_type", "client_credentials");
  url.searchParams.set("client_id", credentials.apiKey);
  url.searchParams.set("client_secret", credentials.secretKey);
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
    throw new Error(data.error_description ?? data.error ?? "百度鉴权失败");
  }

  tokenCache.set(credentials.apiKey, {
    token: data.access_token,
    expiresAt: Date.now() + Number(data.expires_in ?? 2_592_000) * 1000,
  });
  return data.access_token;
}

async function handleAsr(
  req: IncomingMessage,
  res: ServerResponse,
  credentials: Credentials,
) {
  const body = await readJson(req);
  const token = await getAccessToken(credentials);
  const upstream = await fetch(ASR_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      format: body.format ?? "wav",
      rate: body.rate ?? 16000,
      channel: 1,
      cuid: body.cuid ?? "shiguang-local",
      dev_pid: body.dev_pid ?? 1537,
      speech: body.speech,
      len: body.len,
      token,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await upstream.json();
  sendJson(res, data, upstream.ok ? 200 : 502);
}

async function handleTranslation(
  req: IncomingMessage,
  res: ServerResponse,
  credentials: Credentials,
) {
  const body = await readJson(req);
  const token = await getAccessToken(credentials);
  const url = new URL(TRANSLATION_URL);
  url.searchParams.set("access_token", token);
  const upstream = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json;charset=utf-8" },
    body: JSON.stringify({
      q: body.q,
      from: body.from ?? "auto",
      to: body.to,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const data = await upstream.json();
  sendJson(res, data, upstream.ok ? 200 : 502);
}

async function handleTts(
  req: IncomingMessage,
  res: ServerResponse,
  credentials: Credentials,
) {
  const body = await readJson(req);
  const text = String(body.text ?? "").trim();
  if (!text || text.length > 512) {
    sendJson(res, { error: "text 必填且不超过 512 个字符" }, 400);
    return;
  }

  const token = await getAccessToken(credentials);
  const form = new URLSearchParams({
    tex: text,
    tok: token,
    cuid: "shiguang-local",
    ctp: "1",
    lan: "zh",
    spd: "5",
    pit: "5",
    vol: "5",
    per: "0",
    aue: "3",
  });
  const upstream = await fetch(TTS_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(30_000),
  });
  const contentType = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok || !contentType.toLowerCase().startsWith("audio/")) {
    const detail = await upstream.text();
    console.error("[local-baidu-tts] 百度返回错误", detail.slice(0, 500));
    sendJson(
      res,
      { error: "百度语音合成失败", detail: "请确认已开通短文本在线合成权限和额度" },
      502,
    );
    return;
  }

  const audio = Buffer.from(await upstream.arrayBuffer());
  sendJson(res, {
    audioUrl: `data:audio/mpeg;base64,${audio.toString("base64")}`,
    audioLength: 0,
    usageCharacters: text.length,
  });
}

export function baiduLocalApiPlugin(credentials: Credentials): Plugin {
  return {
    name: "baidu-local-api",
    configureServer(server) {
      const realtimeServer = new WebSocketServer({ noServer: true });

      realtimeServer.on("connection", (client) => {
        const appId = Number(credentials.speechAppId);
        const appKey = credentials.speechApiKey || credentials.apiKey;
        const requestId = crypto.randomUUID();
        const upstream = new WebSocket(`${REALTIME_ASR_URL}?sn=${requestId}`);
        const pendingAudio: Buffer[] = [];
        let upstreamStarted = false;
        let closing = false;

        const sendClientJson = (body: unknown) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(body));
          }
        };

        const closeBoth = (code = 1000, reason = "closed") => {
          if (closing) return;
          closing = true;
          if (
            upstream.readyState === WebSocket.OPEN ||
            upstream.readyState === WebSocket.CONNECTING
          ) {
            upstream.close(code, reason);
          }
          if (client.readyState === WebSocket.OPEN) {
            client.close(code, reason);
          }
        };

        upstream.on("open", () => {
          upstream.send(JSON.stringify({
            type: "START",
            data: {
              appid: appId,
              appkey: appKey,
              dev_pid: 15372,
              cuid: "shiguang-local-stream",
              format: "pcm",
              sample: 16000,
            },
          }));
          upstreamStarted = true;
          for (const frame of pendingAudio.splice(0)) {
            upstream.send(frame, { binary: true });
          }
        });

        upstream.on("message", (data) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(data.toString());
          }
        });

        upstream.on("error", (error) => {
          console.error("[local-baidu-realtime-asr] 上游连接失败", error.message);
          sendClientJson({
            type: "LOCAL_ERROR",
            err_no: -1,
            err_msg: "百度实时语音识别连接失败",
          });
          closeBoth(1011, "upstream error");
        });

        upstream.on("close", (code, reason) => {
          if (client.readyState === WebSocket.OPEN) {
            const safeCode =
              code >= 1000 &&
              code <= 4999 &&
              ![1004, 1005, 1006, 1015].includes(code)
                ? code
                : 1011;
            client.close(safeCode, reason.toString());
          }
        });

        client.on("message", (data, isBinary) => {
          if (isBinary) {
            const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
            if (upstreamStarted && upstream.readyState === WebSocket.OPEN) {
              upstream.send(frame, { binary: true });
            } else {
              // 最多缓存约 10 秒 PCM，防止上游握手异常导致内存持续增长。
              pendingAudio.push(frame);
              while (pendingAudio.reduce((sum, item) => sum + item.byteLength, 0) > 320_000) {
                pendingAudio.shift();
              }
            }
            return;
          }

          let type = "";
          try {
            type = String(JSON.parse(data.toString())?.type ?? "");
          } catch {
            sendClientJson({ type: "LOCAL_ERROR", err_no: -2, err_msg: "无效控制帧" });
            return;
          }
          if (
            (type === "FINISH" || type === "CANCEL") &&
            upstream.readyState === WebSocket.OPEN
          ) {
            upstream.send(JSON.stringify({ type }));
          }
        });

        client.on("close", () => {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(JSON.stringify({ type: "CANCEL" }));
          }
          closeBoth();
        });
        client.on("error", () => closeBoth(1011, "client error"));
      });

      server.httpServer?.on("upgrade", (req, socket, head) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (pathname !== REALTIME_ASR_PATH) return;

        if (!isTrustedLocalRequest(req)) {
          socket.write(
            "HTTP/1.1 403 Forbidden\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            "Connection: close\r\n\r\n" +
            "Forbidden",
          );
          socket.destroy();
          return;
        }

        const appId = Number(credentials.speechAppId);
        const appKey = credentials.speechApiKey || credentials.apiKey;
        if (!Number.isInteger(appId) || appId <= 0 || !appKey) {
          socket.write(
            "HTTP/1.1 503 Service Unavailable\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            "Connection: close\r\n\r\n" +
            "缺少 BAIDU_SPEECH_APP_ID 或百度语音 API Key",
          );
          socket.destroy();
          return;
        }

        realtimeServer.handleUpgrade(req, socket, head, (client) => {
          realtimeServer.emit("connection", client, req);
        });
      });

      server.httpServer?.once("close", () => realtimeServer.close());

      server.middlewares.use(async (req, res, next) => {
        const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
        if (!pathname.startsWith(ROUTE_PREFIX)) {
          next();
          return;
        }
        if (!isTrustedLocalRequest(req)) {
          sendJson(res, { error: "Forbidden" }, 403);
          return;
        }
        if (req.method !== "POST") {
          sendJson(res, { error: "Method Not Allowed" }, 405);
          return;
        }
        try {
          const route = pathname.slice(ROUTE_PREFIX.length);
          if (route === "rtc-token") {
            await handleRtcToken(req, res, credentials);
            return;
          }
          const translationCredentials = {
            apiKey: credentials.translationApiKey || credentials.apiKey,
            secretKey: credentials.translationSecretKey || credentials.secretKey,
          };
          const ttsCredentials = {
            apiKey: credentials.ttsApiKey || credentials.apiKey,
            secretKey: credentials.ttsSecretKey || credentials.secretKey,
          };
          const routeCredentials =
            route === "text-translation"
              ? translationCredentials
              : route === "tts-baidu"
                ? ttsCredentials
                : credentials;
          if (!routeCredentials.apiKey || !routeCredentials.secretKey) {
            sendJson(
              res,
              { error: "未配置百度密钥", detail: "请检查 supabase/.env.local" },
              500,
            );
            return;
          }

          if (route === "short-speech-recognition") {
            await handleAsr(req, res, credentials);
          } else if (route === "text-translation") {
            await handleTranslation(req, res, translationCredentials);
          } else if (route === "tts-baidu") {
            await handleTts(req, res, ttsCredentials);
          } else {
            sendJson(res, { error: "Not Found" }, 404);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "未知错误";
          console.error("[local-baidu-api] 请求失败", message);
          sendJson(res, { error: "百度 API 请求失败", detail: message }, 502);
        }
      });
    },
  };
}
