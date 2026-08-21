# 开源项目调研 + 架构优化建议报告

> 检索日期：2026-08-21（GitHub Search API，按 stars 降序）
> 代码实读：`services/agent-server/src/services/{conversation,engineer-task-runner,coding-tool}.ts`、
> `services/weixin-bridge/src/{relay,event-pusher}.ts`、`packages/openrouter/src/index.ts`，
> 以及相关支撑文件（`tool-execution.ts`、`failure-classifier.ts`、`profile-ingestor.ts`、
> `task-service.ts`、`sentences.ts`、`engineer-tools.ts`、`packages/llm/src/index.ts`、
> `packages/memory/src/memory.ts`、`docs/*.md`）。

---

## 0. 数据来源与诚实声明

1. **项目清单与 star 数**来自本次 GitHub Search API 返回结果。本环境搜索索引中的
   star 数与真实 GitHub 可能有出入，**请仅作量级参考，采纳具体做法前以真实仓库为准**。
2. **"核心亮点"一栏**：OpenClaw / Khoj / Mem0 的亮点来自仓库 README（WebFetch）与
   既有设计共识；Wechaty 与 deepseek-harness 来自其公开定位与本仓库 `docs/reference-code-map.md`
   已有结论。**我没有逐行审计这些项目的源码**，因此只做设计模式层面的对比，不声称
   到具体函数级。
3. **"优化建议"一栏全部建立在本项目真实代码之上**，每条都标注了文件与函数，可在本地核对。
4. 本报告是 `docs/reference-code-map.md`、`docs/autonomy-reference-analysis.md`、
   `docs/memory-reference-analysis.md` 的补充：那几篇是"功能级对照 + 已落地进度"，
   本篇聚焦**运行时代码里的具体缺口**（崩溃恢复、超时、事件丢失、并发、断句破损），
   并明确"哪些已吸收、哪些还没"。

---

## 1. 精选开源项目（5 个最值得借鉴）

### 1.1 OpenClaw（openclaw/openclaw）—— 个人 AI 助理的完整参考实现

- **链接**：https://github.com/openclaw/openclaw
- **定位**：Your own personal AI assistant. Any OS. Any Platform. 龙虾 🦞
- **核心亮点**（README + 本项目注释已多处引用其思路）：
  - **Gateway 控制面**：本地统一管理 sessions / tools / events / channels，是"大脑+通道+工具"的分层范式。
  - **channels 抽象**：多渠道（微信/Telegram/Discord…）统一为 account + allowlist + command-gating，主动推送与命令门控内建。
  - **process 执行引擎**：命令队列、进程树 kill、PTY、输出解码、密钥重定向（本项目 `docs/reference-code-map.md` 已确认这是它最强的部分）。
  - **心跳不打扰协议（heartbeat）**：定期唤醒，没事回 `HEARTBEAT_OK` 静默，有事才 push（本项目已落地，见 `event-pusher.ts`）。
  - **定时任务加固**：`tools-allow` 白名单、失败分类通知、`tool_budget_exceeded` 熔断（本项目已落地，见 `task-service.ts`）。
- **与本项目差异**：本项目是单仓自研、微信单渠道、抽象更薄更贴个人场景；OpenClaw 是通用框架。
  值得继续吸收的**未落地部分**：channel 抽象（目前 `weixin-bridge` 与 `agent-server` 通过 HTTP+SSE 紧耦合，
  未来接 Telegram/电话要复制一整套 relay）、命令队列与进程树 kill（`server.shell` 已做进程树 kill，但 `coding-tool` 的子进程只有裸 SIGTERM）。

### 1.2 Khoj（khoj-ai/khoj）—— AI second brain + 定时自动化

- **链接**：https://github.com/khoj-ai/khoj
- **定位**：Your AI second brain. Self-hostable. 从文档/网页检索答案，自定义 agent、定时自动化、深度研究。
- **核心亮点**：
  - **second brain**：对用户文档（PDF/Markdown/Notion/org-mode）做语义检索问答，记忆=可检索知识库。
  - **scheduled automations**：把重复研究自动化，定时推送个人 newsletter / 智能通知。
  - **custom agents**：自定义知识、人格、模型、工具，按角色复用。
