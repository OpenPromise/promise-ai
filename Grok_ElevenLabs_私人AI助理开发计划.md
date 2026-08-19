# Grok + ElevenLabs 私人 AI 助理开发计划

## 1. 项目目标

构建一个长期可扩展的个人 AI Assistant：

- Grok API：核心大脑、推理、对话、工具调用、任务规划
- ElevenLabs：实时语音输入/输出、自然语音、统一 Voice Persona
- Agent Core：项目核心，负责会话、Agent Loop、Tool Router、权限、状态
- Memory：长期记忆与短期上下文
- Desktop：Windows 桌面助手
- Home Assistant：家庭设备控制
- Mobile/Car：移动端与车机语音入口
- Phone/SIP：未来电话入口
- 所有终端共享同一个 Agent Core、Persona、Memory 和工具体系

### 核心原则

> Grok 负责“想”，ElevenLabs 负责“说”，Agent Core 负责“做”，Memory 负责“记”，各终端负责“行动”。

不要把系统设计成一个依赖单一平台的机器人。Grok、ElevenLabs、Home Assistant 都必须通过抽象层接入，以便未来替换。

---

# 2. 最终架构

```text
                         ┌──────────────────────┐
                         │       Grok API       │
                         │       AI Brain       │
                         └──────────┬───────────┘
                                    │
                          Agent / Tool Calling
                                    │
                    ┌───────────────┼───────────────┐
                    │               │               │
                 Memory          Tool Router       Task
                    │               │               │
                    │       ┌───────┼────────┐      │
                    │       │       │        │      │
                    │      PC      Home     Web    Scheduler
                    │     Tools     Tools   Tools
                    │
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
             │                 │                  │
             └─────────────────┼──────────────────┘
                               │
                        Home Assistant
                               │
                         Smart Devices

未来：
Phone → SIP/DID → Voice Gateway → Agent Core
```

---

# 3. 推荐技术栈

## 后端

- TypeScript
- Node.js
- Fastify 或 Hono
- WebSocket
- PostgreSQL
- pgvector
- Redis（第二阶段再引入）
- Docker / Docker Compose

## 前端

第一阶段：

- React
- Vite

桌面端：

- Electron 或 Tauri

优先不要过早决定 Electron/Tauri；先完成 Web/服务端协议，再封装桌面端。

## AI

- Grok API
- Grok Tool Calling
- ElevenLabs Speech/Voice API
- ElevenLabs Realtime Speech-to-Text
- ElevenLabs Streaming TTS

## 家庭自动化

- Home Assistant
- MQTT（需要时）
- ESPHome（需要时）

## 协议

- REST：管理接口
- WebSocket：实时语音/事件
- MCP：未来工具生态
- JSON Schema：Tool 参数定义

---

# 4. 开发阶段

## Phase 0：项目骨架

### 目标

建立一个干净、可扩展的 Monorepo。

### 建议目录

```text
grok-personal-assistant/
│
├── apps/
│   ├── desktop/
│   ├── web/
│   └── mobile/
│
├── services/
│   └── agent-server/
│
├── packages/
│   ├── core/
│   ├── protocol/
│   ├── types/
│   ├── grok/
│   ├── elevenlabs/
│   ├── memory/
│   ├── tools/
│   └── config/
│
├── persona/
│   ├── identity.md
│   ├── personality.md
│   ├── speaking-style.md
│   └── behavior-rules.md
│
├── infrastructure/
│   ├── docker-compose.yml
│   └── postgres/
│
├── docs/
│
├── .env.example
├── package.json
└── README.md
```

### 验收标准

- 项目可以启动
- TypeScript 类型检查通过
- Lint/Format 配置完成
- Docker Compose 可以启动 PostgreSQL
- 环境变量统一管理
- README 有开发启动说明

---

# 5. Phase 1：Grok 文本 Agent MVP

## 目标

先不做语音。

实现：

```text
User
 ↓
Agent Server
 ↓
Grok
 ↓
Response
```

### 功能

- 创建 Session
- 保存消息
- Grok API 调用
- Streaming Response
- System Prompt
- 基础错误处理
- Token/请求日志

### 抽象接口

```ts
interface LLMProvider {
  chat(input: ChatInput): AsyncIterable<ChatChunk>;
  generate(input: GenerateInput): Promise<GenerateResult>;
}
```

