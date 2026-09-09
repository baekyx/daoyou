# 百度短语音识别 REST API 接入

本项目已经完成前端录音、WebM 解码、16 kHz 单声道 16-bit WAV 转换，以及
Supabase Edge Function 调用。浏览器调用链如下：

```text
浏览器录音
  -> src/lib/voiceApi.ts（转成 WAV + Base64）
  -> Supabase Edge Function: short-speech-recognition
  -> 百度 OAuth 获取/缓存 access_token
  -> 百度短语音识别 REST API
  -> 返回 result[0]
```

## 为什么必须经过服务端

百度官方说明浏览器不能直接跨域调用语音接口。更重要的是，Secret Key 不能写进
`VITE_*` 环境变量、前端源码或项目根目录的 `.env`：Vite 会把 `VITE_*` 内容打包并
暴露给浏览器。本项目将凭证保存为 Supabase Edge Function secrets。

## 先确认后端归属

这是一个秒哒源码导出项目。当前根目录 `.env` 仍连接秒哒托管后端；本地修改
`supabase/functions/short-speech-recognition/index.ts` 不会自动更新秒哒线上函数。
秒哒官方源码导出文档也说明：涉及后端和三方 API 的导出项目，需要开发者自行接入
Supabase 并进行二次开发。

因此有两条可行路径：

- 只在本机验证：直接运行 Vite；开发服务器会通过本机服务端调用百度，不需要 Docker。
- 准备独立部署：创建你自己的 Supabase 项目，导入本仓库 migrations，再部署函数。

## 1. 准备百度应用

在百度智能云控制台确认：

1. 应用已开通“短语音识别标准版”能力。
2. 你拿到的是该应用的 `API Key` 和 `Secret Key`。
3. 应用仍有免费额度、次数包或已开通后付费。

官方文档：

- 产品说明：https://cloud.baidu.com/doc/SPEECH/s/qlcirqhz0
- 鉴权认证：https://cloud.baidu.com/doc/SPEECH/s/Em8snejw1
- REST API：https://cloud.baidu.com/doc/SPEECH/s/Jlbxdezuf

## 2. 独立部署时连接自己的 Supabase

在项目根目录执行：

```bash
cd /Users/BitLukou-004/Downloads/app-d04hti6zlz42-4
npx supabase login
npx supabase link --project-ref <你的 Supabase project ref>
```

`project ref` 是 Supabase 项目标识，不是百度 AppID。当前秒哒托管后端不能直接
视为你的官方 Supabase 项目；请使用你自己创建的 Supabase 项目。

首次连接自己的空项目后，导入本仓库数据库 migrations：

```bash
npx supabase db push
```

## 3. 安全写入百度密钥

新建仅供本机使用、已被 `.gitignore` 排除的 `supabase/.env.local`：

```dotenv
BAIDU_API_KEY=你的_API_Key
BAIDU_SECRET_KEY=你的_Secret_Key
```

用文件写入 secrets，避免真实值出现在 shell history：

```bash
npx supabase secrets set --env-file supabase/.env.local
```

不要在命令中直接写明文，也不要加 `VITE_` 前缀。

确认变量名已经存在：

```bash
npx supabase secrets list
```

列表只需出现 `BAIDU_API_KEY`、`BAIDU_SECRET_KEY`；不要把真实值截图或提交到 Git。

## 4. 部署 Edge Function

```bash
npx supabase functions deploy short-speech-recognition
```

前端已经通过：

```ts
supabase.functions.invoke("short-speech-recognition", { body: { ... } })
```

调用，因此函数部署完成后无需把百度密钥添加到前端。

## 5. 本地联调

本项目的开发模式已经内置本机百度 API 路由。确认 `supabase/.env.local` 包含：

```dotenv
BAIDU_API_KEY=你的_API_Key
BAIDU_SECRET_KEY=你的_Secret_Key
```

然后启动前端：

```bash
pnpm install
pnpm dev
```

开发环境调用链为：

```text
浏览器 -> Vite 本机服务端 -> 百度 API
```

密钥只由 Vite 的 Node 进程读取，不会打进浏览器。正式构建时调用链仍为：

```text
浏览器 -> Supabase Edge Function -> 百度 API
```

允许浏览器麦克风权限，在导游讲解页面录制一句 60 秒以内的普通话。成功响应类似：

```json
{
  "err_no": 0,
  "err_msg": "success.",
  "result": ["今天天气很好。"],
  "sn": "..."
}
```

## 接口参数

Edge Function 接收 JSON：

| 字段 | 必填 | 当前项目值 | 说明 |
| --- | --- | --- | --- |
| `speech` | 是 | WAV 的 Base64 | 不能包含 Data URL 前缀 |
| `len` | 是 | WAV 原始字节数 | 不是 Base64 字符串长度 |
| `format` | 否 | `wav` | 支持 `pcm/wav/amr/m4a` |
| `rate` | 否 | `16000` | 支持 `16000`、`8000` |
| `cuid` | 否 | `web-guide-user` | 60 字符以内的用户/设备标识 |
| `dev_pid` | 否 | `1537` | 识别模型 |

标准版当前常用模型：

| `dev_pid` | 语言 |
| --- | --- |
| `1537` | 普通话 |
| `1737` | 英语 |
| `1637` | 粤语 |
| `1837` | 四川话 |

音频必须是单声道、16-bit，且不超过 60 秒。项目当前会在浏览器中自动转换成
16 kHz 单声道 16-bit WAV。

## 常见错误

| 错误/现象 | 排查方式 |
| --- | --- |
| `Server configuration error` | Edge Function 中没有配置两个百度 secret |
| `Baidu authentication failed` | API Key/Secret Key 不匹配，或不是同一百度应用 |
| 百度返回 `err_no: 3300/3301/3302` | 检查参数、服务权限和 access token |
| 百度返回 `err_no: 3304` | 调用量或并发达到限制，检查配额/计费 |
| 百度返回 `err_no: 3310` | 音频时长超过限制 |
| `speech quality error` | 确认 16 kHz、16-bit、单声道，并减少噪声 |
| 浏览器录音失败 | 使用 HTTPS 或 localhost，并允许麦克风权限 |

生产环境建议同时限制 Edge Function 的允许来源、启用用户鉴权和调用频率限制，
避免匿名用户消耗你的百度额度。
