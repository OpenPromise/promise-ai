# Promise_ai 第三轮代码审计报告（v3）

- **审计时间**：2026-08-21
- **审计者**：Claude Opus 5（第三轮）
- **代码版本**：`main` @ `7b80106`（v0.11.0，工作区干净）
- **形态变更**：桌面端已下线，当前形态 = **agent-server + weixin-bridge（微信 bot）**
- **约束**：本轮**只审计、不改任何代码**（仅新增本报告文件）

## 一、审计范围与方法

**通读范围**

| 模块 | 文件 |
| --- | --- |
| agent-server / services | `conversation.ts`(886) `tool-execution.ts`(193) `approval.ts`(187) `engineer-task-runner.ts`(364) `coding-tool.ts`(272) `server-shell.ts`(337) `system-status.ts`(241) `task-service.ts`(265) `hook-service.ts`(142) `reminder-service.ts`(75) `profile-ingestor.ts`(261) `profile-tools.ts`(262) `self-tools.ts`(431) `weixin-tools.ts`(260) `cloud-tools.ts` `failure-classifier.ts`(86) `restart-recovery.ts` |
| agent-server / routes | `sessions.ts`(246) `events.ts`(168) `hooks.ts`(56) `health.ts`(26) `xiaohei.ts`(31) `voice.ts` `qwen-voice.ts` `qwen-voice-s2s.ts` `app.ts`(200) `index.ts`(488) |
| weixin-bridge | `index.ts`(463) `relay.ts`(937) `ilink.ts`(740) `event-pusher.ts`(179) `files.ts`(96) `jobs.ts`(140) `state.ts`(83) `login.ts`(99) `markdown.ts` |
| packages | `config`(300) `llm`(297) `openrouter`(238) `memory`(memory/postgres/postgres-sessions/tasks/profile/reminders/timeline) `tools`(index/validate/filesystem/sensitive/web-fetch/memory-tools/goal-tools/task-tools/reminders) |

**方法**：逐条复核前两份报告（`claude-code-audit.md`、`claude-code-audit-opus5.md`）的 P0/P1/P2，以当前代码为唯一判据；同时做回归检测（前轮修复是否引入新问题）；再独立寻找新缺陷。

## 二、复核结论

### 2.1 第一份报告 `claude-code-audit.md`（DeepSeek 版，P0-1 ~ P2-21）

| 编号 | 原级别 | 原问题 | 现状态 | 证据 |
| --- | --- | --- | --- | --- |
| P0-1 | P0 | 微信通道未对 L2/L3 自动拒绝 | ⚠️ **部分修（策略分歧）** | 改成了「微信文字审批」而非自动拒绝：`relay.ts` 收 `permission.request` → 问「允许/拒绝」→ POST `/permission`。但 `AGENTS.md` 仍写「微信通道对 L2/L3 自动拒绝」。实现与规范不一致，且 L3 `server.shell` 因此可从微信触达 → 见新发现 **N-P0-2** |
| P0-2 | P0 | 多个高风险工具设为 L1 | ❌ **未修** | `coding-tool.ts:216` `coding.run` 仍 `permissionLevel: 1`，且内部 `permissionMode: 'bypassPermissions'` → dsh `--dangerously-bypass-approvals-and-sandbox`（60 分钟超时）；`engineer-tools.ts:52` `engineer.delegate` L1；`self-tools.ts:165/212/247/326` `self.apply`/`self.commit`/`self.check`/`self.write` 全 L1 |
| P0-3 | P0 | `weixin.send_image` 任意本地文件读取 + SSRF | ❌ **未修** | `weixin-tools.ts:158` 仍 L1，`path` 无根目录白名单、`url` 无内网屏蔽、无字节上限 |
| P0-4 | P0 | 会话/画像读-改-写丢失更新 | ✅ **已修** | `postgres-sessions.ts` `addMessage` = `UPDATE ... messages = messages \|\| $2::jsonb`；`updateSession` 单语句 + `COALESCE` + `AND ($5::int IS NULL OR jsonb_array_length(messages) = $5)` 乐观并发；`profile.ts` `#runExclusive(userId)` 串行队列 |
| P1-5 | P1 | `web.fetch` SSRF（L0 全通道可用） | ❌ **未修** | `web-fetch.ts:72` 仍 L0；已加 `readBodyCapped(response, 2_000_000)`（体积护栏，属 opus5 P1-20 的一部分），但**没有**私网/回环 IP 屏蔽、没有重定向后再校验 |
| P1-6 | P1 | weixin-bridge 监听 `0.0.0.0` 且端点无鉴权 | ❌ **未修** | `weixin-bridge/src/index.ts` 全部端点（`/send-text` `/send-image` `/send-voice` `/files` `/delete-file` `/logout` `/qr`）无任何鉴权；`packages/config` schema 里也没有 bridge token 配置项 |
| P1-7 | P1 | SSE 重放缓冲被每连接重复 push | ✅ **已修** | `routes/events.ts` 改为**模块级共享**有界环形缓冲（容量 20），`bootSent` 提到连接外（同 opus5 P1-6） |
| P1-8 | P1 | relay 的 90s 护栏不约束实际聊天 | ✅ **已修** | `relay.ts` `withTimeout` 已正确（`finally` 不再提前 `clearTimeout`）；`consumeSse` 90s **idle** 超时 + `reader.cancel()`；`CHAT_TOTAL_TIMEOUT_MS = 5 * 60_000` 总护栏 |
| P1-9 | P1 | `system.status` 忽略 abort、无超时 | ✅ **已修** | `system-status.ts`：`STATUS_SCRIPT_TIMEOUT_MS = 25_000`（< 工具 `timeoutMs: 30_000`）、消费 `context.signal`、`finally` 里 abort、`killTree` 进程组 SIGTERM→2s→SIGKILL、`minimalStatusEnv()` 白名单环境变量 |
| P1-10 | P1 | `self.apply` 门禁 `lastSelfCheckPassed` 为进程级全局 | ❌ **未修** | `self-tools.ts` 仍是模块级 `let lastSelfCheckPassed = false;`，跨会话/跨通道共享；`self.apply` 仍 L1 且 `setTimeout(() => process.exit(0), 10_000)` |
| P1-11 | P1 | `runToolWithTimeout` 超时只报告不终止 | ✅ **已修** | `tool-execution.ts` 用 `AbortController` + `Promise.race`，超时真正 abort 并传 `ctx.signal` 给工具（但 `server-shell.ts` 不消费该 signal → 见 **N-P1-1**） |
| P1-12 | P1 | 全局 `shellQueue` 串行所有 shell | ❌ **未修（可接受）** | `server-shell.ts` 仍是模块级单条 `shellQueue`。单用户场景下影响有限，但与 `coding.run`（60 min）叠加时会长时间堵死 `server.shell` → 见 **N-P2-7** |
| P1-13 | P1 | 多个内存集合无界增长 | ⚠️ **部分修** | `approval.ts` 已加 `MAX_APPROVED_SESSIONS = 200` / `MAX_APPROVED_FINGERPRINTS = 100`；`engineer-task-runner.ts` 已加 `MAX_TASKS = 100`（只驱逐非 running）。**残留**：`approval.ts` `#requestApproved`、`weixin-bridge/jobs.ts` `#jobs`、`hook-service` 每次 webhook 新建会话仍无界 → 见 **N-P1-6 / N-P1-10 / N-P1-7** |
| P2-14 | P2 | `collectPersistentContext` 每轮全量加载记忆 | ✅ **已修** | `MemoryStore.list(kind?, { limit? })` 已支持 limit（`memory.ts` / `postgres.ts`）；`conversation.ts` 仅在**第 0 轮**注入（`memoryInjected` 标志），不再每轮全量 |
| P2-15 | P2 | `validate.ts` 未捕获的正则构造 | ✅ **已修** | `validate.ts` `new RegExp(schema.pattern)` 包在 try/catch，非法 pattern 返回「的格式规则（pattern）无效」而非抛异常 |
| P2-16 | P2 | `collectSecrets` 跳过 <8 字符密钥 | ✅ **已修** | 短密钥也纳入脱敏集合 |
| P2-17 | P2 | `databaseUrl` 日志可能泄露密码 | ✅ **已修** | `index.ts:145-153` 用 `new URL(...).host` 只打印 `host:port`，解析失败退回占位符 `postgres` |
| P2-18 | P2 | `autoApproveAll` 全局全权限开关 | ⚠️ **未修（设计取舍）** | `config` 默认 `'false'`，启动日志打印当前值；开关本身保留（用户明确要「全权限模式」）。`/health` 已不再泄露该值（opus5 P1-18） |
| P2-19 | P2 | hook 密钥非恒定时间比较 | ✅ **已修** | `routes/hooks.ts` 用 `timingSafeEqual` + 长度预检；`HOOK_SECRET` 未配置时直接 `401 'HOOK_SECRET 未配置，hook 端点已禁用'` |
| P2-20 | P2 | 工具名下划线化冲突（待验证） | ✅ **已修** | `packages/tools/src/index.ts` `register()` 主动检测 wire name 冲突并抛错：`Tool wire name collision: X and Y both map to Z` |
| P2-21 | P2 | 其它待验证 / 轻微项 | ✅ **已处理/误报** | `state.ts` 原子 rename 判为误报（正确）；并发 `.tmp` 覆盖问题在 opus5 P2-26 单列并已修（`#writeQueue` 串行化） |