实现：

```text
GrokProvider
```

不要让 Agent Core 直接依赖具体 Grok SDK。

### 验收

能够连续对话，并且未来可以通过实现另一个 Provider 替换 Grok。

---

# 6. Phase 2：Persona 人格系统

## 目标

建立稳定、长期一致的 AI 人格。

创建：

```text
persona/
├── identity.md
├── personality.md
├── speaking-style.md
└── behavior-rules.md
```

## Persona 方向

角色：

- 成熟女性私人 AI 助理
- 自信
- 从容
- 聪明
- 轻微调侃
- 亲近但不过度讨好
- 不使用客服腔
- 不机械重复
- 不刻意卖萌
- 说话简洁自然

声音人格目标：

- 成熟
- 中低音
- 松弛
- 自然
- 稍慢
- 适度停顿
- 有情绪变化

“性感”主要通过声音质感、语速、停顿和语言人格实现，而不是通过露骨内容。

### Persona Loader

实现：

```ts
interface PersonaProvider {
  getSystemPrompt(): Promise<string>;
  getVoiceProfile(): Promise<VoiceProfile>;
}
```

---

# 7. Phase 3：ElevenLabs 语音层

## 目标

实现：

```text
Microphone
 ↓
Speech-to-Text
 ↓
Grok
 ↓
Text-to-Speech
 ↓
Speaker
```

### 语音模块

```text
VoiceGateway
├── STTProvider
├── TTSProvider
├── VAD
├── TurnDetector
└── AudioStream
```

接口：

```ts
interface STTProvider {
  start(): Promise<void>;
  sendAudio(chunk: Buffer): Promise<void>;
  onTranscript(callback: TranscriptHandler): void;
  stop(): Promise<void>;
}

interface TTSProvider {
  synthesize(text: string): AsyncIterable<AudioChunk>;
}
```

实现：

```text
ElevenLabsSTT
ElevenLabsTTS
```

### 必须支持

- Streaming STT
- Streaming TTS
- Partial Transcript
- Final Transcript
- Audio chunk
- Barge-in / interruption
- Cancellation
- Turn detection

### 验收

用户可以连续自然说话，不需要每句话手动点击按钮。

---

# 8. Phase 4：实时语音 Agent

## 目标

从“语音聊天”升级成真正的实时语音 Agent。

目标链路：

```text
Mic
 ↓
VAD
 ↓
STT
 ↓
Conversation Manager
 ↓
Grok
 ↓
Streaming TTS
 ↓
Speaker
```

### 重点优化

1. 首字延迟
2. 首音频延迟
3. 用户打断
4. AI 停止说话
5. 网络异常恢复
6. 音频缓冲
7. 并发 Session
8. Session 生命周期

### 目标体验

用户：

> “你在吗？”

AI 不要等完整长句结束后才开始。

用户打断：

> “等等，我不是这个意思……”

AI 必须立即停止播放。

---

# 9. Phase 5：Agent Core

## 目标

让 AI 从“聊天机器人”变成“可以做事的 Agent”。

架构：

```text
User Input
 ↓
Conversation Manager
 ↓
Grok
 ↓
Tool Decision
 ↓
Tool Router
 ↓
Tool Execution
 ↓
Tool Result
 ↓
Grok
 ↓
Response
```

实现：

```ts
interface Tool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  execute(input: unknown, context: ToolContext): Promise<ToolResult>;
}
```

### 第一批工具

```text
weather.get
time.get
reminder.create
reminder.list
calendar.create
calendar.list
web.search
filesystem.search
```

### 要求

Tool 必须：

- 独立
- 类型安全
- 有 JSON Schema
- 有权限等级
- 有日志
- 有超时
- 有错误恢复
- 不允许任意工具访问

---

# 10. Phase 6：权限系统

这是私人助理必须有的核心能力。

工具分级：

### Level 0：只读

例如：

```text
weather.get
calendar.list
filesystem.search
```

无需确认。

### Level 1：低风险修改

例如：

```text
reminder.create
calendar.create
```

可以默认执行。

### Level 2：敏感操作

例如：

```text
send_message
delete_file
modify_home_security
```

需要用户确认。

### Level 3：高风险

例如：

```text
支付
转账
删除大量文件
解锁门
```

