# Qwen 私人 AI 助理

一个长期可扩展的个人 AI Assistant 的 Monorepo。设计蓝图见
[Grok_ElevenLabs_私人AI助理开发计划.md](./Grok_ElevenLabs_私人AI助理开发计划.md)，
架构说明见 [docs/architecture.md](./docs/architecture.md)。

> Qwen 负责"想"，Agent Core 负责"做"，Memory 负责"记"，
> 各终端负责"行动"。所有第三方服务都通过抽象层接入，以便未来替换。

## 当前状态

- Phase 0（项目骨架）：完成
- Phase 1（Qwen 文本 Agent MVP）：完成
- Phase 1.1（LLM Provider 可切换：Qwen / OpenRouter）：完成
- Phase 2（Persona 人格系统）：完成
- Phase 3（ElevenLabs 语音层）：完成
- Phase 4（实时语音 Agent）：完成
- Phase 5（Agent Core / 工具系统）：完成
- Phase 6（权限系统）：完成
- Phase 7（Memory System）：完成
- Phase 8（Task / Scheduler）：完成
- Phase 9（Windows Desktop Agent）：第一步完成（UI + 工具桥）
- 下一步：唤醒词、桌面端完善

## 目录结构

```text
├── apps/             # 桌面/Web/移动端（按计划后置，暂未实现）
├── services/
│   └── agent-server/ # Agent Server：Session + Streaming Chat
├── packages/
│   ├── core/         # Agent Context / Persona 抽象
│   ├── protocol/     # 统一消息协议
│   ├── types/        # 共享领域类型
│   ├── config/       # 环境变量统一管理
│   ├── llm/          # LLMProvider 抽象 + OpenAI 兼容流式工具
│   ├── openrouter/   # OpenRouterProvider（LLM 聚合网关）
│   ├── elevenlabs/   # STT/TTS 抽象（Phase 3 实现）
│   ├── memory/       # Session/Memory 存储抽象
│   └── tools/        # Tool 抽象与注册表
├── persona/          # 人格定义（Phase 2 已接入，文件修改即时生效）
├── infrastructure/   # Docker Compose / PostgreSQL
└── docs/             # 架构文档
```

## 前置要求

- Node.js >= 20（开发使用 24）
- Docker + Docker Compose（仅本地 PostgreSQL 需要）

## 快速开始

```bash
npm install
cp .env.example .env   # 填入 DASHSCOPE_API_KEY（或 OPENROUTER_API_KEY），以及 ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID
npm run infra:up       # 启动 PostgreSQL
npm run dev            # 启动 Agent Server（默认 :3000）
```

## LLM Provider

通过 `LLM_PROVIDER` 选择大脑：

- `dashscope`（默认）：千问 OpenAI 兼容接口，需要 `DASHSCOPE_API_KEY`；
  文字推理默认用 `DASHSCOPE_LLM_MODEL=qwen3.8-max`
- `openrouter`：走 OpenRouter 聚合网关，需要 `OPENROUTER_API_KEY`；
  `OPENROUTER_MODEL` 可换成任意 OpenRouter 模型 ID（如 `x-ai/grok-4.6`、`deepseek/deepseek-chat`）

选中的 Provider 没有配置 Key 时服务仍可启动，`/health` 会显示 `llm.configured: false`，
调用聊天接口会返回 503。

主模型未产出内容即失败时，可自动切换到备用后端（OpenCrabs 故障转移思路）：
`LLM_FALLBACK_PROVIDER=none|openrouter|dashscope`（默认 `none`），
`LLM_FALLBACK_MODEL` 指定备用模型（默认 `deepseek/deepseek-v4-pro`）。
流式输出一旦开始则不回滚，中途失败按既有错误路径重试/上报。

## 语音层（Phase 3）

语音链路（cascade 模式）：**Qwen ASR（实时转写）→ Qwen/OpenRouter（思考回复）→
ElevenLabs TTS（语音合成）**；默认 `s2s` 模式为 Qwen 端到端实时语音，通过
WebSocket 暴露给终端：

```text
WS /ws/voice/:sessionId
```

客户端先 `POST /api/sessions` 创建会话，再连接语音 WebSocket：

1. 服务端发送 `voice.ready`（含 `audioFormat: pcm_16000`）
2. 客户端持续发送 **二进制 PCM 音频**（16kHz 单声道 16-bit）
3. 服务端依次推送 `transcript.partial` / `transcript.final`
4. Qwen 生成回复时推送 `agent.thinking`；回复按句子流式切分，
   每句立即 `tts.start`（首句）或直接续传 `audio.chunk`（base64 音频）