**第一份报告统计**：4 个 P0 → 1 已修、1 部分修（策略分歧）、2 未修；9 个 P1 → 4 已修、1 部分修、4 未修；8 个 P2 → 6 已修、1 部分修/取舍、1 误报归档。

### 2.2 第二份报告 `claude-code-audit-opus5.md`（P0-1 ~ P2-36）

| 编号 | 原级别 | 原问题 | 现状态 | 证据 |
| --- | --- | --- | --- | --- |
| P0-1 | P0 | `/ws/desktop` 无鉴权 + 客户端自报 `permissionLevel` 注入全局工具表 | ✅ **已修（整体下线）** | 桌面端已在 `05a11aa` 整体移除，`/ws/desktop` 路由与设备工具注册链路不再存在 |
| P1-2 | P1 | `withTimeout` 的 `finally` 立即 `clearTimeout` | ✅ **已修** | `relay.ts` 计时器在 race settle 后才清，超时可正常触发 |
| P1-3 | P1 | `PostgresTaskStore.updateTask` 读-改-写 | ✅ **已修** | `tasks.ts` 单语句 `UPDATE tasks SET name = COALESCE($2, name), ... tools = COALESCE($8::jsonb, tools), updated_at = now() WHERE id = $1 RETURNING id`。**副作用**：字段无法通过 patch 显式置回 NULL（见 **N-P2-5**） |
| P1-4 | P1 | 压缩仍有丢失窗口且每会话只能压一次 | ✅ **已修** | `conversation.ts` `COMPACTION_COOLDOWN_MS = 5 * 60 * 1000` 冷却（可重复压缩）+ `expectedMessageCount` 乐观并发（压缩期间有新消息则放弃本次替换） |
| P1-5 | P1 | `system.status` 无超时/abort/进程组 kill，且透传全部环境变量 | ✅ **已修** | 同上 2.1 P1-9；`minimalStatusEnv()` 只放 `PATH`/`HOME`/`LANG` 等白名单，现已成为本仓库的参考实现 |
| P1-6 | P1 | 重复 `system.boot` 通知（`bootSent` 每连接局部） | ✅ **已修** | `routes/events.ts` `bootSent` 提到路由注册作用域，仅首个连接收到 |
| P1-7 | P1 | `FallbackLLMProvider.chat` 的 `started` 判定过早 + 主流迭代器泄漏 | ✅ **已修** | `packages/llm/src/index.ts`：`producedText` 只在 `value.delta.length > 0` 时置真；`catch` 里 `!producedText && this.#fallback` 才切换；`finally { await iterator.return?.(); }` 无条件释放主流 |
| P1-8 | P1 | pgvector 维度迁移不是真事务 | ✅ **已修** | `postgres.ts` `#ensureDimensionMatches` 用 `this.#pool.connect()` 取单连接，`BEGIN`/`DROP COLUMN`/`ADD COLUMN vector(N)`/逐行 `UPDATE`/`COMMIT` 同连接，catch 里 `ROLLBACK` 并**重抛以阻断启动**，`finally` 释放。残留细节见 **N-P2-3** |
| P1-9 | P1 | DashScope 嵌入无超时 | ✅ **已修** | `memory.ts` `createDashScopeEmbedder({ timeoutMs = 30_000 })` → `signal: AbortSignal.timeout(timeoutMs)` |
| P1-10 | P1 | `createResilientEmbedder` 零填充降级污染向量库 | ✅ **已修** | 备用嵌入维度不符时**拒绝写入**并抛错：「云嵌入失败且备用嵌入器维度不匹配（N ≠ M），拒绝写入以避免污染向量库」；检索侧 `embedForSearch` 返回 `null` 退化为关键词检索 |
| P1-11 | P1 | 提醒只存内存，重启即丢 | ✅ **已修** | 新增 `PostgresReminderStore`（`reminders.ts`），`index.ts` 在有 `DATABASE_URL` 时装配；`markDone` 为原子 `UPDATE ... RETURNING`。残留见 **N-P2-4** |
| P1-12 | P1 | 「进程重启，任务中断」通知会丢 | ✅ **已修** | `engineer-task-runner.loadPersisted()` 返回中断任务列表，`index.ts` 在 `buildApp()`（事件路由注册）**之后**才 `emitTaskDone(task.id)`，事件进 SSE 缓冲可被 `Last-Event-ID` 补拉 |
| P1-13 | P1 | dsh 子进程只 kill 直接子进程 | ✅ **已修** | `coding-tool.ts` / `system-status.ts` 均 `detached: true` + `process.kill(-pid, sig)` 进程组 kill，SIGTERM → grace → SIGKILL |
| P1-14 | P1 | 定时任务调度器队头阻塞 | ✅ **已修** | `task-service.ts` `runWithConcurrency(due, 2)` + `#ticking` 防重入 + `TASK_TOOL_BUDGET = 10`。**但 `#ticking` 带来新问题** → 见 **N-P1-5** |
| P1-15 | P1 | 提前分段与最终补发前缀比对不一致 | ✅ **已修** | `relay.ts` 用 `preflushedChars` 精确记录已发字符数 + `clampToCharBoundary` 保护代理对 |
| P1-16 | P1 | 微信审批窗口与服务端超时错配（70s vs 60s） | ✅ **已修** | `ApprovalRequest` 新增 `expiresAt`（服务端权威），`relay.ts` `approvalWindowMs(expiresAt)` 按它计时，两端窗口对齐 |
| P1-17 | P1 | `failure-classifier` 把真实缺陷误判为「可恢复」 | ✅ **已修** | `failure-classifier.ts` 先匹配 `DEFECT_PATTERNS` 再匹配 `RECOVERABLE_PATTERNS`；可恢复集合收紧为结构化信号（`/\b(429\|500\|502\|503\|504)\b/`、`ETIMEDOUT`、`ECONNRESET`、`aborterror`、`超时`），不再靠「稍后/暂时/重试」措辞 |
| P1-18 | P1 | `/health` 泄露是否处于全权限模式 | ✅ **已修** | `routes/health.ts` 只返回 `status/uptime/version/llm{provider,model,configured}`，注释明确说明 `autoApproveAll`/`voice*`/内存后端**故意不外露**。仍无鉴权（探活用途，属设计） |
| P1-19 | P1 | `ilink.pollQrStatus` 吞掉所有错误伪装成「等待扫码」 | ✅ **已修** | `QR_POLL_MAX_FAILURES = 5`：`AbortError` 视为 `wait`，其余错误累加计数并打日志，达阈值返回 `{ status: 'error', message }`；`login.ts` 侧把 `error` 写进 `login.error` 并回传 |
| P1-20 | P1 | 响应体无大小上限 | ✅ **已修** | `ilink.ts` CDN 下载 `readBodyCapped(response, MAX_MEDIA_BYTES /* 20MB */, 'CDN 下载')`；`web-fetch.ts` `readBodyCapped(response, 2_000_000)` |
| P2-21 | P2 | 缺省时创建两个互不相通的记忆存储 | ✅ **已修** | `packages/tools/src/index.ts` 提取 `const memoryStore = ...` 单实例，`createMemoryTools` / `createGoalTools` 共用 |
| P2-22 | P2 | 语音 `requestId` 按连接生成（「仅本次允许」放大成整通电话） | ✅ **已修** | `qwen-voice.ts:114` 每个 task `requestId: randomUUID()`；`qwen-voice-s2s.ts:71/76` `turnRequestId` 每轮重新生成；`voice.ts:99` 同 |
| P2-23 | P2 | 语音中断的部分回复未 await 持久化 | ✅ **已修** | `qwen-voice.ts:72` 与 `voice.ts:60` 打断路径均改为 `await deps.store.addMessage(...)`（包 try/catch 记日志） |
| P2-24 | P2 | `splitLongText` 硬切未做 UTF-16 边界保护 | ✅ **已修** | `markdown.ts` 新增 `clampToCharBoundary()`，`if (cut <= 0) cut = clampToCharBoundary(remaining, maxLen);` |
| P2-25 | P2 | `weixin.delete_file` 模糊匹配用于永久删除过于宽松 | ✅ **已修** | bridge 侧 `files.ts` 删除路径改为**精确匹配**，`includes` 兜底仅保留给非破坏性的发送路径 |
| P2-26 | P2 | `state.ts` 并发 `save()` 共用同一 `.tmp` | ✅ **已修** | `state.ts` 新增 `#writeQueue` 串行化：「排到队尾：前一次写入（含 rename）完成后才开始，失败也不阻塞后续写入」 |
| P2-27 | P2 | `routes/xiaohei.ts` 缓存失败的 Promise | ✅ **已修** | `cachedHtml = readFile(...).catch((error) => { cachedHtml = null; throw error; })`，失败不再永久缓存 |
| P2-28 | P2 | `filesystem.search` 的 `walk()` 无深度上限/不响应 signal | ✅ **已修** | `filesystem.ts`：`const MAX_DEPTH = 8`，`walk()` 开头 `if (signal?.aborted) throw new Error('搜索已取消')`、`if (depth > MAX_DEPTH) return`，另有 `SKIPPED_DIRS`；`isWithin()` 校验 root ∈ allowedRoots |
| P2-29 | P2 | `notification.send` 是 L2 却只写内存 | ✅ **已修** | `sensitive.ts:106` 降为 `permissionLevel: 1`，description 改为「记录一条通知（仅保存在本机内存，不会主动推送）……如需真正提醒用户请用 `reminder.create`」，语义与实现对齐 |
| P2-30 | P2 | `profile.*` 工具族忽略 `ctx.userId` | ✅ **已修** | `profile-tools.ts` 六处全部 `resolveProfileUserId(context.userId)`。**但 `conversation.ts` 注入上下文时仍硬编码 `getProfile('default')`** → 见 **N-P2-2** |
| P2-31 | P2 | `#approved` 与 `#tasks` 仍无上限 | ⚠️ **部分修** | 两处主表都已加上限（`MAX_APPROVED_SESSIONS/FINGERPRINTS`、`MAX_TASKS = 100` 且不驱逐 running）；`#requestApproved` 仍无界 → **N-P1-6** |
| P2-32 | P2 | `clear()` 语义在 profile 两实现间不一致 | ✅ **已修** | `PostgresProfileStore.clear` 现先 `DELETE FROM profile_events` 再删 `user_profiles`，与内存版一致 |
| P2-33 | P2 | `rollbackEntry` / `clear` 在串行锁之外 | ✅ **已修** | 两者都包进 `#runExclusive(userId)`；抽出无锁内核 `#upsertEntryInner` / `#removeEntryInner` 避免重入死锁 |
| P2-34 | P2 | 流未以 `finish_reason === 'tool_calls'` 结束时丢弃工具调用 | ✅ **已修** | `openrouter/src/index.ts` 在 `[DONE]` 分支：`if (!toolCallsYielded && toolCallAccumulator.size > 0)` → `finalizeToolCalls` 后 `yield { delta: '', finishReason: 'tool_calls', toolCalls }` |
| P2-35 | P2 | config 若干细节 | ⚠️ **大部分已修** | (a) ✅ `DATABASE_URL` 现用 `new URL()` 预校验，非法值回退 `undefined`（走内存后端，不等 pg 连接才炸）；(b) ✅ `DASHSCOPE_BASE_URL` 已入 schema 且带默认值；(c) ⚠️ `HOOK_SECRET` 已入 schema，但 **bridge token / 监听地址 / `WEIXIN_BRIDGE_URL` / `ENGINEER_TASK_DIR` 仍散落 `process.env`**；(d) 模型 id 仍无法离线核实 |
| P2-36 | P2 | `MemoryStore.list` 缺 limit | ✅ **已修** | `list(kind?, { limit? })`，Postgres 侧下推 `LIMIT` |

