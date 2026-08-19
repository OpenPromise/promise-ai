# 架构文档

> 来源：[Grok_ElevenLabs_私人AI助理开发计划.md](../Grok_ElevenLabs_私人AI助理开发计划.md)

## 1. 目标

构建一个长期可扩展的个人 AI Assistant：所有终端（PC、手机、车机、家庭、电话）共享
同一个 Agent Core、同一套 Persona、Memory 与工具体系。

核心原则：**Grok 负责"想"，ElevenLabs 负责"说"，Agent Core 负责"做"，Memory
负责"记"，各终端负责"行动"。** Grok、ElevenLabs、Home Assistant 都通过抽象层接入。

## 2. 系统架构

```text
                         ┌──────────────────────┐
                         │       Grok API       │
                         └──────────┬───────────┘
                                    │
                          Agent / Tool Calling
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                 Memory          Tool Router       Task
                    │               │
                    │       ┌───────┼────────┐
                    │       │       │        │
                    │      PC      Home     Web    Scheduler
                    │     Tools     Tools   Tools
              ┌─────▼──────────────────────────────┐
              │             Agent Core              │
              │ Session / Context / Agent Loop     │
              │ Permission / Events / State        │
              └────────────────┬────────────────────┘
                               │
                       Voice Gateway
                               │
                       ElevenLabs
                               │
             ┌─────────────────┼──────────────────┐
             │                 │                  │
          Desktop            Mobile             Car
             └─────────────────┼──────────────────┘
                               │
                        Home Assistant
```

## 3. 模块划分

| 模块                     | 职责                                     | 状态                |
| ------------------------ | ---------------------------------------- | ------------------- |
| `packages/core`          | Agent Context、Persona 加载器            | Phase 2             |
| `packages/protocol`      | 统一消息信封、事件名                     | 骨架（Phase 1）     |
| `packages/types`         | 共享领域类型                             | Phase 1             |
| `packages/config`        | 环境变量统一管理                         | Phase 0             |
| `packages/grok`          | LLMProvider + GrokProvider               | Phase 1             |
| `packages/openrouter`    | OpenRouterProvider（LLM 聚合网关）       | Phase 1.1           |
| `packages/elevenlabs`    | STT/TTS 抽象与实现（实时 STT、流式 TTS） | Phase 3             |
| `packages/qwen-realtime` | Qwen-Audio-Realtime WebSocket 客户端     | Phase 4             |
| `packages/memory`        | SessionStore / Memory 抽象               | 内存实现（Phase 1） |
| `packages/tools`         | Tool 接口、注册表、内置工具              | Phase 5             |
| `services/agent-server`  | Session、Agent Loop、HTTP/SSE、语音 WS   | Phase 5             |
| `apps/*`                 | 桌面/Web/移动端                          | 未开始（计划后置）  |
| `infrastructure`         | PostgreSQL（pgvector）、Docker Compose   | Phase 0             |

## 4. 关键设计决策

### 4.1 供应商 Adapter

所有第三方服务必须通过接口接入：

- `LLMProvider`（`packages/grok`）— 实现：`GrokProvider`（直连 xAI）、
  `OpenRouterProvider`（OpenRouter 聚合网关），通过 `LLM_PROVIDER` 环境变量切换
- `STTProvider` / `TTSProvider`（`packages/elevenlabs`）
- `ChannelAdapter`（后续）— 电话/SIP 只是另一个 Channel

禁止 `import elevenlabs directly everywhere`，禁止 Agent Core 直接依赖具体 SDK。

### 4.2 Tool 与权限

Agent 通过 Tool 访问外部能力（Phase 5 完整实现），权限分四级：

| 等级 | 含义       | 示例              | 策略         |
| ---- | ---------- | ----------------- | ------------ |
| L0   | 只读       | `weather.get`     | 无需确认     |
| L1   | 低风险修改 | `reminder.create` | 默认执行     |
| L2   | 敏感操作   | `delete_file`     | 需用户确认   |
| L3   | 高风险     | 支付/解锁门       | 明确二次确认 |

### 4.3 Memory

三层记忆：短期（Session）、情景（重要事件）、语义（长期事实）。
PostgreSQL + pgvector 用于语义检索；只保存有长期价值的信息，
支持 `remember / forget / list / edit`，用户要求"忘记"时必须真实删除。

### 4.4 统一协议

所有实时消息使用统一信封：

```json
{ "type": "", "timestamp": "", "sessionId": "", "deviceId": "", "requestId": "", "payload": {} }
```

### 4.5 安全模型

- API Key 只存服务端环境变量，禁止进 Git
- 外部内容一律视为 untrusted data，不得成为系统指令
- Session / WebSocket 鉴权、Rate Limit、Audit Log（后续阶段细化）

### 4.6 Persona

- `FilePersonaProvider` 读取 `persona/*.md`（身份/人格/说话风格/行为准则），
  合成统一的 System Prompt；文件修改即时生效