- **与本项目差异**：本项目有"事件时间线 + 语义记忆 + 用户画像"三层记忆，但**没有文档级知识库**——
  微信发来的文件只入库按名发送（`files.ts`），不参与语义问答。定时任务/事件推送已有等价物
  （`task-service.ts` + `event-pusher.ts`）。Khoj 最值得借鉴的是"把保存的文件变成可检索记忆"。

### 1.3 Mem0（mem0ai/mem0）—— 通用记忆层

- **链接**：https://github.com/mem0ai/mem0
- **定位**：Universal memory layer for AI Agents（user/session/agent 三层作用域）。
- **核心亮点**：
  - **两阶段抽取**：LLM 抽取 → 向量库存储 → 按 user_id 检索注入 system prompt。
  - **多路检索融合**：语义 + BM25 关键词 + 实体匹配并行打分融合（新算法）；时间感知排序（取对的时间点实例）。
  - **实体链接**：抽取实体、嵌入、跨记忆链接用于检索增强。
- **与本项目差异**：**本项目已经是 Mem0 思路的轻量自研版且做得不错**——
  `profile-ingestor.ts` 是两阶段（抽取 ADD/UPDATE/DELETE/NONE + 写回），
  `memory.ts` 已实现 RRF（向量 + 关键词双路融合）与主备嵌入降级（`createResilientEmbedder`）。
  尚未吸收：**实体链接**与**时间衰减**（时间线已有，但语义记忆无过期/加权）。

### 1.4 Wechaty（wechaty/wechaty）—— 微信机器人 SDK 范式

- **链接**：https://github.com/wechaty/wechaty
- **定位**：Conversational RPA SDK，统一多 IM（WeChat/WhatsApp/DingTalk/Lark…）的 message/room/contact 接口。
- **核心亮点**：
  - **Puppet 抽象**：把"具体协议"与"业务逻辑"解耦，换协议不改业务。
  - **插件体系**：`wechaty-plugin-contrib` 生态。
- **与本项目差异**：本项目 `weixin-bridge` 走 ilink 自建协议直连，**单渠道、不需要多平台抽象**；
  但"收发消息"与"轮询/推送编排"目前混在 `relay.ts` 里（`getUpdates` 循环、审批态、分段发送、长任务提示
  全在一个文件）。可吸收的是**分层**：把 `ILinkClient`（纯收发）与编排逻辑进一步拆开，
  未来接新渠道只换 client 不重写编排。

### 1.5 deepseek-harness / dsh（deepseek-ai/deepseek-harness）—— 本项目编码后端的底座

- **链接**：https://github.com/deepseek-ai/deepseek-harness
- **定位**：Everything is a Plugin。本项目 `coding-tool.ts` 直接 spawn dsh（headless）作为唯一编码代理后端。
- **核心亮点**：
  - **插件化可扩展**：能力=插件，宿主无需为每个能力加工具。
  - **headless 模式 + permission mode**：`workspace-write` / `danger-full-access`
    （本项目已映射为 `acceptEdits` / `bypassPermissions`）。
- **与本项目差异**：本项目是 dsh 的**宿主**，不是竞争者。可吸收的是**让小黑能力通过 dsh 插件扩展**，
  而不是在 agent-server 里不断堆 `coding.*` 工具。

---

## 2. 本项目现状：已吸收的参考点（避免重复建议）

从代码实读确认，以下参考思路**已经落地**，报告不重复建议：

