# 拾光旅伴实时 ASR 网关

这是从本地 Vite 开发插件中拆出的独立 Node.js WebSocket 服务，目标运行环境为百度 BCI。

## 接口

- `GET /healthz`：存活与就绪检查，不返回密钥。
- `WS /api/realtime-asr`：接收 16 kHz、单声道、16-bit little-endian PCM，并转发百度实时语音识别结果。
- `GET /`：仅当 `ENABLE_TEST_PAGE=true` 时提供移动端麦克风测试 HTML。

## 本地启动

```bash
cp .env.example .env.local
# 只在 .env.local 中填写服务端密钥，不要提交该文件
set -a
source .env.local
set +a
npm install
npm start
```

访问：`http://127.0.0.1:8080/`

如果复用项目现有 `supabase/.env.local`，还需要为测试页和来源白名单补充：

```bash
export BAIDU_SPEECH_API_KEY="$BAIDU_API_KEY"
export ENABLE_TEST_PAGE=true
export ALLOWED_ORIGINS=http://127.0.0.1:8080,http://localhost:8080
node src/server.mjs
```

## Docker

```bash
docker build -t shiguang-asr-gateway:v1 .
docker run --rm --env-file .env.local -p 8080:8080 shiguang-asr-gateway:v1
```

Apple 芯片 Mac 推送 BCI 前：

```bash
docker buildx build --platform linux/amd64 -t <CCR地址>/<命名空间>/shiguang-asr-gateway:v1 --load .
```

## BCI 最小配置

- 重启策略：总是重启。
- 容器端口：`8080/TCP`。
- 健康检查：`GET /healthz`，端口 8080。
- Secret 环境变量：`BAIDU_SPEECH_APP_ID`、`BAIDU_SPEECH_API_KEY`。
- 普通环境变量：`ALLOWED_ORIGINS`、连接限制变量。
- 网络：允许出站访问 `vop.baidu.com:443`。
- 生产测试结束后设置 `ENABLE_TEST_PAGE=false`。

正式 H5 使用：

```dotenv
VITE_STREAMING_ASR_WS_URL=wss://<网关域名>/api/realtime-asr
```

`VITE_STREAMING_ASR_WS_URL` 是公开网关地址，不是密钥；百度 AppID/API Key 只能存在于 BCI 服务端。

## 安全边界

当前版本通过明确的 Origin 白名单、并发限制、单连接时长和帧大小限制保护基础额度。正式大规模开放前，还应增加用户会话与房间所有权校验；浏览器 Origin 不能替代完整身份鉴权。