- 声音档案（`VoiceProfile`）来自 `ELEVENLABS_*` 配置，供 Phase 3 语音层使用
- 会话创建时可传入 `systemPrompt` 覆盖默认人格

### 4.7 语音链路

- 语音会话使用 WebSocket：`WS /ws/voice/:sessionId`
- 客户端上行 **二进制 PCM 音频**（16kHz 单声道 16-bit），服务端下行统一消息信封
- **语音后端按配置切换**：配置 `DASHSCOPE_API_KEY` 时使用 Qwen ASR → LLM → Qwen TTS
  级联（见 4.14）；未配置时回退为 ElevenLabs STT → LLM → TTS 级联
- 链路：ElevenLabs STT（`scribe_v2_realtime`，VAD 提交）→ LLM（Grok / OpenRouter）
  → ElevenLabs TTS（流式 `eleven_v3`，中文 `language_code=zh`）
- 本地 `SilenceTurnDetector`（RMS）作为 VAD 备用方案，`turnEnded` 用于换轮
- 实时 STT 事件中 `text` 位于消息顶层（非 `data` 内），解析时需兼容两种格式

### 4.8 实时语音（Phase 4）

- **句子级流式 TTS**：回复按 `。！？…` / 换行切句，每句独立合成并立即下发，
  首音频延迟取决于第一句生成，而非整段回复
- **打断（Barge-in）**：TTS 播放期间检测到用户语音（partial transcript）或收到
  `{"type":"interrupt"}` 控制消息，即中止当前 LLM 任务与 TTS 合成（AbortSignal），
  推送 `tts.interrupted`；已合成的句子写回会话历史，保证上下文连贯
- **会话隔离**：每个 WS 连接创建独立的 STT/TTS 客户端，杜绝并发会话串音与
  handler 泄漏；连接关闭时中止任务并释放 STT
- **回声注意**：扬声器外放 + 麦克风拾音时需终端做回声消除或播放期抑制，
  否则 AI 自己的声音可能触发自我打断

### 4.9 Agent Core（Phase 5）

- **Agent Loop**（`ConversationService`）：LLM 流式输出 → 检测 `tool_calls` →
  执行工具 → 结果回传 → 再次调用 LLM，最多 5 轮，直到模型不再请求工具
- **Tool 协议**：`Tool { name, description, inputSchema, permissionLevel, execute }`，
  统一注册到 `ToolRegistry`；assistant 的 tool_calls 消息原样回传，工具结果
  按 `toolCallId` 关联为 `tool` 角色消息
- **执行保障**：15s 超时（`AbortController.reason` 区分超时与取消）、错误捕获后
  作为 ToolResult 回传让 LLM 自我修正、L0/L1 自动执行、L2+ 拒绝等待 Phase 6
- **工具边界**：`filesystem.search` 限定允许根目录；网络工具可被 signal 取消
- **架构约束**：新增抽象必须回答「解决什么问题、能否更简单」，禁止复制
  参考项目（OpenClaw / Mastra / LiveKit / ElevenLabs SDK）的抽象，见 AGENTS.md

### 4.10 权限系统（Phase 6）

- **四级权限**：L0 只读（weather.get / filesystem.search）无需确认；
  L1 日常文件操作与低风险修改自动执行（打开磁盘/文件、移动/复制/删除、
  压缩解压、app.launch、reminder.create / calendar.create）；
  L2 敏感操作（notification.send）需用户确认；L3 系统级/破坏性操作
  （terminal.run、system.power 关机/重启/睡眠）必须二次确认
- **审批模型**：`ApprovalRegistry` 维护会话级 pending 请求，
  Agent Loop 遇到 L2/L3 工具时挂起等待，SSE（`POST /permission`）或
  语音 WS（`permission.response`）提交决定；60s 超时自动拒绝
- **拒绝回传**：未批准的工具调用返回 `ToolResult { ok:false, error }`，
  AI 据此向用户说明或改用其他方案
- **默认拒绝原则**：无审批配置时敏感工具一律不执行，宁可拒绝不可误执行

### 4.11 Memory（Phase 7）

- **三层记忆**：Short-term（会话消息）、Episodic（重要历史事件）、
  Semantic（长期稳定事实）；Agent 通过 `memory.*` 工具自主维护
- **存储**：`MemoryStore` 接口，`PostgresMemoryStore`（pgvector 余弦距离）
  与 `InMemoryMemoryStore`（本地确定性 embedding）双实现；
  `DATABASE_URL` 不可用自动降级
- **检索注入**：每轮 LLM 调用前检索与用户消息最相关的记忆（≤3 条），
  作为 system prompt 片段注入；冲突时以用户当前说法为准
- **写入规则**：只保存长期价值信息；密码/API Key/Token/闲聊不入库；
  `memory.forget` 永久删除，用户要求"忘记"必须真实删除

