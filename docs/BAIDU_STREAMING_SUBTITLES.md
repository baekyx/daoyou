# 百度流式字幕本地接入

本地项目已新增百度“实时语音识别 WebSocket API”链路：

2026-07-30 已使用真实语音应用完成端到端验证，能够收到 `MID_TEXT` 临时字幕和
`FIN_TEXT` 最终字幕。

```text
浏览器麦克风
  -> Web Audio 转 16 kHz / 单声道 / 16-bit PCM
  -> 每 160 ms 向本地 Vite WebSocket 网关发送一帧
  -> 本地网关携带百度语音 AppID + API Key 连接百度
  -> MID_TEXT 作为正在识别的临时字幕
  -> FIN_TEXT 保存为正式字幕
  -> 后台调用百度机器翻译与短文本在线合成
```

真实密钥只保存在已忽略的 `supabase/.env.local`，不会发送到浏览器。需要的服务端变量：

```dotenv
BAIDU_SPEECH_APP_ID=语音应用的数字AppID
BAIDU_API_KEY=语音应用APIKey
BAIDU_SECRET_KEY=语音应用SecretKey
```

实时识别鉴权实际使用 AppID 和 API Key；Secret Key 继续供短语音 REST、OAuth 和语音
合成使用。项目使用带加强标点的普通话模型 `dev_pid=15372`。

如果实时 WebSocket 配置缺失、鉴权失败或连接异常，讲解页会自动回退到原来的 3 秒
短语音识别切片，避免整条字幕功能中断。

百度可能针对某一句返回 `-3005 / asr server not find`。该错误只影响当前句，连接仍可
继续处理后续语音，因此本项目会记录警告并继续流式识别，不会再触发整条链路降级。

本地临时字幕通过现有房间 Realtime channel 的 broadcast 事件同步给游客，不写入
数据库；百度返回 `FIN_TEXT` 后才写入 `subtitles`，随后再生成英文字幕和英文语音。

独立生产部署需要提供可公开访问的 WebSocket 网关，并通过
`VITE_STREAMING_ASR_WS_URL` 指向该网关。不要把百度 API Key 写入 `VITE_*`。