5. 全部说完后推送 `tts.end`（含完整回复文本）与 `agent.done`

客户端可在对话中发送控制消息：

```json
{ "type": "interrupt" }
```

用于显式打断 AI 说话（例如按 PTT 键时）。服务端检测到 TTS 播放期间
用户开始说话（非空 partial transcript）也会自动打断，并推送
`tts.interrupted`（含原因 `user_speech` / `client` / `new_final_transcript`）。

注意：若使用扬声器外放且无回声消除，AI 自己的声音可能被麦克风重新拾取并
触发自我打断。终端播放 TTS 时应抑制麦克风输入（或本地 VAD + `interrupt` 消息）。

每个语音连接独立创建 STT/TTS 会话，多客户端并发互不干扰。

## Agent 工具系统（Phase 5）

AI 可以自主调用工具完成任务：`Agent → ToolRouter → Tool → Result`。

当前内置工具（`packages/tools`）：

| 工具                | 权限 | 说明                                 |
| ------------------- | ---- | ------------------------------------ |
| `time.get`          | L0   | 获取当前时间（可指定时区）           |
| `weather.get`       | L0   | 查询城市天气（Open-Meteo，无需 Key） |
| `web.search`        | L0   | 维基百科搜索                         |
| `filesystem.search` | L0   | 工作区内按文件名搜索（含通配符）     |
| `reminder.create`   | L1   | 创建提醒（内存存储）                 |
| `reminder.list`     | L0   | 列出提醒                             |
| `calendar.create`   | L1   | 创建日程（内存存储）                 |
| `calendar.list`     | L0   | 列出日程                             |
| `notification.send` | L2   | 发送通知（需用户确认）               |
| `filesystem.delete` | L3   | 删除文件（需二次确认）               |
| `memory.remember`   | L1   | 保存长期记忆                         |
| `memory.list`       | L0   | 列出长期记忆                         |
| `memory.forget`     | L1   | 永久删除记忆                         |
| `memory.edit`       | L1   | 修改记忆                             |
| `task.create`       | L1   | 创建定时任务（cron）                 |
| `task.list`         | L0   | 列出定时任务                         |
| `task.delete`       | L2   | 删除定时任务（需确认）               |
| `task.list-runs`    | L0   | 查看任务执行记录                     |

对话时如果 AI 决定调用工具，SSE / 语音 WS 会额外收到：

```json
{"type":"agent.tool_call",  "payload":{"toolCalls":[...]}}
{"type":"agent.tool_result","payload":{"callId":"...","name":"...","result":{...}}}
```

工具执行有 15 秒超时；超时、失败、权限不足都会作为结果回传给 AI，
由 AI 决定下一步（重试、换工具或直接回答）。L2/L3 工具（删除文件、发消息等）
执行前会请求用户确认：

```json
{
  "type": "permission.request",
  "payload": {
    "request": {
      "requestId": "...",
      "toolName": "filesystem.delete",
      "permissionLevel": 3,
      "confirmationsNeeded": 2,
      "confirmationsDone": 0
    }
  }
}
```

- L2 工具确认一次，L3 工具确认两次
- 文本客户端：`POST /api/sessions/:id/permission`，
  body `{"requestId":"...","approved":true}`（或 `approved:false, reason:"..."`）
- 语音客户端：发送 `{"type":"permission.response","requestId":"...","approved":true}`
- 60 秒未响应自动拒绝；拒绝/超时原因会回传给 AI

## 长期记忆（Phase 7）

三层记忆：**Short-term**（当前会话）+ **Episodic**（重要事件）+
**Semantic**（长期事实，如用户偏好）。AI 每轮对话前自动检索相关记忆
注入上下文，并通过 `memory.*` 工具自主维护：

```text
"记住我喜欢喝美式咖啡"   → memory.remember(semantic)
"我该点什么咖啡？"       → 检索注入 → AI 回答"来杯美式"
"忘记刚才那条"          → memory.forget(真实删除)
```

记忆存储：默认内存实现（本地语义检索）；配置 `DATABASE_URL` 后自动使用
PostgreSQL + pgvector（`npm run infra:up` 启动）。写入遵循规则：只保存
长期价值信息，不保存闲聊、密码、API Key 等敏感内容。

`GET /health` 会显示当前记忆后端（`memory` 或 `postgres`）。

## 定时任务（Phase 8）

让 AI 主动工作：`Scheduler → Task → Agent → Action`。直接对 AI 说
"每天 9 点检查杭州天气，如果下雨提醒我"，它会创建定时任务：