### 4.12 Task / Scheduler（Phase 8）

- **模型**：`Task { name, schedule(cron), action, sessionId, enabled }` +
  `TaskRun { status, output, error }`，存储内存或 Postgres（`tasks`/`task_runs`）
- **调度**：Node.js 定时器每 30 秒 tick，`isTaskDue` 基于
  createdAt/lastRunAt 计算下一次 cron occurrence，防止跨 tick 重复触发；
  第一阶段不用队列系统
- **无人值守执行**：任务指令通过完整 Agent Loop 执行（headless），
  L2/L3 工具直接拒绝（不能无人确认地执行敏感操作），结果写入 `task_runs`
- **入口**：`task.*` 工具让 AI 自己维护任务；未来桌面端可轮询运行记录

### 4.13 Windows Desktop Agent（Phase 9）

- **Agent Server 仍是唯一核心**；桌面端只提供"行动"能力
- **远端工具桥**：桌面端连 `/ws/desktop` 声明本地工具（terminal /
  app.launch / filesystem / screen / window），桥接器动态注册进
  ToolRegistry，Agent Loop 经 WS 执行并等待结果；断线自动卸载
- **Siri 式 UI**（Electron）：透明无边框窗口，发光球体 + 玻璃拟态 +
  粒子 + 音频响应可视化；全局热键 / 托盘常驻；语音链路复用
  `/ws/voice`（16k PCM 上行、逐句 mp3 下行）
- **安全**：桌面工具沿用四级权限（terminal.run / system.power L3 二次确认，
  文件操作与 app.launch L1 自动执行），禁止默认无限制执行
- **唤醒词**：待接入（中文自定义唤醒词需训练模型）

### 4.14 Qwen 实时语音（Phase 4，双模式）

- **模式开关**：`QWEN_VOICE_MODE`（`s2s` 默认 / `cascade`）切换两条语音链路

#### s2s（端到端，默认）

- **模型**：`qwen-audio-3.0-realtime-plus`（百炼），音频进 → 音频出，
  服务端 VAD（`smart_turn`）自动断句；延迟最低，推理由 Qwen 模型完成
- **接入**：`packages/qwen-realtime`（OpenAI-realtime 风格 WS 协议）——
  桌面 16kHz PCM 上行，服务端回传 24kHz PCM + 流式转写；工具调用经
  `runToolCallWithApproval`（L0/L1 自动执行、L2/L3 走桌面审批）后
  `function_call_output` 回传触发第二轮推理

#### cascade（Qwen ASR → Grok → ElevenLabs TTS）

- **链路**：Qwen ASR（`qwen3-asr-flash-realtime`）→
  `ConversationService.runChat`（LLM 为 Grok，语音经 OpenRouter
  `OPENROUTER_VOICE_MODEL`（默认 `x-ai/grok-4.5`）压首字延迟，文字聊天保持
  `OPENROUTER_MODEL`（默认 `x-ai/grok-4.6`））→ ElevenLabs TTS
  （`eleven_v3`，逐句流式合成）
- **ASR 会话**：单条 WS 连接长驻，`server_vad` 低延迟预设
  （`threshold: 0`、静音 400ms）自动分句；桌面 16kHz PCM 上行，
  `input_audio_transcription.text`（text+stash）增量 → `transcript.partial`，
  `completed` → `transcript.final` 并触发 Agent Loop
- **打断**：播放期间检测到新 partial transcript 或收到 `interrupt`，中止任务并
  推送 `tts.interrupted`；已合成/部分回复写回会话历史
- **环境变量**：`DASHSCOPE_API_KEY`、`QWEN_REALTIME_MODEL`
  （默认 `qwen-audio-3.0-realtime-plus`）、`QWEN_REALTIME_VOICE`
  （默认 `longanqian`）、`QWEN_REALTIME_BASE_URL`（默认
  `wss://dashscope.aliyuncs.com/api-ws/v1/realtime`）；cascade 模式另用
  `QWEN_ASR_MODEL`、`ELEVENLABS_API_KEY`、`ELEVENLABS_VOICE_ID`、`ELEVENLABS_MODEL`

## 5. 当前状态与路线图

- ✅ Phase 0：项目骨架
- ✅ Phase 1：Grok 文本 Agent MVP
- ✅ Phase 2：Persona 人格系统
- ✅ Phase 3：ElevenLabs 语音层
- ✅ Phase 4：实时语音 Agent
- ✅ Phase 5：Agent Core（工具系统）
- ✅ Phase 6：权限系统
- ✅ Phase 7：Memory System
- ✅ Phase 8：Task / Scheduler
- 🚧 Phase 9：Windows Desktop Agent（第一步：UI + 工具桥）
- ⬜ Phase 10：Home Assistant
- ⬜ Phase 11：移动端 / 车机
- ⬜ Phase 12：电话 / SIP
- ⬜ Phase 13：多设备统一身份