| 参考思路 | 落点（文件:函数） |
|---|---|
| OpenClaw 心跳不打扰 | `event-pusher.ts:formatEvent`（`HEARTBEAT_OK` 静默） |
| OpenClaw tools-allow 白名单 | `conversation.ts:#runChatInner`（`toolAllowlist`）、`task-service.ts` |
| 工具预算熔断 | `conversation.ts`（`toolBudget`）、`task-service.ts:TASK_TOOL_BUDGET=10` |
| 失败分类（可恢复 vs 缺陷） | `failure-classifier.ts:classifyToolFailure` |
| Mem0 两阶段画像抽取 | `profile-ingestor.ts:ProfileIngestor.ingest` |
| RRF 混合检索 + 主备嵌入降级 | `memory.ts:rrfMerge` / `createResilientEmbedder` |
| 上下文压缩（compress first） | `conversation.ts:#compactIfNeeded` |
| 工具轮次/循环熔断 | `conversation.ts`（`MAX_TOOL_TURNS=8`、`TOOL_REPEAT_LIMIT=3`） |
| 假句号/emoji 保护断句 | `relay.ts:takeEarlySegment` + `clampToCharBoundary` |
| 派单硬校验（声称派单必须真调工具） | `conversation.ts`（`DISPATCH_CLAIM_PATTERN` + `tool_choice=required`） |

---

## 3. 优化建议清单（按优先级）

> 格式：`[优先级] 标题 —— 现状（文件:函数） → 建议 → 参考来源`

### P0 —— 高价值、低风险，建议尽快做

#### P0-1 小黑任务崩溃/重启后 running 任务被静默丢弃，且派单无并发上限

- **现状**：`engineer-task-runner.ts:loadPersisted()` 只加载 `status !== 'running'` 的记录；
  `delegate()` 无并发上限，微信连环派单可瞬间 spawn 无上限个 dsh 子进程。
  进程重启时，正在跑的 dsh 进程被杀，但 `running` 记录被丢弃——用户再查
  `engineer.status` 得到"找不到任务"，且永远收不到 `engineer.task.done` 推送。
- **建议**：
  1. `loadPersisted()` 把残留 `running` 记录标记为 `failed`（`error: "进程重启，任务中断"`）并补发一次 done 事件；
  2. `EngineerTaskRunner` 增加 `maxConcurrent`（建议 2），超限任务进入 pending 队列，前一个 finish 后出队。
- **参考**：OpenClaw background-process / Mastra `background-tasks/manager.ts`（后台任务生命周期管理）。

#### P0-2 非流式 `generate()` 无超时，画像抽取/记忆整理可能永久挂起

- **现状**：`packages/openrouter/src/index.ts:#post()` 用 fetch 只传 `input.signal`，无默认超时；
  `generate()` 同样无超时包装。流式路径有 `conversation.ts:chatWithTimeoutAndRetry` 兜底（90s 空闲超时），
  但 `profile-ingestor.ts:ingest()` 和 `compactProfile()` 调 `llm.generate({messages})` **不传 signal**——
  网络半开/上游不返回时，这个 Promise 永不 settle（好在是 fire-and-forget，但会泄漏并占用资源）。
- **建议**：在 `#post()` 内对无 signal 的请求加默认超时（如 `AbortSignal.timeout(90_000)` 与传入 signal 组合），
  或在 `generate()` 外包一层超时。失败静默即可（画像抽取本就允许失败）。
- **参考**：本项目自己 `conversation.ts` 的 `LLM_IDLE_TIMEOUT_MS` 一致化。

#### P0-3 dsh 子进程超时只发 SIGTERM、无 SIGKILL 兜底，且 `killed` 语义把"超时"与"退出码非零"混为一谈

- **现状**：`coding-tool.ts:runChild()` 超时只 `child.kill('SIGTERM')`；`close` 里
  `timedOut = signal === 'SIGTERM'`。若 dsh 忽略 SIGTERM，`close` 永不触发，任务挂到超时之外，
  且 `DshRunResult.killed` 同时表示"被超时 kill"与"exit code ≠ 0"（`killed: timedOut || code !== 0`），
  上层 `coding-tool.ts:execute` 与 `engineer-task-runner.ts:#run` 都要靠 `exitCode === 124` 反推超时。
- **建议**：
  1. SIGTERM 后加 5s 宽限，再 `child.kill('SIGKILL')`；
  2. 把 `killed` 拆成 `timedOut: boolean` 与 `exitCode: number` 两个独立字段，消除 `124` 魔数反推。
- **参考**：OpenClaw `src/process`（kill-tree、进程树清理）；本项目 `server.shell` 已做进程树 kill，可复用同一套。