```text
task.create({ name, schedule: "0 9 * * *", action: "检查杭州天气，如果下雨提醒我" })
```

- 调度：Node.js 定时器每 30 秒检查一次 cron 到期（第一阶段，无队列）
- 执行：到点后任务指令通过完整 Agent Loop 无人值守执行
  （只能使用 L0/L1 工具；需要确认的工具会被拒绝）
- 运行记录：`task.list-runs` 查看每次执行的结果（成功/失败/输出）
- 主动通知：任务执行完成/失败时，桌面端通过 `GET /api/events`（SSE）收到
  `task.run` 事件并弹出系统通知（含任务名与结果摘要）
- 存储：内存或 PostgreSQL（`tasks` / `task_runs` 表）

## 提醒（一次性）

"20 秒后提醒我喝水"这类一次性提醒走 `reminder.create`（L1，自动执行）：
提醒存于内存，`ReminderService` 每 10 秒扫描一次到期提醒，到点通过
`GET /api/events`（SSE）的 `reminder.due` 事件推送到桌面端弹系统通知。
注意：提醒存储为内存实现，服务重启后未到期的提醒会丢失。

## 桌面端（Phase 9 第一步）

### 文件权限对齐

日常文件操作（移动、复制、写入、新建目录、压缩、解压、删除、打开路径）
均为 **L1 自动执行，无需确认**；删除会进回收站（可恢复），并拒绝磁盘
根目录与系统关键目录。只有 `system.power`（关机/重启/睡眠）为 L3 二次确认，
`terminal.run` 为 L3，`process.kill` / `screen.click` / `screen.type` 等
敏感操作为 L2 需确认。

### Siri 式 UI（`apps/desktop-ui`）

```bash
npm run desktop:ui
```

常驻后台的极简光体界面（Electron）：

- 中央**发光球体**：流动渐变 + 光晕 + 玻璃拟态面板 + Canvas 粒子
- 麦克风音量实时驱动光球波动（音频响应可视化）
- 全局热键唤醒（默认 `Ctrl+Alt+Space`）、托盘常驻
- 点击光球开始语音对话；再点结束/打断
- 视觉规范见 [desktop-ui/README.md](apps/desktop-ui/README.md)

### 桌面工具桥（`apps/desktop-agent`）

```bash
npm run desktop:agent
```

桌面端连接 `/ws/desktop` 后，AI 可直接操作这台电脑（工具走既有权限确认）：

| 工具              | 权限 | 说明                      |
| ----------------- | ---- | ------------------------- |
| `terminal.run`    | L3   | 执行 PowerShell 命令      |
| `app.launch`      | L2   | 启动应用 / 打开路径或 URL |
| `filesystem.move` | L1   | 移动/重命名文件           |
| `filesystem.copy` | L1   | 复制文件                  |
| `screen.capture`  | L0   | 截取主屏幕保存 PNG        |
| `window.list`     | L0   | 列出可见窗口              |

注意：`desktop:ui` 与 `desktop:agent` 是两个进程，可同时运行。

开发架构约束见 [AGENTS.md](./AGENTS.md)（参考项目仅作架构参考）。

配置项（`.env`）：

| 变量                  | 说明                                                      |
| --------------------- | --------------------------------------------------------- |
| `ELEVENLABS_API_KEY`  | ElevenLabs API Key（必填）                                |
| `ELEVENLABS_VOICE_ID` | 音色 ID（免费套餐需使用自己创建的音色）                   |
| `ELEVENLABS_MODEL`    | 语音模型，如 `eleven_v3`（默认 `eleven_multilingual_v2`） |
| `ELEVENLABS_LANGUAGE` | 语音/转写语言代码，中文用 `zh`                            |

### coding.run 后端（dsh / Claude Code）

`coding.run` 默认走 **dsh**（DeepSeek Harness：headless 一次性会话，Agent/工具/模型
适配器全部插件化，可扩展性强；模型用 DeepSeek 官方 `deepseek-v4-flash`），可用
`CODING_AGENT=claude` 切回 Claude Code（同一目录自动 `--resume` 续接会话）。

dsh 一次性机器配置：

```bash
npm install -g @deepseek-ai/dsh
dsh plugin --profile headless add dsh-llm-newapi
```

然后在 `$DSH_HOME`（默认 `~/.dsh`）下：

- `profiles/headless/package.json` 的 `dsh.profile.bundles` 加入 `"dsh-llm-newapi"`
- `profiles/headless/cordis.patch.yml` 把 `agent-default-model` 指向
  `deepseek-official` / `deepseek-v4-flash`（如需百炼 qwen，可换成 `newapi` / `qwen3.8-max`
  并配置 `baseURL: https://dashscope.aliyuncs.com/compatible-mode/v1`）