**第二份报告统计**：1 个 P0 → 已修（整体下线）；19 个 P1 → **全部已修**；16 个 P2 → 13 已修、3 部分修。

### 2.3 回归检测

逐条核对前两轮修复是否引入新问题，结论：**未发现真实回归**。四处曾被怀疑、经复读后判为**误报**，记录在此避免后来者重复怀疑：

1. `services/agent-server/src/index.ts` 的 `profileStore` / `timelineStore` / `reminderStore`：初值就是 `InMemory*`，Postgres 实例只在**全部 `init()` 成功后**才整体赋值，`catch` 分支不会留下半初始化的坏对象。**不是 bug。**
2. `state.ts` 的原子 rename：写 `.tmp` 再 `rename` 本身正确（第一份报告 P2-21 判误报是对的），真实问题是并发共用 `.tmp`，已由 P2-26 的 `#writeQueue` 解决。
3. `approval.ts` 的有界驱逐：`#approved` 的 LRU 驱逐用 `keys().next().value`（插入序最旧），不会误删正在使用的会话指纹，因为驱逐只发生在**超过 200 个会话**时。
4. `engineer-task-runner.ts` 的 `MAX_TASKS` 驱逐：显式 `filter((task) => task.status !== 'running')`，运行中任务不会被驱逐掉导致「查无此任务」。

