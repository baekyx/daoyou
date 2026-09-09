# 项目外部 API 与服务清单

审计日期：2026-07-30。本清单只描述本地源码，不代表秒哒线上版本已经修改。

## 当前结论

| 能力 | 本地实现 | 当前凭证实测 | 下一步 |
| --- | --- | --- | --- |
| 短语音识别 | 百度短语音识别标准版 REST API | 可用 | 无 |
| 流式字幕 | 百度实时语音识别 WebSocket API | 本地端到端实测可用 | 无 |
| 中英文本翻译 | 百度文本翻译-通用版 | 独立应用凭据实测可用 | 无 |
| 英文语音播报 | 百度短文本在线合成 | 实测可用 | 无 |
| 数据库/登录/存储/Realtime/Edge Functions | Supabase | 当前仍指向秒哒托管地址 | 本地独立运行需自建 Supabase |
| 微信网页登录 | 微信公众平台 OAuth | 未配置 | 提供公众号 AppID、AppSecret |
| 跨设备中文原声 | 百度实时音视频 RTC Web SDK | AppID/AppKey 双端实测可用 | 本地已接入，失败时回退原直连 WebRTC |
| 前端错误监控 | Sentry（可选） | 未配置 DSN 时不上报 | 可不申请；需要监控时申请 Sentry |

## 已移除的秒哒 API 网关依赖

以下三项本地源码不再调用 `*.gateway.appmiaoda.com`：

- 短语音识别
- 文本翻译
- 语音合成

三者都从 Supabase Edge Function 读取服务端密钥。短语音识别默认使用：

```dotenv
BAIDU_API_KEY=...
BAIDU_SECRET_KEY=...
BAIDU_SPEECH_APP_ID=...
```

如果机器翻译或语音合成属于不同的百度应用，可以分别配置：

```dotenv
BAIDU_TRANSLATION_APP_ID=...
BAIDU_TRANSLATION_API_KEY=...
BAIDU_TRANSLATION_SECRET_KEY=...
BAIDU_TTS_API_KEY=...
BAIDU_TTS_SECRET_KEY=...
```

`BAIDU_TRANSLATION_APP_ID` 仅用于记录应用归属；当前 OAuth 版接口实际使用 API Key
和 Secret Key。未提供服务专用凭据时，会回退到通用的 `BAIDU_API_KEY` 和
`BAIDU_SECRET_KEY`。

密钥不得添加 `VITE_` 前缀，也不得写入前端源码。

本机开发时，Vite 通过服务端中间件读取 `supabase/.env.local` 并代理百度请求；生产
构建不会包含这些密钥。

## 百度服务开通状态

### 1. 文本翻译-通用版

用途：将导游产生的中文字幕翻译成英文字幕。

控制台路径：

```text
百度智能云控制台
→ 机器翻译
→ 文本翻译
→ 文本翻译-通用版
→ 开通免费测试资源、次数包或按量后付费
```

官方接口：

```text
POST https://aip.baidubce.com/rpc/2.0/mt/texttrans/v1
```

原短语音应用的 Key 返回错误码 `6`：`No permission to access data`。项目已经改为
使用独立的机器翻译应用凭据，并于 2026-07-30 完成真实中译英调用验证。

### 2. 短文本在线合成

用途：游客开启英文语音后，把英文字幕合成为可播放音频。

控制台路径：

```text
百度智能云控制台
→ 语音技术
→ 语音合成
→ 短文本在线合成
→ 开通免费测试资源、次数包或按量后付费
```

官方接口：

```text
POST https://tsn.baidu.com/text2audio
```

百度此接口使用中英文混合模式，当前凭据已完成真实英文 MP3 合成验证。英文自然度
仍需在游客真机试听；如果效果达不到导游产品要求，再申请专门的英文 TTS：

- 百度智能云大模型语音合成；或
- MiniMax Speech；或
- Azure AI Speech。

不要把第三方 TTS Key 写入浏览器。

### 3. 百度实时音视频 RTC

用途：把导游麦克风中文原声稳定传输到不同设备的游客端。

项目使用百度 RTC Web SDK `1.2.22`。AppKey 只保存在服务端：本地开发读取
`supabase/.env.development.local`，生产环境由
`supabase/functions/baidu-rtc-token` 读取 Supabase Secrets。浏览器只获取与
`AppID + RoomName + Uid` 绑定、两小时有效的 `004` Token；云端函数还会验证登录态
和房间成员身份。

```dotenv
VITE_BAIDU_RTC_APP_ID=...
BAIDU_RTC_APP_ID=...
BAIDU_RTC_APP_KEY=...
```

生产部署时还需发布 `baidu-rtc-token` Edge Function，并把
`BAIDU_RTC_APP_ID`、`BAIDU_RTC_APP_KEY` 写入函数 Secrets。AppKey 禁止使用
`VITE_` 前缀。

2026-07-30 已完成真实双端验证：发布端成功发布合成测试音频，订阅端成功进入同一
百度 RTC 房间并收到远端音频流。百度 RTC 登录失败时，应用会自动回退到原有
Supabase 信令 + WebRTC 直连方案。

## 百度无法直接替代的服务

### Supabase

项目依赖数据库、认证、对象存储、Realtime 和 Edge Functions。百度语音 API 不提供
这些通用后端能力。若要完全脱离秒哒托管后端，最省改造成本的是创建自己的 Supabase
项目并执行仓库中的 migrations。

### 微信登录

需要已认证的微信公众号网页授权能力，以及：

```dotenv
WECHAT_APPID=...
WECHAT_APPSECRET=...
```

这两个值属于微信公众平台，百度 API 无法替代。

### 原生 WebRTC 的 TURN 回退

百度 RTC 正常工作时不再依赖项目自行配置 TURN。只有百度 RTC 不可用且应用自动
回退到原生 WebRTC 时，跨运营商或严格 NAT 网络才需要另行配置 TURN。可选择：

- 在任意云服务器（包括百度智能云 BCC）自建 coturn；
- 购买支持临时凭据的 TURN 服务。

生产环境不要长期把固定 TURN 密码打包在 `VITE_TURN_CREDENTIAL` 中，建议由后端签发
短期凭据。

## 非 API 外部依赖

本地 CSS 仍引用少量秒哒/BOS CDN 图片，正式独立部署前建议下载到 `public/`，避免
未来源站失效。它们不是 API，不涉及百度 API Key。