- `.credentials.yaml` 写入 `DEEPSEEK_API_KEY: <key>`（百炼 qwen 时则写 `newapi: <key>`）

常用命令：

| 命令                  | 说明                                                    |
| --------------------- | ------------------------------------------------------- |
| `npm run voice:smoke` | TTS → STT 回环冒烟测试（需真实 Key）                    |
| `npm run server:up`   | 构建并启动 Docker 服务端（Ubuntu 镜像，默认 3000 端口） |
| `npm run server:down` | 停止 Docker 服务端                                      |
| `npm run server:logs` | 跟踪 Docker 服务端日志                                  |

## Docker 部署（Ubuntu 服务器）

服务端（agent-server）已容器化，适合部署到 Ubuntu 服务器；桌面端
（desktop-ui / desktop-agent）是 Windows 本地客户端，不在服务端镜像内。

```bash
# 服务器上：先准备 .env（复制 .env.example 并填入 DASHSCOPE_API_KEY 等）
npm run server:up
```

- 镜像：`Dockerfile`（Ubuntu 24.04 + Node 24，只装生产依赖），
  健康检查 `/health`；内置 dsh（coding.run 后端，deepseek-v4-flash），
  密钥通过 `DEEPSEEK_API_KEY` 注入
- 端口：默认 `3000`，可用环境变量 `APP_PORT` 覆盖（如 `APP_PORT=8080 npm run server:up`）
- 数据库：`docker compose` 里的 postgres（pgvector）服务自动先启动并等待健康
- 环境变量：`env_file` 读取仓库根 `.env`；容器内 `DATABASE_URL` 自动指向
  compose 网络中的 postgres（无需手动改）
- 桌面客户端直连：把 `.env` 的 `AGENT_URL` / `AGENT_WS_URL` 指向服务器地址即可
  （桌面工具仍在本机执行，通过 WS 注册到远端 server）
- coding.run 在服务端执行（服务器上跑 dsh），不依赖桌面客户端；语音/文本/
  任务/提醒全部在服务端，树莓派、车机等客户端只做麦克风采集、音频播放与
  轻量 UI，走同一套 `/ws/voice` 与 `/api/events` 协议

注意：服务器对外暴露前请设置防火墙并只开放必要端口；语音链路为 WebSocket，
如有反代需开启 WebSocket 支持。

## 自我开发与更新

AI 助理可以开发/更新自己（服务端能力）：

- 本地运行用 `npm run serve`（守护进程，服务退出自动拉起；`system.restart`
  依赖它）；容器部署靠 Docker 的 `restart: unless-stopped`
- 工具：`self.info`（项目根/版本/环境）、`self.check`（typecheck + 测试门禁）、
  `system.restart`（L3 二次确认后优雅重启）
- 流程（已写入人格规则）：`self.info` → 读代码出方案 → `coding.run` 实现 →
  `self.check` 全绿 → 更新 CHANGELOG → `system.restart` 生效
- 有界自主（Prime Agent 思路）：每次自我开发先定义 `goal`，最多 3 轮
  "改动-验证"迭代；`self.check` 质量门（typecheck + 测试）失败即停止并回滚；
  失败/反馈写入 `[feedback]` 记忆供后续会话复习
- 安全基线：仓库已纳入 git（首次提交为回滚点）；不自动发起自我开发、
  不改密钥、不绕权限系统、破坏性操作需确认

## 常用命令

| 命令                              | 说明                 |
| --------------------------------- | -------------------- |
| `npm run dev`                     | 开发模式（watch）    |
| `npm run typecheck`               | TypeScript 类型检查  |
| `npm run lint`                    | ESLint               |
| `npm run test`                    | Vitest 单元/集成测试 |
| `npm run format`                  | Prettier 格式化      |
| `npm run voice:smoke`             | 语音回环冒烟测试     |
| `npm run infra:up` / `infra:down` | 启动/停止 PostgreSQL |

## API（Phase 1）

```text
GET  /health
POST /api/sessions
GET  /api/sessions/:id
POST /api/sessions/:id/chat   # SSE 流式文本回复
```

`/api/sessions/:id/chat` 以 `text/event-stream` 返回统一协议信封：

```json
{"type":"chat.token","timestamp":"...","sessionId":"...","requestId":"...","payload":{"delta":"你"}}
{"type":"chat.done","timestamp":"...","sessionId":"...","requestId":"...","payload":{"usage":{}}}
```

## 变更记录

见 [CHANGELOG.md](./CHANGELOG.md)。