#### P0-4 长期目标/反馈用字符串前缀存在 content 里，注入靠 `startsWith` 硬匹配，脆弱

- **现状**：`conversation.ts:collectPersistentContext()` 用
  `entry.content.startsWith(GOAL_PREFIX)` 和 `entry.content.startsWith('[feedback]')` 过滤记忆。
  只要目标/反馈文案不是以这些字面量开头（模型写库时带空格/换行/改写措辞），就**静默漏注入**。
  语义与存储格式耦合在内容字符串里。
- **建议**：给 `packages/memory/src/memory.ts:MemoryEntry` 增加可选 `tag?: 'goal' | 'feedback' | ...` 字段
  （或复用已有 `ProfileStore`/`TimelineStore` 专用表），`goal-tools.ts` / `memory-tools.ts` 写入时显式打 tag，
  `collectPersistentContext` 改按 tag 过滤。低成本、可向后兼容（旧数据仍可走前缀回退）。
- **参考**：Mem0 的 memory 作用域/过滤（`filters={user_id}`）；本项目 `ProfileEntry.category` 已是结构化字段，可对齐。

#### P0-5 SSE 事件无 `id`/`Last-Event-ID`，重连窗口内事件永久丢失

- **现状**：`events.ts` 写事件时不带 `id:`；`event-pusher.ts:runEventPusher()` 断线重连后从"当前时刻"继续。
  重连间隙内发生的 `reminder.due` / `engineer.task.done` / `task.run` 事件**永久丢失**（用户漏收提醒/任务完成通知）。
- **建议**：
  1. `events.ts` 每个事件写 `id: <自增或时间戳>`；
  2. `event-pusher.ts` 重连时带 `Last-Event-ID` 请求头；
  3. agent-server 侧做有界环形缓冲重放（只重放最近 N 条 / T 秒内的 `reminder.due`、`engineer.task.done` 这类一次性通知）。
     兜底：重连成功后主动 `engineer.status` 查一次未读完成任务补推。
- **参考**：SSE 标准重放；Mastra `events/caching-pubsub.ts`（缓存断点）。

### P1 —— 有价值，建议排期

#### P1-1 定时任务串行执行，一个长任务阻塞整个调度器

- **现状**：`task-service.ts:checkNow()` 里 `for (const task of tasks) { await this.#runTask(task) }`，
  而 `#runTask` 会 `await` 完整 headless agent loop（可能多轮工具调用、数分钟）。
  期间其它到期任务和 tick 全被挡（`#ticking` 防重入反而放大阻塞）。
- **建议**：给 `checkNow` 加并发上限（如 2），到期任务并行跑、其余排队；`#ticking` 改为"运行中任务计数"。
- **参考**：与 P0-1 的并发控制同构；OpenClaw cron `pacing.ts`（错峰/防抖）。

#### P1-2 提前分段会切断 Markdown 代码块/表格，跨段内容破损

- **现状**：`relay.ts:takeEarlySegment()` 按 `\n\n` 段落提前发送，`handleInboundMessage` 的 `onSegment`
  对**每段单独** `markdownToPlain()`（`relay.ts:566`）。一段 fenced code block 若中间含空行，
  会被拆成两段、围栏 ``` 被分别剥离，代码块格式丢失。`markdown.ts:splitLongText()` 同样按换行硬切。
- **建议**：把"未闭合的 ``` 围栏 / 表格行"视为不可切分单元——`takeEarlySegment` 遇到 buffer 中
  围栏数为奇数时推迟切分，直到闭合。至少对 fenced code 做围栏感知；表格其次。
- **参考**：本项目 `relay.ts` 已有的"假句号保护/emoji 安全切分"思路，同一处扩展。

#### P1-3 工具结果以整段 JSON 灌进 LLM 上下文，token 浪费 + 噪音

- **现状**：`conversation.ts:#runChatInner` 里 `pruneToolResult(JSON.stringify(result))` 把
  `{ok,data,error}` 的 JSON 原样发给 LLM。LLM 只关心可读文本/错误，JSON 包装是纯开销；
  大 result 被截断后 JSON 结构残缺反而更难读。结构化 result 其实已经完整放在 `agent.tool_result` envelope 里给客户端了。
