# 参考项目功能代码对照表

> 检索日期：2026-08-20。对照对象：本项目的当前功能 vs GitHub 开源项目
> 及既定参考项目（OpenClaw / Mastra / LiveKit Agents JS / ElevenLabs
> Agents SDK / OpenDex / OpenCrabs / Prime Agent）中的已有实现。
>
> 依据架构参考政策：只吸收架构与设计，不复制大量代码。

## 功能对照

| 我们的功能 | GitHub / 参考项目中的已有实现 | 可吸收点（架构层面） |
|---|---|---|
| Agent 循环（tool loop / 流式 / 超时 / 重试） | Mastra `packages/core/src/agent-controller`、`loop`、`tool-loop-agent`；OpenClaw `src/agents`、`src/process`；LiveKit `agents/`（语音循环） | 循环状态机、每轮超时/重试、子代理委托 |
| 工具系统（ToolRegistry/Schema/Result） | Mastra `packages/core/src/tools`（typed tools + 参数校验 + HITL）；OpenClaw `src/skills`、`src/tools`；OpenDex `src/skills` | 工具 schema 校验、provider 化、工具生命周期 |
| 权限审批（L0-L3 / 超时 / allow-once） | OpenDex `src/main/agent/permissions.ts`：`allow_once/always/deny/never` + 120s 自动拒绝 + 独立弹窗；Mastra `tools/hitl.md`：`requireToolApproval` / `approveToolCall` / `declineToolCall` | 增加 `always/never` 记忆化决策、独立审批弹窗 |
| 持久工作区 + 命令执行（server.shell / /projects） | Mastra `packages/core/src/workspace`：Filesystem + Sandbox + Search + LSP 可插拔；OpenClaw `src/process`（exec.ts、terminal-pty.ts、command-queue、kill-tree、respawn-child-runner、secret-input）；OpenHands（Docker 沙箱工作区） | 命令队列/并发控制、进程树 kill、PTY、输出解码、密钥重定向 |
| Docker / 容器控制（部署新服务） | OpenClaw `src/fleet/containers.runtime.ts`：cell-profile + 容器运行时 + 输出脱敏；OpenHands（Docker sandbox）；dev-agency-in-a-box（Compose 自主部署） | cell 化容器模板、日志脱敏、失败回滚 |
| 自我开发 / 自我进化（self.* / dsh） | auto-harness（göd-agent：单 bash 工具 + 单循环 + mod 热重载）；iterate（GrayCodeAI：拥有自己仓库、定时读代码/issue 决定改进）；self_improving_coding_agent（MaximeRobeyns）；Prime Agent `prime-agent-runtime/src/rlm/harness.py` | “一个 shell + 循环”的最小自主形态、定期自省、mod 热重载 |
| 记忆系统 | OpenClaw `src/memory`；Mastra `packages/core/src/memory`；OpenCrabs `src/brain/memory_recall.rs`、`hints.rs` | 混合检索、提示注入、记忆分层 |
| 失败反馈台账 / 学习 | OpenCrabs `src/brain/feedback_policy.rs`：区分“可恢复失败”与“真缺陷”，防止误禁工具 | 反馈分类器（我们 self.refine 目前过粗） |
| 重启恢复 / 快照回滚 | OpenCrabs `src/cli/crash_recovery.rs`（崩溃后版本回滚）；OpenClaw `src/snapshot`、`src/backup.runtime.ts` | 启动自检 + 快照回滚 UI |
| 多渠道接入（微信/Telegram/Discord…） | OpenClaw `src/channels`（channel-catalog、account、allowlist、command-gating）；OpenCrabs `src/channels`；Mastra agent channels（webhook + 多用户线程）；微信经 `@tencent-weixin/openclaw-weixin-cli`（本项目已用同源思路） | 渠道抽象、账号状态管理、allowlist |
| 定时任务 / 提醒 | OpenClaw `src/cron`、`src/tasks`；OpenCrabs `src/cron/scheduler.rs`；Mastra `schedules` | cron 持久化、到期事件推送 |
| 语音（ASR / TTS / 实时对话） | LiveKit Agents JS `agents/` 管线 + `plugins/*/stt.ts|tts.ts`（elevenlabs/assemblyai/azure…）；ElevenLabs Agents SDK；OpenClaw `src/realtime-transcription`、`src/tts` | 插件化 STT/TTS、音频事件驱动循环 |
| 屏幕视觉 / computer-use | OpenDex `src/skills/computer`（screen-capture.ts + skill.ts）；Mastra `browser`；OpenClaw `src/media-understanding` | 截图签名防过期、坐标点击校验 |
| 网页搜索 / 抓取 | OpenClaw `src/web-search`、`src/web-fetch`；Mastra search | 抓取清洗、结果截断 |
| 云服务器管理（腾讯云 cloud.*） | 无直接对应（腾讯生态特有）；OpenClaw fleet 是通用容器层 | 保留自研，参考其容器管理抽象 |
| 重启完成自动通知（system.boot → 微信推送） | 无直接对应；OpenClaw channels 的主动推送思路 | 保留自研闭环 |
| 桌面光球 UI | 无直接对应（参考 Apple 视觉语言自研） | 保留 |