必须明确二次确认。

---

# 11. Phase 7：Memory System

## 目标

让 AI 真正认识用户，而不是每次重新认识。

## 三层记忆

### Short-term Memory

当前 Session。

### Episodic Memory

重要历史事件。

例如：

```text
2026-08-18：
用户开始开发私人 AI Assistant。
```

### Semantic Memory

长期稳定事实：

```text
用户喜欢什么
用户正在做什么项目
用户的长期目标
用户的工具偏好
```

## 数据库

PostgreSQL：

```text
users
sessions
messages
memories
memory_embeddings
tasks
tool_calls
devices
```

pgvector 用于语义搜索。

---

# 12. Memory 写入规则

不要保存所有聊天。

只保存：

- 长期偏好
- 长期项目
- 用户明确要求记住的信息
- 有长期价值的重要事件
- 未来可能影响决策的信息

不要保存：

- 一次性的闲聊
- 密码
- API Key
- Token
- 高敏感信息
- 没有长期价值的内容

必须支持：

```text
remember
forget
list memories
edit memory
```

用户应该可以要求：

> “忘记刚才那件事。”

系统必须真的删除/失效对应记忆。

---

# 13. Phase 8：Task / Scheduler

让 Agent 可以主动工作。

例如：

```text
每天 9:00
检查天气
 ↓
如果下雨
 ↓
提醒用户
```

架构：

```text
Scheduler
 ↓
Task
 ↓
Agent
 ↓
Condition
 ↓
Action
```

实现：

```text
tasks
task_runs
scheduled_jobs
```

第一阶段可以使用 Node.js scheduler。

规模增大后再考虑队列系统。

---

# 14. Phase 9：Windows Desktop Agent

## 目标

让 AI 可以操作电脑。

功能：

```text
Global Hotkey
Microphone
Screen Capture
Window Control
Filesystem
Terminal
Browser
Application Launch
```

### 示例

用户：

> “把桌面上的 PDF 按项目分类。”

Agent：

```text
filesystem.search
 ↓
classify
 ↓
filesystem.move
 ↓
result
```

### 安全要求

禁止默认无限制执行：

```text
rm -rf
格式化
删除大量文件
管理员权限操作
任意下载并执行程序
```

危险操作必须确认。

---

# 15. Phase 10：Home Assistant

## 目标

接入家庭设备。

架构：

```text
Grok
 ↓
Home Tool
 ↓
Home Assistant
 ↓
MQTT / ESPHome
 ↓
Device
```

工具：

```text
home.get_temperature
home.get_state
home.set_light
home.set_ac
home.set_scene
home.get_devices
```

例如：

> “客厅有点热。”

Agent：

```text
get_temperature()
 ↓
28.5℃
 ↓
set_ac_temperature(25)
```

---

# 16. Phase 11：移动端 / 车机

第一版不要直接做 Android Automotive。

先做：

```text
Android Client
 ↓
WebSocket
 ↓
Agent Server
```

手机通过 Bluetooth 输出到汽车。

客户端职责：

- 麦克风
- 扬声器
- Session
- WebSocket
- 网络重连
- Push
- Wake/Trigger

Agent Server 仍然是唯一核心。

---

# 17. Phase 12：电话 / SIP

最后再做。

目标：

```text
PSTN
 ↓
DID
 ↓
SIP Provider
 ↓
Voice Gateway
 ↓
Agent Core
 ↓
Grok
 ↓
ElevenLabs
```

注意：

不要让电话模块直接依赖 Agent Core 内部实现。

定义：

```ts
interface ChannelAdapter {
  connect(session: ChannelSession): Promise<void>;
  receive(event: ChannelEvent): Promise<void>;
  send(output: ChannelOutput): Promise<void>;
  disconnect(): Promise<void>;
}
```

实现：

```text
WebChannel
DesktopChannel
MobileChannel
SIPChannel
```

这样电话只是另一个 Channel。

---

# 18. Phase 13：多设备统一身份

所有设备共享：

```text
user_id
device_id
session_id
```

例如：

```text
PC
user_id = user_001
device_id = desktop_001

Car
user_id = user_001
device_id = car_001

Home
user_id = user_001
device_id = home_001
```

Agent 可以根据设备上下文改变行为。

例如：