## 三、新发现

编号前缀 `N-` 表示本轮（v3）新增。

### P0（必修）

#### N-P0-1　`agent-server` 全部 API 无鉴权，且绑定 `0.0.0.0`

- **位置**：`services/agent-server/src/app.ts`（无任何全局 `preHandler`/鉴权钩子）、`services/agent-server/src/index.ts:447` `app.listen({ port: config.port, host: '0.0.0.0' })`
- **问题**：`/api/sessions`（建会话）、`/api/sessions/:id/chat`（SSE 对话，可触发任意已注册工具）、`/api/sessions/:id/permission`（**批准 L2/L3**）、`/api/events`、`/ws/voice*` 全部**没有鉴权**。只有 `/api/hooks/:name` 有 `HOOK_SECRET`。绑定 `0.0.0.0` 后，任何能到达该端口的人都能：建会话 → 发一句「用 server.shell 执行 X」→ 再自己 POST `/permission` 批准 → 拿到容器内 root shell。
- **影响**：完整远程代码执行。这是当前架构里最短的攻击链——不需要绕过审批，攻击者同时握着「发起」和「批准」两端。
- **注意**：`config.tencent.*` 的云防火墙工具说明部署在腾讯云轻量服务器上；若安全组只放通 3100/公网入口而封了 agent-server 端口，风险降为「同宿主/同网段内可利用」，但**代码层面没有任何防线**。
- **建议**：(a) 默认 `host` 改 `127.0.0.1`，仅在显式配置时监听公网；(b) 增加共享 token（`AGENT_API_TOKEN`）的全局 `preHandler`，bridge 侧带上；(c) `/permission` 至少要求与发起 chat 的同一凭据。

#### N-P0-2　微信通道可通过文字审批放行 L3，与 `AGENTS.md` 的「自动拒绝」规范冲突

- **位置**：`AGENTS.md:91`「**通道约束**：微信通道（weixin-bridge）对 L2/L3 自动拒绝——供微信会话使用的工具只能是 L0/L1」 vs 实现：`tool-execution.ts:116-160` 只在 `headless` 时拒绝 L2/L3，微信走的是**非 headless** 路径 → 发 `permission.request` → `relay.ts` 问「允许/拒绝」→ bridge POST `/api/sessions/:id/permission`
- **问题**：规范说的是「自动拒绝」，实现给的是「文字审批」。后者意味着 L3 工具（`server.shell` 容器内任意命令、`self.rollback` `git reset --hard`、`cloud.*` 防火墙改动、`system.restart`）**只要用户回一句「允许」就会执行**。微信是弱认证通道：消息可被他人在解锁的手机上发出、可被社工诱导（模型转述的命令未必是用户理解的命令）。
- **影响**：权限模型的最强边界（L3 双确认）在微信通道退化为一次文字回复。且第一份报告 P0-1 被判「已修」，实际是换了实现路径而未同步规范——**规范与实现的分歧本身就是持续风险**。
- **建议**：二选一并同步文档：(a) 恢复规范语义——微信通道对 L3 硬拒绝，L2 才允许文字审批；(b) 若确认要保留 L3 文字审批，则 `AGENTS.md` 必须改写，并对 L3 要求**二次不同措辞确认**（当前 `confirmationsNeeded` 在文字通道是否真的收两次确认，需要专门测试覆盖）。

#### N-P0-3　`/api/sessions/:id/permission` 不校验 `requestId` 属于该会话

- **位置**：`services/agent-server/src/routes/sessions.ts:207-240`
  ```ts
  const resolved = deps.approvals.respond(body.requestId, { approved: body.approved, ... });
  ```
- **问题**：路径里的 `:id`（会话）**完全没参与校验**。`ApprovalRegistry.respond(requestId, decision)` 也不检查 `pending.request.sessionId`。任何一个会话（包括攻击者新建的空会话）都能批准**其他会话**待审的 L2/L3 请求，只需知道 `requestId`。
- **放大条件**：`requestId` 是 UUID 不易猜，但 `/api/events` 的 SSE 流会广播 `permission.request` 事件（含 `requestId`）给**所有**订阅者，而 `/api/events` 同样无鉴权 → 猜测环节被消除。
- **建议**：`respond()` 增加 `sessionId` 参数并断言 `pending.request.sessionId === sessionId`，不匹配返回 404。

### P1（该修）

#### N-P1-1　`server.shell` 不消费 `ctx.signal`，且把完整 `process.env` 交给子进程

- **位置**：`services/agent-server/src/services/server-shell.ts`（对照正确实现 `system-status.ts`）
- **问题**：三点，同一个文件里：
  1. **不消费 `context.signal`**。`tool-execution.ts` 的超时/用户中断会 abort controller，但 `server.shell` 从不监听，子进程照跑到自己的 `timeoutMs`。上层已「报告超时」，容器里的命令仍在跑（`AGENTS.md` 要求的「超时要真终止」在这里失效）。
  2. **`env: process.env` 全量透传**。子进程能读到 `DASHSCOPE_API_KEY`、`OPENROUTER_API_KEY`、`DATABASE_URL`（含密码）、`HOOK_SECRET`、`TENCENT_SECRET_KEY`。`env | grep -i key` 一条命令就外泄全部凭据；`system-status.ts` 已经有 `minimalStatusEnv()` 白名单可直接复用。
  3. **`timedOut` 由退出信号反推**。SIGTERM/SIGKILL 就判为超时，于是「用户主动中断」和「命令自己被外部 kill」都被报成「执行超时」，failure-classifier 会按可恢复处理并触发无意义的自愈重试。
- **建议**：`execute()` 里 `context.signal?.addEventListener('abort', () => killTree(...))`（`finally` 里移除监听）；`env` 换成 `minimalStatusEnv()` 基础上按需追加；`timedOut` 改由自己的定时器显式置位，abort 与 timeout 分开上报。

#### N-P1-2　`self.apply`（L1）能重启进程，门禁只有一个进程级全局布尔；`self.commit`（L1）直推 `origin/main`

- **位置**：`services/agent-server/src/services/self-tools.ts`：模块级 `let lastSelfCheckPassed = false;`；`self.apply` `permissionLevel: 1` + `setTimeout(() => process.exit(0), 10_000)`；`self.commit` `permissionLevel: 1` 执行 `git add -A` → `git commit` → `git push origin main`
- **问题**：这是第一份报告 P1-10 的**未修项**，在桌面端下线后风险反而更集中（微信是唯一通道，L1 = 无确认）。
  - `lastSelfCheckPassed` 是**进程全局**：会话 A 跑过一次 `self.check` 通过，会话 B（甚至定时任务、webhook 会话）就能直接 `self.apply` 重启进程，门禁形同虚设。
  - `self.commit` 是 L1：模型可以在无人确认的情况下 `git add -A`（把任何误生成的文件、临时凭据文件一起提交）并推到 `main`。这属于「外部可见、难以撤回」的操作，按仓库自己的权限规范应当 ≥ L2。
