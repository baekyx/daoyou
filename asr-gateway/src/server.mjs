import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import WebSocket, { WebSocketServer } from "ws";

const PORT = integerEnv("PORT", 8080, 1, 65_535);
const ENABLE_TEST_PAGE = booleanEnv("ENABLE_TEST_PAGE", process.env.NODE_ENV !== "production");
const MAX_CONNECTIONS = integerEnv("MAX_CONNECTIONS", 40, 1, 1_000);
const MAX_CONNECTIONS_PER_IP = integerEnv("MAX_CONNECTIONS_PER_IP", 4, 1, 100);
const MAX_SESSION_MS = integerEnv("MAX_SESSION_SECONDS", 3_600, 30, 3_600) * 1_000;
const MAX_PENDING_AUDIO_BYTES = integerEnv(
  "MAX_PENDING_AUDIO_BYTES",
  320_000,
  32_000,
  3_200_000,
);
const MAX_CLIENT_MESSAGE_BYTES = 64 * 1024;
const REALTIME_ASR_URL = "wss://vop.baidu.com/realtime_asr";
const REALTIME_ASR_PATH = "/api/realtime-asr";
const DEFAULT_LOCAL_ORIGINS = [
  "http://127.0.0.1:8080",
  "http://localhost:8080",
  "http://127.0.0.1:5173",
  "http://localhost:5173",
];
const allowedOrigins = new Set(
  String(process.env.ALLOWED_ORIGINS || DEFAULT_LOCAL_ORIGINS.join(","))
    .split(",")
    .map((value) => value.trim().replace(/\/$/, ""))
    .filter(Boolean),
);

const speechAppId = Number(String(process.env.BAIDU_SPEECH_APP_ID || "").trim());
const speechApiKey = String(
  process.env.BAIDU_SPEECH_API_KEY || process.env.BAIDU_API_KEY || "",
).trim();

if (!Number.isSafeInteger(speechAppId) || speechAppId <= 0 || !speechApiKey) {
  console.error(
    "[startup] 缺少 BAIDU_SPEECH_APP_ID 或 BAIDU_SPEECH_API_KEY，服务拒绝启动",
  );
  process.exit(1);
}

const testPagePath = fileURLToPath(new URL("../public/index.html", import.meta.url));
const activeByIp = new Map();
let activeConnections = 0;
let shuttingDown = false;