```json
{
  "device": "car",
  "location": "car",
  "audio_only": true,
  "screen_available": false
}
```

在车里不要返回长文本。

在 PC 上可以显示详细结果。

---

# 19. Agent Context

每次请求形成：

```text
AgentContext
├── user
├── device
├── location
├── current_session
├── recent_messages
├── relevant_memories
├── available_tools
├── active_tasks
├── permissions
└── persona
```

然后交给 Grok。

---

# 20. 事件系统

统一事件：

```text
USER_SPEECH_START
USER_SPEECH_END
TRANSCRIPT_PARTIAL
TRANSCRIPT_FINAL

AGENT_THINKING
TOOL_CALL
TOOL_RESULT

TTS_START
TTS_CHUNK
TTS_END

SESSION_START
SESSION_END

TASK_CREATED
TASK_COMPLETED

DEVICE_CONNECTED
DEVICE_DISCONNECTED
```

使用事件驱动设计，避免模块之间强耦合。

---

# 21. API 设计

## REST

```text
POST /api/sessions
GET  /api/sessions/:id
GET  /api/memories
POST /api/memories
DELETE /api/memories/:id

GET /api/tools
GET /api/devices

POST /api/tasks
GET  /api/tasks
DELETE /api/tasks/:id
```

## WebSocket

```text
/ws/session/:sessionId
```

消息格式：

```json
{
  "type": "audio.chunk",
  "sessionId": "...",
  "data": "..."
}
```

统一协议必须有：

```text
type
timestamp
sessionId
deviceId
requestId
payload
```

---

# 22. 可观测性

必须记录：

```text
Request ID
Session ID
Device ID
LLM latency
STT latency
TTS latency
Tool latency
Total latency
Token usage
Audio duration
Errors
```

不要记录：

- API Key
- Authorization Header
- 完整敏感数据
- 密码

---

# 23. 成本统计

系统需要统计：

```text
Grok:
input tokens
output tokens

ElevenLabs:
STT duration
TTS characters/minutes

Infrastructure:
CPU
RAM
Storage
Bandwidth
```

提供：

```text
daily usage
monthly usage
cost estimate
```

这样未来可以知道：

> “这个私人助理一个月到底烧多少钱。”

---

# 24. 配置管理

`.env`

```env
GROK_API_KEY=
GROK_MODEL=

ELEVENLABS_API_KEY=
ELEVENLABS_VOICE_ID=
ELEVENLABS_MODEL=

DATABASE_URL=

HOME_ASSISTANT_URL=
HOME_ASSISTANT_TOKEN=

LOG_LEVEL=info
```

绝对禁止把 Key 写进 Git。

提供：

```text
.env.example
```

---

# 25. 测试策略

## Unit Test

测试：

- Persona
- Tool Router
- Memory
- Permission
- Agent Context
- Protocol

## Integration Test

测试：

```text
Grok
ElevenLabs
PostgreSQL
Home Assistant
```

## E2E

完整测试：

```text
Mic
 ↓
STT
 ↓
Grok
 ↓
Tool
 ↓
TTS
 ↓
Speaker
```

---

# 26. 性能目标

第一阶段目标：

### 语音

- 用户停止说话 → AI 开始响应：尽量 < 1 秒
- 支持用户打断
- TTS 流式播放
- 网络抖动可恢复

### Agent

- Tool 调用必须有 timeout
- 单次请求不能无限等待
- 支持 cancellation

### Server

- 单实例支持多个 Session
- WebSocket 自动重连

---

# 27. 安全模型

必须考虑：

- API Key 服务端保存
- Tool 权限
- Prompt Injection
- 恶意网页内容
- 文件系统权限
- Shell 执行权限
- Home Assistant 权限
- Session 鉴权
- WebSocket 鉴权
- Rate Limit
- Audit Log

尤其注意：

> 不允许网页内容直接成为 Agent 的系统指令。

所有外部内容都必须标记为 untrusted data。

---

# 28. 开发原则

## 原则 1

不要过早做 UI。

先把：

```text
Agent Core
Voice
Memory
Tool
Protocol
```

做好。

## 原则 2

所有第三方服务必须有 Adapter。

不要：

```ts
import elevenlabs directly everywhere
```

而应该：

```ts
VoiceProvider
 └── ElevenLabsProvider
```

