# 拾光旅伴（Daoyou）

面向线下讲解场景的移动端 H5 应用。导游可创建讲解房间并实时播报，游客通过房间号或邀请链接加入，摄影师在同一房间内完成照片上传与管理。系统同时提供实时字幕、中文转英文、英文语音播报、知识卡片和讲解记录。

原始项目来自[百度秒哒](https://www.miaoda.cn/projects/app-d04hti6zlz42)，当前仓库用于源码维护和独立部署。

## 主要功能

| 角色 | 功能 |
| --- | --- |
| 导游 | 创建和结束房间、语音讲解、查看成员与问题、管理并推送景区知识卡片、回看讲解记录 |
| 游客 | 搜索或凭密码加入房间、收听讲解、查看双语字幕、提问、接收知识卡片、浏览相册和历史记录 |
| 摄影师 | 加入拍摄任务、上传照片、管理房间相册、处理照片删除申请 |

公共能力包括手机号登录、微信网页授权、角色切换、房间成员状态、通知、帮助反馈与账户注销。

## 技术架构

- 前端：React 18、TypeScript、Vite、Tailwind CSS、Radix UI
- 后端：Supabase Auth、PostgreSQL、Realtime、Storage、Edge Functions
- 语音与翻译：百度短语音识别、实时语音识别、文本翻译、语音合成、百度 RTC
- 监控：Sentry（可选）

浏览器只持有公开配置。百度 AppKey、微信 AppSecret 等服务端密钥由本地 Vite 中间件或 Supabase Edge Functions 读取，不会打入生产前端包。

## 本地启动

### 环境要求

- Node.js 20 或更高版本
- pnpm

### 安装与运行

```bash
git clone https://github.com/baekyx/daoyou.git
cd daoyou
pnpm install
cp .env.example .env.local
pnpm dev -- --host 127.0.0.1
```

浏览器打开 `http://127.0.0.1:5173`。

首次运行前，需要在 `.env.local` 中填写有效的 `VITE_SUPABASE_ANON_KEY`。仓库示例配置仍指向秒哒托管的 Supabase；若要独立部署，请改为自己的 Supabase URL 和 Anon Key，并执行本仓库的数据库迁移。

开发环境可访问 `http://127.0.0.1:5173/?demo` 注入演示房间数据。该模式只用于界面开发和流程检查。

## 环境变量

前端变量放在根目录 `.env.local`：

| 变量 | 必需 | 用途 |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | 是 | Supabase 项目地址 |
| `VITE_SUPABASE_ANON_KEY` | 是 | Supabase 匿名访问密钥 |
| `VITE_BAIDU_RTC_APP_ID` | RTC 场景 | 可公开的百度 RTC AppID |
| `VITE_STREAMING_ASR_WS_URL` | 流式字幕 | 生产环境流式识别网关的 `wss://` 地址 |
| `VITE_WECHAT_APPID` | 微信登录 | 微信公众号 AppID |
| `VITE_SENTRY_DSN` | 否 | 前端错误监控；留空时不上报 |
| `VITE_TURN_URLS` 等 | WebRTC 回退 | 百度 RTC 不可用时的 TURN 配置 |

服务端密钥在本地开发时放入 `supabase/.env.local`，部署时写入 Supabase Secrets。不要给这些变量添加 `VITE_` 前缀：

```dotenv
BAIDU_API_KEY=
BAIDU_SECRET_KEY=
BAIDU_SPEECH_APP_ID=
BAIDU_TRANSLATION_API_KEY=
BAIDU_TRANSLATION_SECRET_KEY=
BAIDU_TTS_API_KEY=
BAIDU_TTS_SECRET_KEY=
BAIDU_RTC_APP_ID=
BAIDU_RTC_APP_KEY=
WECHAT_APPID=
WECHAT_APPSECRET=
```

完整字段和注意事项见 [`.env.example`](.env.example) 与 [`supabase/secrets/required.json`](supabase/secrets/required.json)。所有 `.env.local` 文件均已被 Git 忽略。

## Supabase 独立部署

准备好 Supabase CLI 并登录后，连接目标项目并应用迁移：

```bash
npx supabase link --project-ref <project-ref>
npx supabase db push
npx supabase secrets set --env-file supabase/.env.local
```

根据实际启用的能力部署 Edge Functions：

```bash
npx supabase functions deploy register-user
npx supabase functions deploy delete-account
npx supabase functions deploy wechat-auth
npx supabase functions deploy short-speech-recognition
npx supabase functions deploy text-translation
npx supabase functions deploy tts-baidu
npx supabase functions deploy baidu-rtc-token
```

数据库迁移位于 [`supabase/migrations`](supabase/migrations)，当前合并结构可参考 [`supabase/schema.sql`](supabase/schema.sql)。生产环境还需要按业务需要配置 Storage、Realtime、手机号认证和微信公众平台回调地址。

## 构建与检查

```bash
# TypeScript 类型检查
pnpm typecheck

# 生产构建，产物输出到 dist/
pnpm build

# 项目综合检查
pnpm lint
```

可将 `dist/` 部署到支持单页应用的静态托管平台。部署平台需要把所有前端路由回退到 `index.html`。

## 目录结构

```text
src/
  api/          数据访问与业务接口
  components/   通用组件
  contexts/     登录与全局状态
  hooks/        房间 Presence、RTC 等 Hooks
  i18n/         界面语言与翻译文案
  lib/          语音、网络、邀请链接等基础模块
  pages/        导游、游客、摄影师及账户页面
supabase/
  functions/    Edge Functions
  migrations/   数据库迁移
docs/           API 接入与部署说明
local-api/      本地开发用百度 API 代理
asr-gateway/    流式语音识别网关
public/         静态资源
```

## 相关文档

- [`docs/API_SERVICES.md`](docs/API_SERVICES.md)：外部服务、开通状态与替代关系
- [`docs/BAIDU_SHORT_SPEECH.md`](docs/BAIDU_SHORT_SPEECH.md)：百度短语音识别配置与联调
- [`docs/BAIDU_STREAMING_SUBTITLES.md`](docs/BAIDU_STREAMING_SUBTITLES.md)：流式字幕网关接入

## 当前部署边界

- 仓库默认配置仍依赖秒哒托管的 Supabase，独立部署前必须替换项目地址和密钥。
- 微信登录需要已认证公众号及正确的网页授权域名。
- 百度 RTC 失败时会回退到原生 WebRTC；跨运营商或严格 NAT 网络需要 TURN。
- `public/` 与样式中仍可能引用少量外部 CDN 图片，正式上线前建议迁移到自有静态资源。