- **建议**：`lastSelfCheckPassed` 改为 `Map<sessionId, { passedAt, headSha }>` 并校验 `git rev-parse HEAD` 未变；`self.apply`/`self.commit` 升到 L2（`self.commit` 建议 L2 + 明确列出将提交的文件清单）。

#### N-P1-3　`coding.run`（L1）以 `bypassPermissions` 启动 dsh，60 分钟无人监督

- **位置**：`services/agent-server/src/services/coding-tool.ts:216` `permissionLevel: 1 as PermissionLevel`，内部 `permissionMode: 'bypassPermissions'` → dsh `--dangerously-bypass-approvals-and-sandbox`，`timeoutMs` 上限 60 min
- **问题**：第一份报告 P0-2 的核心项，仍未修。一个 L1 工具（微信通道零确认）启动的是**完全无沙箱、无审批**的编码代理，可在服务器上任意读写删除、任意联网、任意执行。`engineer.delegate`（L1）走 `workspace-write` 稍好，但 `coding.run` 是 `danger-full-access`。
- **影响**：`server.shell` 是 L3 双确认，`coding.run` 是 L1 零确认，但后者能做的事**严格包含**前者。这条旁路让 L3 边界失去意义。
- **建议**：`coding.run` 升 L2（含「将以无沙箱模式运行」的显式提示），或把默认 `permissionMode` 降为 `workspace-write`，只在显式传参 + L3 时才允许 `bypassPermissions`。

#### N-P1-4　`weixin.send_image`（L1）任意本地文件读取 + SSRF + 无体积上限

- **位置**：`services/agent-server/src/services/weixin-tools.ts:158`（`weixin.send_image`，L1），核心在 `loadImageBytes()`：
  ```ts
  if (/^https?:\/\//i.test(source)) {
    const response = await fetchImpl(source);              // 无内网屏蔽、无重定向校验
    return { ok: true, bytes: Buffer.from(await response.arrayBuffer()) };  // 无体积上限
  }
  return { ok: true, bytes: await readFile(source) };      // 无 allowedRoots 校验
  ```
- **问题**：第一份报告 P0-3 未修。`source` 走本地分支时**直接 `readFile(任意绝对路径)`**（`/app/.env`、`/root/.ssh/id_rsa`、`/proc/self/environ`）；走 URL 分支时无 SSRF 屏蔽（`http://169.254.169.254/latest/meta-data/` 云元数据、`http://127.0.0.1:5432`），且 `arrayBuffer()` 无 `readBodyCapped`（`ilink.ts`、`web-fetch.ts` 都加了，这里漏了）。读到的字节 base64 后经 bridge 直接发到微信。
- **影响**：L1（微信通道零确认）把服务器上任意文件或内网响应发到聊天窗口，是最直接的数据外泄通道。虽然文件内容会被当成图片发送（微信可能显示失败），但字节已经离开服务器进了微信 CDN。
- **建议**：复用 `filesystem.ts` 的 `isWithin(target, allowedRoots)`；`url` 走与 `web.fetch` 共享的 SSRF 校验（见 N-P1-8）；下载套 `readBodyCapped(response, 20 * 1024 * 1024)`。

#### N-P1-5　`TaskService.#ticking` 防重入把长任务变成调度停摆

- **位置**：`services/agent-server/src/services/task-service.ts:103` `#ticking = false`、`:120` `setInterval(() => void this.checkNow(), ...)`、`:146-168`
  ```ts
  if (this.#ticking) return;          // ← 整个 tick 的锁
  this.#ticking = true;
  try { await runWithConcurrency(due, this.#maxConcurrentRuns, async (task) => { ... }); }
  finally { this.#ticking = false; }
  ```
- **问题**：opus5 P1-14 用 `runWithConcurrency(due, 2)` 解决了同 tick 内的队头阻塞，但 `#ticking` 锁的粒度是**整个 tick**：只要本 tick 里有任何任务未 settle，后续所有 tick 直接 `return`。若某定时任务调 `coding.run`（最长 60 分钟）或 `engineer.delegate`，则**整整一小时内所有其它定时任务都不会被检查**，到点的提醒/巡检全部延迟。
- **影响**：`system.status` 自主巡检、日报之类的任务静默失约，且 `if (this.#ticking) return;` 连一行日志都没有——排查时看不出「为什么任务没跑」。
- **建议**：把 `#ticking` 从「全 tick 锁」改成「per-task 在执行集合中」（`#running: Set<taskId>`），tick 只跳过仍在跑的那个任务；或至少在跳过时打 warn 日志并记录已阻塞多久。

#### N-P1-6　`ApprovalRegistry.#requestApproved` 无界，且「仅本次允许」按工具名而非参数放行

- **位置**：`services/agent-server/src/services/approval.ts:71` `readonly #requestApproved = new Map<string, Set<string>>();`，`rememberRequestApproval(requestId, toolName)` / `isRequestApproved(requestId, toolName)`
- **问题**：两点：
  1. **无界**。`#approved` 有 `MAX_APPROVED_SESSIONS/FINGERPRINTS`，`#requestApproved` 一个上限都没有。清理只靠 `clearForRequest(requestId)`；任何异常路径（进程内抛错未走到清理、语音连接异常断开、chat 流被客户端中断）都会留下永久条目。
  2. **粒度过粗**。`#approved` 用 `approvalFingerprint(toolName, args)`（含参数）；`#requestApproved` **只存工具名**。用户对「`server.shell` 执行 `df -h`」点了「仅本次允许」，同一请求的后续轮次里模型再调 `server.shell rm -rf /data` 会**自动放行**——多轮工具循环里这个窗口是真实存在的。
- **建议**：`#requestApproved` 加同样的 LRU 上限；键从 `toolName` 换成 `approvalFingerprint(toolName, args)`（要「整个请求内该工具都放行」时，应当是独立的、措辞更明确的选项）。

#### N-P1-7　`HookService.handle` 每个 webhook 新建一个会话，且无总超时

- **位置**：`services/agent-server/src/services/hook-service.ts` `handle()`
  ```ts
  const session = await this.#sessions.createSession({ systemPrompt: ..., metadata: { kind: 'hook' } });
  for await (const envelope of this.#conversation.runChat({ sessionId: session.id, userMessage: message, headless: true })) { ... }
  ```
  `services/agent-server/src/routes/hooks.ts`：`void deps.hooks.handle(hookName, payload)` 后立刻返回 200
- **问题**：
  1. **会话无界增长**。每次 webhook 一个新会话，永不删除。GitHub 仓库活跃时每天几十上百个事件 → Postgres `sessions` 表持续膨胀；`store.listSessions()`（启动时调用、`/api/sessions` 也调用）把**全部会话读进内存**，启动时间与内存随时间线性增长。`metadata: { kind: 'hook' }` 已经打了标记，却没有任何按标记清理的逻辑。
  2. **无总超时、无并发闸**。`runChat` 调用**没有传 `signal`**，只有 LLM 层的 idle 超时兜底；模型在工具循环里持续产出时，单个 webhook 可以跑很久。加上 `hooks.ts` 的 fire-and-forget，一次 CI 风暴推来 50 个事件就是 50 条并行 agent 循环，争抢同一份 LLM 配额和 `shellQueue`。
  3. 好的一面：`headless: true` 意味着 L2/L3 在这条链路上被**自动拒绝**（`tool-execution.ts:116` 的 headless 分支），所以 webhook 无法触发高危工具——这一点是对的。