## 原则 3

不要让 Grok 直接访问数据库。

必须：

```text
Grok
 ↓
Tool
 ↓
Service
 ↓
Database
```

## 原则 4

不要把 Memory 全塞 Prompt。

必须检索。

## 原则 5

不要把所有功能都做成一个 Agent。

未来可以拆：

```text
Main Assistant
 ├── Coding Agent
 ├── Home Agent
 ├── Calendar Agent
 ├── Research Agent
 └── Computer Agent
```

但第一阶段保持单 Agent。

---

# 29. MVP 最终验收

MVP 必须完成：

- [ ] Windows 上可以启动
- [ ] 麦克风输入
- [ ] ElevenLabs STT
- [ ] Grok 对话
- [ ] ElevenLabs TTS
- [ ] 流式语音
- [ ] 支持打断
- [ ] Persona
- [ ] Session
- [ ] 基础 Memory
- [ ] 至少 5 个 Tools
- [ ] Tool Calling
- [ ] 权限确认
- [ ] PostgreSQL
- [ ] WebSocket
- [ ] 日志
- [ ] `.env`
- [ ] README
- [ ] Docker Compose

---

# 30. 第二阶段验收

- [ ] Windows Desktop Agent
- [ ] 文件操作
- [ ] 浏览器操作
- [ ] Terminal
- [ ] Scheduler
- [ ] 长期 Memory
- [ ] Home Assistant
- [ ] 手机客户端
- [ ] 多设备身份
- [ ] 统一 Agent Protocol

---

# 31. 最终阶段验收

- [ ] 车机
- [ ] 电话/SIP
- [ ] DID
- [ ] 电话转真人
- [ ] 主动提醒
- [ ] 多 Agent
- [ ] 完整权限系统
- [ ] 成本统计
- [ ] 完整监控
- [ ] 可替换 LLM
- [ ] 可替换 TTS
- [ ] 可替换 STT

---

# 32. 给 LLM 的开发指令

你现在是本项目的 Principal Engineer。

不要一次生成整个项目。

必须按照以下顺序：

1. 分析当前仓库
2. 创建架构文档
3. 创建项目骨架
4. 实现 Phase 0
5. 运行类型检查
6. 运行测试
7. 修复问题
8. 再进入下一 Phase

每一个 Phase 都必须：

- 先检查现有代码
- 给出实现计划
- 修改代码
- 运行测试
- 检查类型
- 检查 lint
- 更新 README
- 更新 CHANGELOG
- 输出本阶段完成情况

禁止：

- 一次性生成大量无关代码
- 删除已有功能
- 修改 API 而不更新调用方
- 把 API Key 写入源码
- 创建没有实际用途的抽象
- 为了“未来可能用到”过度工程化
- 没有测试就宣布完成

---

# 33. 每个 Phase 的完成标准

只有同时满足以下条件才允许进入下一阶段：

```text
功能完成
+
类型检查通过
+
测试通过
+
核心路径实际运行
+
错误处理存在
+
README 更新
+
架构没有明显技术债
```

如果某一项失败：

> 停止继续开发，先修复。

---

# 34. 第一阶段任务

当前只允许实现：

```text
Phase 0
+
Phase 1
```

最终实现：

```text
Windows
 ↓
Text Input
 ↓
Agent Server
 ↓
Grok API
 ↓
Streaming Text Response
```

暂时不要实现：

- Home Assistant
- 电话
- SIP
- 车机
- MCP
- 复杂 Memory
- 多 Agent
- 自动化
- 大型 UI

等 Phase 1 稳定后再继续。

---

# 35. 项目最终愿景

最终系统应该让用户可以自然地说：

> “帮我看看今天有什么安排。”

> “把客厅空调打开。”

> “我明天上午有空吗？”

> “把这个项目跑起来。”

> “给我查一下这个东西。”

> “我到家了。”

> “提醒我晚上处理一下那个事情。”

> “有人打电话找我吗？”

并且无论用户是在：

```text
PC
手机
车里
家里
电话
```

AI 都应该是：

**同一个人、同一个人格、同一套记忆、同一套能力。**

最终目标不是做一个聊天机器人。

而是构建：

> **一个属于用户自己的、跨设备、可扩展、模型与语音供应商可替换的 Personal AI Operating System。**
