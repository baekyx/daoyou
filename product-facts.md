# U-Claw / OpenClaw 官方事实核验

核验日期：2026-08-08（Asia/Shanghai）

本文件只记录用于《曾煜曦需求审核报告》的外部事实，不替代实机 PoC。

1. OpenClaw 当前官方安装要求为 Node 22.22.3+、24.15+ 或 25.9+，推荐 Node 26；支持原生 Windows，但官方同时提供 Windows Hub、PowerShell CLI installer 与 WSL2 Gateway 路径。
   - https://github.com/openclaw/openclaw/blob/main/docs/install/index.md
2. 官方支持 `OPENCLAW_HOME`、`OPENCLAW_STATE_DIR`、`OPENCLAW_CONFIG_PATH`、`OPENCLAW_WORKSPACE_DIR` 等路径变量；未公开的 `OPENCLAW_*` 变量属于内部实现，不能作为量产合同。
   - https://docs.openclaw.ai/help/environment
3. Provider 密钥不能依赖 agent workspace 内的 `.env`；可信来源包括 Gateway 进程环境、`$OPENCLAW_STATE_DIR/.env`、主配置的 `env` 块或 SecretRef。
   - https://docs.openclaw.ai/help/environment
   - https://docs.openclaw.ai/gateway/security
4. Agent workspace 只是默认工作目录，不是硬沙箱；绝对路径仍可能访问宿主机，除非另行启用 sandbox / tool policy。
   - https://docs.openclaw.ai/concepts/agent-workspace
5. 多 Agent 不是单一 `agents` 表：每个 Agent 有 workspace、agentDir、auth profile 与 session store；当前会话状态还涉及 `openclaw-agent.sqlite` 和 sessions 目录。
   - https://docs.openclaw.ai/multi-agent
   - https://docs.openclaw.ai/concepts/agent-workspace
6. 官方安全基线要求 Gateway 优先 loopback、启用认证、限制工具和文件访问，并建议运行 `openclaw security audit --deep`。磁盘上会保存可读的会话记录，磁盘访问本身是信任边界。
   - https://docs.openclaw.ai/gateway/security
7. OpenClaw 主仓库为 MIT License，但量产仍需保留许可证与第三方 notices，并逐项核对随盘分发的 Node、依赖、知识库文档、字体和图片授权。
   - https://github.com/openclaw/openclaw
8. Windows 10 Home/Pro 22H2 已于 2025-10-14 结束支持；2026 年的新产品不宜把普通 Win10 写成无条件主支持平台。
   - https://learn.microsoft.com/en-us/lifecycle/announcements/windows-10-end-of-support