- **建议**：hook 会话按 `hookName` 复用长期会话并做消息裁剪，或跑完即删（`metadata.kind === 'hook'` 已可用于筛选）；`runChat` 传 `AbortSignal.timeout(5 * 60_000)`；加并发闸（直接复用 `task-service.ts` 的 `runWithConcurrency`）。

#### N-P1-8　`web.fetch`（L0）无 SSRF 防护

- **位置**：`packages/tools/src/web-fetch.ts:72` `permissionLevel: 0`
- **问题**：第一份报告 P1-5 未修。已有 `readBodyCapped(response, 2_000_000)` 体积护栏，但仍可请求 `http://127.0.0.1:*`、`http://169.254.169.254/latest/meta-data/`（云元数据/临时凭据）、`http://10.0.0.0/8` 内网服务，且**重定向由 fetch 自动跟随**，白名单式校验也会被 302 绕过。L0 意味着任何通道零确认可用。
- **建议**：解析 hostname → DNS 解析 → 拒绝回环/私有/链路本地/保留网段；`redirect: 'manual'` 自行逐跳校验；只允许 `http`/`https`。

#### N-P1-9　`weixin-bridge` 全部端点无鉴权，`/logout` 是零成本可用性攻击

- **位置**：`services/weixin-bridge/src/index.ts:158` `Fastify({ logger: ... })`（未设 `bodyLimit`）、`:299` `app.post('/api/weixin/logout', ...)`、`:450` `app.listen({ port, host: '0.0.0.0' })`
- **问题**：第一份报告 P1-6 未修。所有端点（`/send-text` `/send-image` `/send-voice` `/send-file` `/files` `/delete-file` `/logout` `/qr`）均无鉴权，监听 `0.0.0.0`。最突出的两点：
  1. **`POST /api/weixin/logout` 无鉴权**：任何人一个空 POST 就能把机器人踢下线，恢复需要人工扫码重登。这是成本最低的可用性攻击。
  2. **`/qr` 无鉴权**：登录二维码可被第三方获取并抢先扫码。
  3. `/delete-file` 无鉴权 + 永久删除文件库内容。
  （`/send-image` 的 base64 体积受 Fastify 默认 `bodyLimit`≈1MB 兜住，不构成大内存 DoS；真正的大内存路径是本地文件发送，见 N-P1-10。但 `bodyLimit` 是**默认值兜住的**，不是显式设计。）
- **建议**：bridge 与 agent-server 之间用共享 token（收进 `packages/config` schema）；`host` 默认 `127.0.0.1`；`/logout` `/delete-file` 额外要求确认参数；显式声明 `bodyLimit`。

#### N-P1-10　`FileJobManager` 任务表无界 + 后台大文件发送无并发上限

- **位置**：`services/weixin-bridge/src/jobs.ts`：`readonly #jobs = new Map<string, FileJob>();`（无 MAX 驱逐）、`start()` 把**整个文件读进内存**后 `void this.#run(job, loaded.bytes)`，`maxBytes ?? 100 * 1024 * 1024`
- **问题**：`#jobs` 只增不减（对比 `engineer-task-runner` 已加 `MAX_TASKS = 100`），长期运行泄漏。更严重的是**没有并发闸**：N 个并行 `send-file` 请求 = N × 最多 100MB 同时驻留内存 + N 条并发 CDN 上传。10 个请求就是 1GB。
- **建议**：`#jobs` 加上限（保留最近 100 条已完成）；加 `maxConcurrent`（`engineer-task-runner.ts` 的 `#active`/`#pending` 模式可直接照搬）；大文件改流式上传而非全量读入。

#### N-P1-11　`ProfileIngestor` 节流有竞态，且日志打印用户原文

- **位置**：`services/agent-server/src/services/profile-ingestor.ts`
  ```ts
  if (!this.canRun()) return;
  ...
  const result = await this.#llm.generate({ messages: buildExtractionPrompt(...) });
  this.#lastRunAt = Date.now();   // ← 在 await 之后才更新
  ```
- **问题**：
  1. **节流失效**。`#lastRunAt` 在 LLM 调用**返回后**才写。抽取调用是 `void profileIngestor.ingest(message)` fire-and-forget，用户连发几条消息时，多个 `ingest` 都能通过 `canRun()`（此时 `#lastRunAt` 还是旧值），并发打 LLM。`minIntervalMs` 默认 10 分钟的意图完全落空，还可能并发写同一份画像（Postgres 侧有 `#runExclusive` 兜住数据一致性，但白花 token）。
  2. **日志泄露**。`console.log(\`[profile] ingest start: ${userMessage.trim().slice(0, 60)}\`)` 把用户消息原文写进容器日志。这是私人助理，用户消息可能含地址、健康状况、密码提示。日志通常无访问控制、会被采集。
- **建议**：进入时先 `this.#lastRunAt = Date.now()`（或用 `#running` 布尔互斥），失败时回滚；日志只打长度和判定结果，不打内容。

#### N-P1-12　`ReminderService.checkNow` 无逐条错误隔离

- **位置**：`services/agent-server/src/services/reminder-service.ts` `checkNow()`
  ```ts
  const reminders = await this.#reminders.list(false);
  for (const reminder of reminders) {
    if (reminder.dueAt === undefined || Date.parse(reminder.dueAt) > now) continue;
    await this.#reminders.markDone(reminder.id);   // ← 抛错则整个 for 中断
    this.#emit({ ... });
  }
  ```
- **问题**：循环体内没有 per-reminder `try/catch`，且 `start()` 是 `setInterval(() => void this.checkNow(), ...)`——**`checkNow()` 的 rejection 被 `void` 完全吞掉，连日志都没有**。一条提醒的 `markDone` 失败（Postgres 抖动、连接池耗尽）会中断整轮循环，同批**剩余到期提醒全部不发**；由于失败那条没被 `markDone`，下一轮 tick 又会先撞到它 → 后面的提醒可以被永久饿死，而且全程静默。
- **对比**：同文件的 `#emit()` 对每个监听器都包了 try/catch，`engineer-task-runner.#emit()` 也一样——模式已在仓库内确立，`checkNow` 漏了。
- **建议**：循环体整体包 try/catch，失败只记日志并 `continue`；`checkNow()` 外层也补一个 `.catch(log)`；顺带给 `markDone` 加 `AND NOT done`（见 N-P2-4）。

#### N-P1-13　持久上下文只在第 0 轮注入，长会话里「记忆」实质失效

- **位置**：`services/agent-server/src/services/conversation.ts:478-511`
  ```ts
  collectPersistentContext(this.#memory, this.#profile, this.#timeline),
  let memoryInjected = false;
  ...
  if (memoryInjected) return messages;   // 第 2 轮起直接跳过
  memoryInjected = true;
  ```