function integerEnv(name, fallback, min, max) {
  const parsed = Number.parseInt(String(process.env[name] || fallback), 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function booleanEnv(name, fallback) {
  const value = String(process.env[name] ?? "").trim().toLowerCase();
  if (!value) return fallback;
  return value === "1" || value === "true" || value === "yes";
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

function requestIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return forwarded || req.socket.remoteAddress?.replace(/^::ffff:/, "") || "unknown";
}

function requestOriginAllowed(req) {
  const origin = String(req.headers.origin || "").trim().replace(/\/$/, "");
  if (!origin) return false;
  return allowedOrigins.has(origin);
}

function rejectUpgrade(socket, status, message) {
  const reason = message.replace(/[\r\n]/g, " ");
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(reason)}\r\n\r\n${reason}`,
  );
  socket.destroy();
}

function safeCloseCode(code) {
  return code >= 1000 && code <= 4999 && ![1004, 1005, 1006, 1015].includes(code)
    ? code
    : 1011;
}

function publicLog(event, details = {}) {
  console.info(JSON.stringify({
    time: new Date().toISOString(),
    service: "shiguang-asr-gateway",
    event,
    ...details,
  }));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    json(res, shuttingDown ? 503 : 200, {
      ok: !shuttingDown,
      service: "shiguang-asr-gateway",
      activeConnections,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/" && ENABLE_TEST_PAGE) {
    try {
      const page = await readFile(testPagePath);
      res.writeHead(200, {
        "content-type": "text/html; charset=utf-8",
        "content-length": page.byteLength,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; media-src 'self' blob:",
      });
      res.end(page);
    } catch {
      json(res, 500, { error: "TEST_PAGE_UNAVAILABLE" });
    }
    return;
  }

  json(res, 404, { error: "NOT_FOUND" });
});

const socketServer = new WebSocketServer({
  noServer: true,
  maxPayload: MAX_CLIENT_MESSAGE_BYTES,
  perMessageDeflate: false,
});

server.on("upgrade", (req, socket, head) => {
  if (shuttingDown) return rejectUpgrade(socket, 503, "Service Unavailable");

  let pathname = "";
  try {
    pathname = new URL(req.url || "/", "http://localhost").pathname;
  } catch {
    return rejectUpgrade(socket, 400, "Bad Request");
  }

  if (pathname !== REALTIME_ASR_PATH) return rejectUpgrade(socket, 404, "Not Found");
  if (!requestOriginAllowed(req)) return rejectUpgrade(socket, 403, "Origin Not Allowed");
  if (activeConnections >= MAX_CONNECTIONS) return rejectUpgrade(socket, 503, "Gateway Busy");

  const ip = requestIp(req);
  if ((activeByIp.get(ip) || 0) >= MAX_CONNECTIONS_PER_IP) {
    return rejectUpgrade(socket, 429, "Too Many Connections");
  }

  socketServer.handleUpgrade(req, socket, head, (client) => {
    socketServer.emit("connection", client, req, ip);
  });
});

socketServer.on("connection", (client, _req, ip) => {
  const sessionId = randomUUID();
  const upstream = new WebSocket(`${REALTIME_ASR_URL}?sn=${sessionId}`, {
    handshakeTimeout: 8_000,
    perMessageDeflate: false,
  });
  const pendingAudio = [];
  let pendingBytes = 0;
  let upstreamStarted = false;
  let closing = false;
  let clientAlive = true;

  activeConnections += 1;
  activeByIp.set(ip, (activeByIp.get(ip) || 0) + 1);
  publicLog("client_connected", { sessionId, activeConnections });

  const sendClientJson = (body) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(body));
  };

  const releaseConnection = () => {
    activeConnections = Math.max(0, activeConnections - 1);
    const count = Math.max(0, (activeByIp.get(ip) || 1) - 1);
    if (count === 0) activeByIp.delete(ip);
    else activeByIp.set(ip, count);
  };

  const closeBoth = (code = 1000, reason = "closed") => {
    if (closing) return;
    closing = true;
    clearTimeout(sessionTimer);
    clearInterval(pingTimer);

    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(JSON.stringify({ type: "CANCEL" }));
      upstream.close(code, reason);
    } else if (upstream.readyState === WebSocket.CONNECTING) {
      upstream.terminate();
    }
    if (client.readyState === WebSocket.OPEN) client.close(code, reason);
    releaseConnection();
    publicLog("client_closed", { sessionId, code, activeConnections });
  };

  const sessionTimer = setTimeout(() => {
    sendClientJson({ type: "LOCAL_ERROR", err_no: -10, err_msg: "单次识别已达到最长时限" });
    closeBoth(1000, "session limit");
  }, MAX_SESSION_MS);

  const pingTimer = setInterval(() => {
    if (!clientAlive) return closeBoth(1001, "heartbeat timeout");
    clientAlive = false;
    if (client.readyState === WebSocket.OPEN) client.ping();
  }, 25_000);

  client.on("pong", () => {
    clientAlive = true;
  });

  upstream.on("open", () => {
    upstream.send(JSON.stringify({
      type: "START",
      data: {
        appid: speechAppId,
        appkey: speechApiKey,
        dev_pid: 15372,
        cuid: `shiguang-${sessionId}`,
        format: "pcm",
        sample: 16000,
      },
    }));
    upstreamStarted = true;
    for (const frame of pendingAudio.splice(0)) upstream.send(frame, { binary: true });
    pendingBytes = 0;
    publicLog("upstream_connected", { sessionId });
  });

  upstream.on("message", (data) => {
    const payload = data.toString();
    try {
      const message = JSON.parse(payload);
      publicLog("upstream_message", {
        sessionId,
        type: String(message?.type || "UNKNOWN"),
        errorCode: Number(message?.err_no || 0),
        resultLength: String(message?.result || "").length,
      });
    } catch {
      publicLog("upstream_message_invalid", { sessionId, bytes: Buffer.byteLength(payload) });
    }
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });

  upstream.on("error", (error) => {
    publicLog("upstream_error", { sessionId, message: error.message });
    sendClientJson({ type: "LOCAL_ERROR", err_no: -1, err_msg: "百度实时语音识别连接失败" });
    closeBoth(1011, "upstream error");
  });

  upstream.on("close", (code, reason) => {
    publicLog("upstream_closed", {
      sessionId,
      code,
      reason: reason.toString().slice(0, 80),
    });
    if (!closing) closeBoth(safeCloseCode(code), reason.toString().slice(0, 80) || "upstream closed");
  });

  client.on("message", (data, isBinary) => {
    if (isBinary) {
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data);
      if (frame.byteLength === 0 || frame.byteLength > MAX_CLIENT_MESSAGE_BYTES) {
        sendClientJson({ type: "LOCAL_ERROR", err_no: -3, err_msg: "音频帧大小无效" });
        return closeBoth(1009, "invalid audio frame");
      }
      if (upstreamStarted && upstream.readyState === WebSocket.OPEN) {
        upstream.send(frame, { binary: true });
      } else {
        pendingAudio.push(frame);
        pendingBytes += frame.byteLength;
        while (pendingBytes > MAX_PENDING_AUDIO_BYTES && pendingAudio.length > 0) {
          pendingBytes -= pendingAudio.shift().byteLength;
        }
      }
      return;
    }

    let type = "";
    try {
      type = String(JSON.parse(data.toString())?.type || "");
    } catch {
      sendClientJson({ type: "LOCAL_ERROR", err_no: -2, err_msg: "无效控制帧" });
      return;
    }

    if (!["FINISH", "CANCEL"].includes(type)) return;
    if (upstream.readyState === WebSocket.OPEN) upstream.send(JSON.stringify({ type }));
    if (type === "CANCEL") closeBoth(1000, "cancelled");
  });

  client.on("error", () => closeBoth(1011, "client error"));
  client.on("close", () => closeBoth(1000, "client closed"));
});

server.listen(PORT, "0.0.0.0", () => {
  publicLog("server_started", {
    port: PORT,
    testPage: ENABLE_TEST_PAGE,
    allowedOriginCount: allowedOrigins.size,
  });
});

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  publicLog("shutdown_started", { signal, activeConnections });
  for (const client of socketServer.clients) client.close(1001, "server shutdown");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