## GitHub 上的其他高相关项目（非既定参考）

- **OpenHands**（OpenHands/OpenHands）：自托管 AI 软件开发代理，Docker 沙箱 +
  持久 workspace + 多 agent 后端（Claude Code / Codex 均可接入）——与
  “云服务器即她的世界”最接近的成熟实现
- **auto-harness / göd-agent**（tejpalv/auto-harness）：169 行自我进化 agent，
  只用一个 bash 工具 + 一个循环，靠写 mod 热重载自己——印证 server.shell +
  self.refine 的方向是正确的，且足够小值得通读
- **iterate**（GrayCodeAI/iterate）：拥有自己仓库的自我进化编码 agent，
  定时读源码/journal/issue 自主决定改进——self.* 闭环的参考
- **dev-agency-in-a-box**（ArneNostitz）：Docker Compose 上跑自主 GitHub-issue
  开发团队——“世界内部署”参考
- **sandboxed.sh**（Th0rgal）：自主 agent 的安全沙箱运行时——沙箱化参考
- **@cjbuilds/agent-os / omerfaruk-agent-os / microsoft/agent-governance-toolkit**：
  “Agent 操作系统”概念（任务/目标/收件箱/治理）——与 JARVIS 愿景一致

## 结论：建议优先吸收的 4 个点

1. **OpenClaw 的 process 执行引擎**：我们的 `server.shell` 目前只有 spawn +
  超时，OpenClaw 有命令队列、进程树 kill、PTY、输出解码、密钥重定向——
  直接决定“世界”的稳定性
2. **Mastra Workspace 抽象**：文件系统 + 沙箱 + 搜索 + LSP 可插拔，
  把我们的 `/projects` + shell + 文件工具整理成同一个工作区接口
3. **OpenDex 权限 UX**：`allow_once/always/deny/never` + 超时自动拒绝，
  我们的 ApprovalRegistry 已接近，补上 always/never 记忆化即可
4. **OpenCrabs 失败反馈分类器**：区分“可恢复失败”与“真缺陷”，
  让 self.refine 只沉淀真正的教训，不误伤可用工具

## 落地进度

- ✅ ① server.shell 工程化（2026-08-20）：进程组树 kill（超时/取消清理
  孤儿进程）+ 环境密钥输出脱敏（[REDACTED]）+ 工作目录校验 + 测试
- ✅ ④ 失败反馈分类器：`failure-classifier.ts` 区分可恢复/缺陷/未知，
  工具失败自动在结果里标注 [失败分类]，self.refine 描述同步引导
- ⏸ ② Workspace 抽象：暂缓——当前 /projects + server.shell + 文件工具
  已覆盖场景，过早抽象违反本项目“禁止过度工程化”原则
- ⏸ ③ 权限 always/never：暂缓——全权限模式（AUTO_APPROVE_ALL=true）
  下不会弹审批，等回退到正常权限模式时再补（含桌面 UI 支持）