- **问题**：opus5 P2-14/P2-36 的修法是「只在 turn 0 注入 + 加 limit」，解决了每轮全表扫描，但引入语义退化：目标/反馈/画像/时间线/记忆只在**本次 `runChat` 的第一轮**进入上下文。之后：
  - 同一轮对话的工具循环里 `memory.add` / `goal.add` / `profile.upsert` 新写入的内容，**后续轮次读不到**（模型刚记下的事，下一步就想不起来），必须显式调 `memory.search` 才能拿回。
  - 微信会话是长期的（同一 peer 复用会话），历史消息里那段几天前的画像快照会一直留在上下文中，而期间的画像更新不会体现。
  - 上下文压缩（`COMPACTION_COOLDOWN_MS`）之后，摘要是否保留了这段注入内容不确定；若被压掉，会话中段就彻底失去持久上下文，且**不会重新注入**。
- **建议**：改为「距上次注入超过 N 分钟或经历过压缩时刷新一次」，或在 `memory.*` / `profile.*` / `goal.*` 工具成功后把 `memoryInjected` 置回 `false` 触发重注入（成本仅一次带 limit 的查询）。

### P2（可优化）

#### N-P2-1　`event-pusher` 向所有绑定 peer 广播每一条事件，且投递前就推进 `lastEventId`

- **位置**：`services/weixin-bridge/src/event-pusher.ts`（`runEventPusher` 的 `data:` 分支）
  ```ts
  if (currentId) lastEventId = currentId;        // ① 投递之前就推进
  ...
  const targets = peers();
  for (const peer of targets) {
    void client.sendMessage(buildReplyMessage({ to: peer, text }))   // ② 广播给所有 peer，失败只记日志
      .catch((error) => log?.(`[weixin] 推送失败 ${peer}：${...}`));
  }
  ```
- **问题**：(a) 事件（提醒到点、小黑任务完成、定时任务结果、外部 hook）不区分归属，**广播给所有已绑定的微信对端**——多人绑定时互相看到对方的任务与提醒。(b) `lastEventId` 在 `sendMessage` 之前就被推进，且 `void ... .catch(log)` 吞掉失败：微信侧限流 / `sendMessage` 120s 超时导致的投递失败，事件**永久丢失**，`Last-Event-ID` 断线补拉机制在这条路径上被抵消（重连时服务端认为这些事件已送达）。
- **建议**：事件携带目标 peer（会话 metadata 里已有 `weixinPeer` 映射）；`lastEventId` 只在投递成功后推进，失败的事件重试或落盘。

#### N-P2-2　`conversation.ts` 硬编码 `profile.getProfile('default')`，与已修的 `profile-tools.ts` 分叉

- **位置**：`services/agent-server/src/services/conversation.ts:254` `const userProfile = await profile.getProfile('default');` vs `services/agent-server/src/services/profile-tools.ts`（六处已改为 `resolveProfileUserId(context.userId)`）
- **问题**：opus5 P2-30 修了工具侧，注入侧没跟上。一旦真的接入第二个用户，`profile.*` 工具写入 `userId=B` 的画像，而对话注入永远读 `'default'`——**写进去的画像读不出来**，比原来「全都混在 default」更难排查（原来至少是自洽的）。
- **建议**：注入处同样走 `resolveProfileUserId(...)`；若确定近期不做多用户，就在两处都加一行注释锚定「当前单用户，userId 恒为 default」，避免半途分叉。

#### N-P2-3　pgvector 维度迁移的行快照取在 `BEGIN` 之前

- **位置**：`packages/memory/src/postgres.ts` `#ensureDimensionMatches`：`SELECT id, kind, content FROM memories` 走 `this.#pool.query`，**在**单连接 `BEGIN` 之前
- **问题**：opus5 P1-8 的事务化是对的，但快照在事务外。若迁移期间有并发写入（启动早期，理论上窗口很窄），新插入的行不在快照里 → `ADD COLUMN embedding vector(N)` 后这些行的 embedding 为 NULL，向量检索静默漏掉它们，且没有任何告警。
- **建议**：`SELECT` 移到 `BEGIN` 之后、同一连接上执行；或迁移后补一句 `SELECT count(*) FROM memories WHERE embedding IS NULL` 并在非 0 时打 warn。

#### N-P2-4　`PostgresReminderStore.markDone` 缺 `AND NOT done`，无法自己防重复通知

- **位置**：`packages/memory/src/reminders.ts` `UPDATE reminders SET done = true WHERE id = $1 RETURNING ...`
- **问题**：语句是原子的，但**没有** `AND done = false`，所以两个并发 tick（或多实例部署）都会拿到 `RETURNING` 的行，各发一次通知。当前单实例 + 10s tick 下概率低，但这是「原子」和「幂等」的差别——现在只做到了前者。
- **建议**：`WHERE id = $1 AND NOT done`，`rowCount === 0` 视为已被别人处理，跳过通知。

#### N-P2-5　`PostgresTaskStore.updateTask` 的 `COALESCE` 让字段无法被显式清空

- **位置**：`packages/memory/src/tasks.ts` `SET name = COALESCE($2, name), ... tools = COALESCE($8::jsonb, tools)`
- **问题**：opus5 P1-3 用 `COALESCE` 换掉读-改-写是正确的，但副作用是 patch 语义丢了「置空」能力：想把 `tools` 清成 `null`、把 `schedule` 清掉都做不到（传 `null` 等于「不改」）。`task.update` 工具若暴露了这些字段，用户的「取消这个任务的工具限制」会静默无效。
- **建议**：区分 `undefined`（不改）与 `null`（清空），例如加 `$9::boolean` 之类的 clear 标记，或对可清空字段用 `CASE WHEN $9 THEN NULL ELSE COALESCE($8::jsonb, tools) END`。

#### N-P2-6　安全相关配置仍散落 `process.env`，无法集中审计

- **位置**：`services/agent-server/src/index.ts:351` `process.env.ENGINEER_TASK_DIR`、`:374` `process.env.WEIXIN_BRIDGE_URL ?? 'http://127.0.0.1:3100'`；weixin-bridge 侧的 `WEIXIN_*`、监听 host、`AGENT_SERVER_URL` 等
- **问题**：opus5 P2-35(c) 只修了 `HOOK_SECRET`。剩下的仍不在 `packages/config` schema 里，因此：没有类型校验、没有默认值文档、无法通过读一个文件审计「这个服务信任哪些外部输入」。`WEIXIN_BRIDGE_URL` 尤其敏感——它决定 `weixin.send_*` 把图片/语音 POST 到哪，被改成外部地址即为数据外泄通道。
- **建议**：全部收进 zod schema（含 `HOST`、bridge token、bridge URL），启动时统一校验并打印脱敏后的生效配置。

#### N-P2-7　`server-shell` 的全局 `shellQueue` 与 `coding.run` 叠加会长时间堵塞

- **位置**：`services/agent-server/src/services/server-shell.ts`（模块级单条队列）
- **问题**：第一份报告 P1-12 的残留。单用户下「所有 shell 串行」是可接受的保守设计，但队列**没有排队超时也没有队列长度上限**：`server.shell` 前面排着一条 10 分钟的命令时，后续调用只能干等到自己的 `timeoutMs` 耗尽，用户侧表现为「AI 卡住不回」。
- **建议**：加队列等待超时（等待超过 30s 直接返回「服务器正忙」）与队列深度上限；或按 `sessionId` 分队列。

#### N-P2-8　`engineer-task-runner` 的 `#persist()` 只写末 50 条，与内存表 100 条不一致