- **建议**：回传上下文时把 ToolResult 序列化成紧凑文本（`ok` → 直接 data.text；`!ok` → 一行 error），
  或至少剥离 JSON 外壳只留内容字段。收益：省 token、降截断概率。
- **参考**：OpenClaw / Mastra 的 tool result 序列化；本项目 `TOOL_RESULT_MAX_CHARS` 截断逻辑同处。

#### P1-4 缺 token 用量/成本聚合与结构化日志

- **现状**：`TokenUsage` 在 `chat.done` 有但未聚合；`console.log` 散落各处（`profile-ingestor.ts` 每步都 log），
  无级别、无字段化。用户无法问"今天花了多少 token / 哪个模型最贵"。
- **建议**：agent-server 加一个 usage 累加器（按 provider/model 日聚合，落 timeline 或单独表），
  供 `self.*` / 查询工具读取；日志统一 `[模块]` 前缀 + 结构化字段。
- **参考**：OpenClaw 的 usage/audit 思路；本项目 `timeline` 表已可承载。

#### P1-5 微信桥接并发防护只防单 session，无全局/每用户节流；审批超时体验差

- **现状**：`relay.ts:handleInboundMessage` 用 `inflightSessions`（Set）挡同一 session 重入，
  但不同好友完全并发，无全局节流。`pendingApprovals` 70s 硬超时后，用户再回"允许"会被当成普通消息进入下一轮，
  没有"已过期"提示。
- **建议**：加全局并发上限 + 每 peer 简单计数限流；审批超时后给用户明确"授权已过期，请重新发起"。
- **参考**：OpenClaw channels 的 allowlist / rate 控制。

### P2 —— 以后再说

- **P2-1 语义记忆检索 O(n) 全量扫**：`memory.ts:InMemoryMemoryStore.search()` 逐条 cosine，
  条目多了退化。已有 `postgres.ts`（pgvector）实现，建议后续把语义记忆切到 pgvector 或加条数上限/时间衰减。
- **P2-2 文档级语义检索（Khoj second brain）**：`weixin-bridge/src/files.ts` 只入库按名发，
  没有"问我文件里有什么"。后续可把文件库内容向量化，做文档问答。
- **P2-3 两套断句实现合并**：`sentences.ts:splitSentences`（TTS 用，`\n` 当句末、无假句号/emoji 保护）
  与 `relay.ts:takeEarlySegment`（微信用，排除英文 `.`、surrogate 保护）边界规则不一致。
  建议统一成一个"句子边界判定"模块，避免行为漂移。
- **P2-4 Mem0 实体链接 / 时间衰减**：`profile-ingestor.ts` 目前 ADD/UPDATE/DELETE 覆盖式（对单用户画像更可控），
  缺实体链接（"张三=老板"）与时间衰减。属长期能力，等画像数据积累后再做。

---

## 4. 建议落地顺序（小结）

1. **先做 P0-1、P0-3、P0-5**：这三条直接关系"任务不丢、进程不泄漏、通知不漏"——是可靠性红线，
   且都是小改动（各 ≤ 一个文件 + 少量测试）。
2. **再做 P0-2、P0-4**：超时兜底与结构化记忆 tag，改动小、纯增量、向后兼容。
3. **P1 按需排期**：P1-1（调度并发）与 P1-2（代码块断句）是用户可感知的体验问题，建议紧随其后。
4. **P2 视数据积累再做**：文档语义检索（P2-2）最有想象力，但依赖知识库内容规模，不急。

> 补充：`docs/reference-code-map.md` / `docs/autonomy-reference-analysis.md` 的"落地进度"已覆盖
> 工具白名单、预算熔断、失败分类、心跳静默等。本篇 P0/P1 建议与那两篇**不重复**，聚焦的是
> 运行时代码里尚未被文档点名的缺口；实施时建议先读那两篇，确认上下文后在本报告标注的
> 文件/函数上直接改动。