- **位置**：`services/agent-server/src/services/engineer-task-runner.ts`：`MAX_TASKS = 100` vs `#persist()` 里 `[...this.#tasks.values()].slice(-50)`
- **问题**：两个上限不一致，且 `slice(-50)` 用的是 **Map 插入序**而非 `createdAt` 序（`list()` 是按 `createdAt` 排的）。重启后能查到的任务集合与重启前不同，用户「昨天那个任务呢」会查不到。另外 `#persist()` 在每次 `onData` 之外的多个点被 `void` 调用，并发写同一 JSON 文件**没有串行化**（对比 `weixin-bridge/state.ts` 已加 `#writeQueue`），异常时可能落地半截 JSON——`loadPersisted()` 里 `catch` 会把损坏文件当空表处理，即**静默丢失全部历史**。
- **建议**：两个上限统一；持久化前按 `createdAt` 排序；照搬 `state.ts` 的 `#writeQueue` 串行化，并在 `loadPersisted()` 解析失败时打 warn（现在完全静默）。

#### N-P2-9　`filesystem.delete` 被 `unregister` 而非从未注册

- **位置**：`services/agent-server/src/index.ts:394` `toolRegistry.unregister('filesystem.delete');`
- **问题**：先注册再注销能工作，但依赖执行顺序：将来若有代码在 `createBuiltinTools` 与这行之间拿工具列表快照（例如提前生成 tool schema 发给 LLM），就会把已注销的工具暴露出去。注释解释了「为什么不要」，但没解释「为什么用 unregister 而不是不创建」。
- **建议**：给 `createBuiltinTools` 加 `exclude?: string[]` 选项，从源头不创建。

#### N-P2-10　`app.ts` 未设置 `bodyLimit` / CORS 策略

- **位置**：`services/agent-server/src/app.ts`（只对 websocket 设了 `maxPayload: 1024 * 1024`）
- **问题**：HTTP 侧沿用 Fastify 默认 `bodyLimit`（1MB）——对 `/api/hooks/:name` 接收的 GitHub 大 payload 可能偏小（PR 事件常超 1MB，会 413 且没有专门日志说明），而对 `/api/sessions/:id/chat` 的用户消息又偏大。同时没有 CORS 配置，若将来从浏览器直连会踩到；当前无鉴权（N-P0-1）的情况下，不加 CORS 反而是「幸运的默认」——但这是巧合而非设计。
- **建议**：按路由分别设 `bodyLimit`；显式声明 CORS 策略（默认拒绝）。

## 四、总结

### 4.1 复核统计

| 报告 | P0 | P1 | P2 | 合计 |
| --- | --- | --- | --- | --- |
| 第一份（DeepSeek 版） | 1✅ / 1⚠️ / 2❌ | 4✅ / 1⚠️ / 4❌ | 6✅ / 2⚠️ | 21 项 |
| 第二份（Opus 5 版） | 1✅ | **19✅** | 13✅ / 3⚠️ | 36 项 |
| **总计** | 2✅ / 1⚠️ / 2❌ | 23✅ / 1⚠️ / 4❌ | 19✅ / 5⚠️ | **57 项** |

- **已修 ✅：44 项（77%）**
- **部分修 / 设计取舍 ⚠️：7 项**
- **未修 ❌：6 项**（全部集中在同一主题：**权限边界与鉴权**）
- **回归：0 项**（4 处疑似经复核判为误报，已记入 2.3 供后续参考）

第二份报告的 19 个 P1 **全部修完**，且修复质量高：`system-status.ts` 的「白名单 env + 消费 signal + 进程组 kill + 超时小于工具超时」已经成为仓库内可复用的参考实现；`postgres-sessions.ts` / `tasks.ts` / `profile.ts` 的单语句原子更新 + 串行队列彻底解决了读-改-写族问题；`llm/index.ts` 的 `producedText` + `finally { iterator.return() }` 是教科书式的故障切换写法。

### 4.2 未修项的共同主题

6 个未修项不是彼此独立的疏漏，而是同一个决策的不同侧面：**「这是我一个人用的机器，所以不需要鉴权/确认」**。

```
外部请求 ──(无鉴权)──> /api/sessions ──> 建会话
        ──(无鉴权)──> /api/sessions/:id/chat ──> 触发任意工具
        ──(无鉴权)──> /api/events ──> 读到 requestId
        ──(无鉴权，不校验会话归属)──> /api/sessions/:id/permission ──> 自批 L3
                                                    │
    coding.run(L1, bypassPermissions, 60min) ───────┤
    weixin.send_image(L1, 任意文件/SSRF) ───────────┼──> 容器内任意代码执行 + 数据外泄
    self.apply / self.commit(L1) ───────────────────┤
    web.fetch(L0, SSRF) ────────────────────────────┘
```

L3 双确认机制本身实现得很扎实（`expiresAt` 对齐、指纹记忆有界、超时自动拒绝），但只要存在 `coding.run`(L1, 无沙箱) 这条旁路，以及「发起者可以自己批准」的鉴权缺口，整个分级模型的实际强度就等于最弱那条路径。

### 4.3 最推荐先修（按性价比排序）

1. **N-P0-1 加鉴权 + 默认只听 127.0.0.1**（约 30 行）。一个全局 `preHandler` 校验 `AGENT_API_TOKEN`，bridge 侧请求头带上；`host` 从 `0.0.0.0` 改为可配置、默认 `127.0.0.1`。这一步单独就能把上面那张攻击图整条切断，是所有修复里杠杆最大的。同批把 N-P1-9（bridge 鉴权 + `/logout` 保护）一起做。

2. **N-P1-3 `coding.run` 降权**（约 5 行）。`permissionLevel: 1 → 2`，或默认 `permissionMode` 从 `bypassPermissions` 改 `workspace-write`。改动最小、消除的能力落差最大——修完后 L3 的 `server.shell` 才真正是最高权限。同批处理 N-P1-2（`self.apply`/`self.commit` 升 L2 + 门禁改会话级）。

3. **N-P0-3 `/permission` 校验会话归属**（约 5 行）。`respond(requestId, sessionId, decision)` 里断言 `pending.request.sessionId === sessionId`。即使暂不加鉴权，这条也能挡住跨会话自批。

4. **N-P0-2 对齐规范与实现**（文档 + 约 10 行）。要么微信通道对 L3 硬拒绝，要么改写 `AGENTS.md:91`。当前状态下「规范说自动拒绝、实现是文字审批」，后来者（包括小黑自己）会按错误的规范推理安全性——这类分歧的代价通常在事后才显现。

5. **N-P1-4 `weixin.send_image` 加路径白名单 + SSRF + 体积上限**（约 20 行）。`isWithin()`、`readBodyCapped()` 两个工具函数仓库里都已存在，直接复用即可。

6. **N-P1-11 `ProfileIngestor` 节流竞态 + 停止打印用户原文**（约 3 行）。`#lastRunAt` 提到 await 之前；日志去掉消息内容。成本几乎为零，省 token 也修隐私。

其余 P1（N-P1-1 `server.shell` 三连、N-P1-5 调度停摆、N-P1-7 hook 会话膨胀、N-P1-13 记忆只注入一次）属于「运行久了才出问题」的一类，建议排在上述之后但不要无限期推迟——尤其 **N-P1-13**，它直接影响用户对「她记不记得我」的感受，是功能性问题而非纯技术债。








