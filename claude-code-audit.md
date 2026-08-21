# Promise_ai 代码审计报告

> 审计日期：2026-08-21
> 审计方式：一次性只读审计（未修改任何代码）
> 严重级别定义：
> - **P0** 必须修复（可能出错 / 安全问题 / 数据丢失）
> - **P1** 应该修复（可靠性 / 正确性 / 安全加固）
> - **P2** 优化建议（性能 / 可维护性 / 隐患）

---

## 一、审计范围

| 模块 | 关键文件 |
|---|---|
| agent-server 核心服务 | `services/conversation.ts`、`tool-execution.ts`、`approval.ts`、`task-service.ts`、`hook-service.ts`、`profile-ingestor.ts`、`engineer-task-runner.ts`、`coding-tool.ts`、`server-shell.ts`、`system-status.ts`、`self-tools.ts`、`weixin-tools.ts`、`cloud-tools.ts`、`engineer-tools.ts`、`restart-recovery.ts`、`failure-classifier.ts` |
| agent-server 路由 | `app.ts`、`index.ts`、`routes/sessions.ts`、`events.ts`、`hooks.ts`、`xiaohei.ts`、`desktop.ts`、`voice.ts`、`qwen-voice.ts`、`qwen-voice-s2s.ts`、`health.ts` |
| weixin-bridge | `relay.ts`、`event-pusher.ts`、`jobs.ts`、`ilink.ts`、`files.ts`、`index.ts`、`markdown.ts`、`login.ts`、`state.ts`、`vision.ts` |
| packages | `tools`（index/filesystem/sensitive/validate/web-fetch/web-search/github/task-tools/reminders）、`llm`、`openrouter`、`memory`（memory/postgres/postgres-sessions/tasks/profile/timeline）、`config`、`qwen-realtime` |
| 权限策略 | `AGENTS.md`（新增工具权限准则、微信通道约束） |

审计重点：真实 bug、安全问题（命令注入 / 路径穿越 / 密钥泄露 / 权限绕过）、错误处理、超时与取消、并发与竞态、流式处理、资源泄漏、性能，以及与 `AGENTS.md` 权限规则的冲突。

---

## 二、P0（必须修复）

### P0-1　微信通道未对 L2/L3 自动拒绝 —— 直接违反 AGENTS.md，权限绕过

- **位置**：`services/weixin-bridge/src/relay.ts:276-301`（`chatOnce` 的 `permission.request` 分支）、`relay.ts:475-521`（`handleInboundMessage` 文字审批）；`services/agent-server/src/services/tool-execution.ts:82-193`（`runToolCallWithApproval`）
- **问题**：`AGENTS.md` 明确规定"微信通道（weixin-bridge）对 L2/L3 自动拒绝——供微信会话使用的工具只能是 L0/L1"。但当前实现中：
  1. `tool-execution.ts` 的 `runToolCallWithApproval` **完全没有通道概念**，L2/L3 工具统一走 `approvals.request()` 弹确认；
  2. `relay.ts` 把 `permission.request` 事件转成微信文字提示（"回复「允许」继续"），用户回复"允许"即调用 `POST /api/sessions/:id/permission {approved:true}`。
  
  结果是：`server.shell`（L3，服务器任意 shell）、`cloud.server_reboot`（L3）、`self.rollback`（L3，`git reset --hard`）、`system.restart`（L3，服务重启）等系统级工具**全部可以在微信里通过一条"允许"文字放行**。这是对 AGENTS.md 硬约束的直接违背，属于权限绕过。
- **修复建议**：在工具执行入口增加通道感知。会话元数据里已带 `weixinPeer`（weixin-bridge 建会话时写入，见 `weixin-tools.ts:resolveWeixinPeer`），可在 `runToolCallWithApproval`（或 ConversationService 传入 channel 标记）中：当 `session.metadata.weixinPeer` 存在且 `tool.permissionLevel >= 2` 时，直接返回拒绝结果（`工具 ${name} 为 L2/L3，微信通道不可用`），**不发 approval、不进入 pending**。同时在 `relay.ts` 侧对 `permission.request` 兜底：若 toolName 对应 L2/L3，直接拒绝而非转文字审批。

---

### P0-2　多个高风险/敏感工具被设为 L1，微信通道可无确认执行（远程代码执行）

- **位置**：`services/agent-server/src/services/coding-tool.ts:182`（`coding.run` `permissionLevel: 1`）、`services/agent-server/src/services/engineer-tools.ts`（`engineer.delegate` L1）、`services/agent-server/src/services/self-tools.ts:165/212/247`（`self.check`/`self.apply`/`self.commit` 均为 L1）、`services/agent-server/src/services/cloud-tools.ts`（`cloud.firewall_open` L1）
- **问题**：`AGENTS.md` 说"有歧义或高风险一律 L2+"。以下 L1 工具在微信通道会**自动执行、零确认**：
  - `coding.run` / `engineer.delegate`：在服务器上直接驱动 dsh 编码代理，可读/写任意文件、跑任意命令（`permissionMode: 'bypassPermissions'` 甚至免沙箱）。通过提示词即可让模型调用它执行任意代码——这是**远程代码执行**。
  - `self.commit`：`git add -A` + `git push origin main`，微信一句话即可把工作区任意改动（包括潜在敏感文件）提交并推送到 GitHub。
  - `self.apply`：触发 `process.exit(0)` 重启服务（结合 P1-10 的门禁漏洞更严重）。
  - `cloud.firewall_open`：从微信打开服务器防火墙端口（暴露面扩大）。
- **修复建议**：将 `coding.run`、`engineer.delegate`、`self.apply`、`self.commit`、`cloud.firewall_open` 提升到 **L2+**（`self.apply`/`self.commit` 建议 L2，`coding.run` 在微信通道场景建议按通道约束处理，至少 L2）。并在 description 中显式标注风险。若确需保留 L1，必须在 `runToolCallWithApproval` 里对微信通道单独收紧（见 P0-1 的通道感知方案）。

---

### P0-3　`weixin.send_image` 任意本地文件读取 + SSRF（L1，微信通道数据外泄）

- **位置**：`services/agent-server/src/services/weixin-tools.ts:113-133`（`loadImageBytes`）、`weixin-tools.ts:144-174`（`weixin.send_image`，`permissionLevel: 1`）
- **问题**：
  1. `loadImageBytes` 对非 URL 输入直接 `readFile(source)`，**无任何路径限制**。`weixin.send_image` 是 L1，微信通道自动执行——模型被提示词诱导即可读取服务器任意文件（`/app/.env`、`/root/.ssh/id_rsa`、数据库配置等），base64 后作为"图片"发送到微信，等于**任意文件外泄**。
  2. 对 `http(s)` 输入直接 `fetchImpl(source)`，**无 SSRF 防护**：可访问内网服务、云元数据地址（`169.254.169.254`）等，内容同样回传微信。
- **修复建议**：
  - 限制 `source` 只能指向允许目录（如微信文件库目录 `/app/weixin-files`），用 `path.resolve` 后校验前缀在允许根内；拒绝绝对路径逃逸。
  - URL 分支：校验目标 IP 非内网/回环/链路本地（DNS 解析后过滤 10/8、172.16/12、192.168/16、127/8、169.254/16），或完全去掉 URL 分支。
  - 该工具建议提升权限或至少把"读任意路径"收敛为"仅读文件库已有文件"。

---

### P0-4　会话/画像读-改-写丢失更新（并发写导致消息历史丢失、工具配对损坏）

- **位置**：`packages/memory/src/postgres-sessions.ts:100-117`（`addMessage`）、`postgres-sessions.ts:119-136`（`updateSession`）、`packages/memory/src/profile.ts:361-379`（`upsertEntry`）；多实例共享 store 见 `services/agent-server/src/app.ts:88/145/157`、`services/agent-server/src/index.ts:299`，语音直写见 `routes/qwen-voice.ts:62/178`、`routes/qwen-voice-s2s.ts:100/178`
- **问题**：`PostgresSessionStore.addMessage` / `updateSession` 与 `PostgresProfileStore.upsertEntry` 都是"先 `getSession`/`getProfile` 读整个 JSONB，改完再整列 `UPDATE`"的读-改-写模式，**没有 `SELECT ... FOR UPDATE`、没有版本号、没有单条 INSERT**。而项目里同一 `store` 被**多个互不共享队列的 `ConversationService` 实例**同时使用：
  - 文本聊天：`buildApp` 内部 `conversation`；
  - 语音 cascade：`voiceConversation`；
  - 语音 S2S 委托：`new ConversationService(...)`；
  - 定时任务 / hook：`index.ts` 里的 `conversation`。
  
  每个实例有自己的 `#sessionQueues`（`conversation.ts:407`），但**跨实例不互斥**。此外语音路由还直接 `deps.store.addMessage(...)` 持久化转写文本。结果：并发写同一 session 时，一方读到的旧 `messages` 数组会覆盖另一方刚写入的消息——**消息丢失**；`updateSession`（compaction，`conversation.ts:844`）也可能覆盖掉并发新增的消息。画像 `upsertEntry` 同理会丢失条目。这是确定性数据丢失风险。
- **修复建议**（任选其一或组合）：
  - 最短路径：把"会话级互斥"从实例内提升为进程级（或全局按 sessionId 的锁），让所有通道共用同一个队列/锁。
  - 存储层：`addMessage` 改为单条追加（`messages = messages || jsonb_build_array(...)` 的原子 `UPDATE`，或独立 message 表），`updateSession` 用事务 + `SELECT ... FOR UPDATE`。
  - 画像：`upsertEntry` 用 `ON CONFLICT` + `jsonb` 的原子操作，或事务加锁。

---

## 三、P1（应该修复）

### P1-5　`web.fetch` SSRF（L0，全通道可用）

- **位置**：`packages/tools/src/web-fetch.ts:49-91`（`createWebFetchTool.execute`，`permissionLevel: 0`）
- **问题**：接受任意 http/https URL 并 `redirect: 'follow'`，只校验协议不校验目标。可访问内网、`169.254.169.254` 云元数据、内部服务（`http://127.0.0.1:3000` 等），响应正文进入 LLM 上下文（进而可达用户/微信）。L0 自动执行，是稳定的 SSRF 通道。
- **修复建议**：解析目标 host，DNS 解析后拒绝内网/回环/链路本地 IP；限制允许的端口（仅 80/443）；可选维护域名白名单。

---

### P1-6　weixin-bridge 监听 0.0.0.0 且文件/发送/删除/注销端点无鉴权

- **位置**：`services/weixin-bridge/src/index.ts:444`（`listen host: '0.0.0.0'`）、`index.ts:299-422`（`send-image` / `send-file` / `send-file-async` / `delete-file` / `files` / `jobs` / `logout` 均无鉴权）
- **问题**：除登录二维码流程外，其余端点**没有任何认证**（无 token、无 secret、无来源校验）。只要端口可达，任何主机都能：列出并读取文件库、删除文件、向已绑定微信发送任意文件/图片、注销登录态。`files.ts` 的 `sanitizeFileName` 已处理了路径穿越（值得肯定），但端点本身裸奔。
- **修复建议**：默认改为绑定 `127.0.0.1`（agent-server 与 bridge 同机/同容器网络时走内网即可）；如确需 0.0.0.0，加共享密钥（`x-bridge-token` 头，与 `HOOK_SECRET` 类似）并做恒定时间比较。

---

### P1-7　SSE 重放缓冲区被每个连接重复 push，导致事件重复推送 + Last-Event-ID 错乱

- **位置**：`services/agent-server/src/routes/events.ts:77`（共享 `eventBuffer`）、`events.ts:101-104`（每个连接的 `writeBuffered` 都调用 `eventBuffer.push`）
- **问题**：`SseEventBuffer` 只在 `registerEventRoutes` 时创建**一份**，但 `writeBuffered` 是**每个连接各自定义**的闭包，每次事件都调用共享 `eventBuffer.push(...)` 一次。于是：
  - 有 N 个活跃连接（桌面端 + weixin 的 event-pusher 同时在线是常态）时，同一事件被 push N 次，产生 N 条 id 不同的重复记录；
  - 缓冲容量 20 被 N 倍速填满，挤掉真正不同的事件；
  - 重连时 `replayAfter(lastEventId)` 会把"别的连接产生的重复记录"也重放出来，导致提醒/任务结果重复推送，且 id 跨连接发散，Last-Event-ID 语义失效。
- **修复建议**：把 `eventBuffer.push` 移到订阅回调（单一写入点），例如订阅器收到事件后 `const id = eventBuffer.push(...)` 再广播给所有连接；每个连接只负责 `reply.raw.write`（格式化），不再 push。

---

### P1-8　relay 的 90s 消息护栏不约束实际聊天；`chatOnce` 无 fetch/SSE 读取超时

- **位置**：`services/weixin-bridge/src/relay.ts:692-696`（`withTimeout(handleInboundMessage(...), 90_000)`）、`relay.ts:546-622`（后台 `void (async()=>{...})()` 启动 `chatOnce`）、`relay.ts:212-225`（`chatOnce` 的 fetch 无超时）、`relay.ts:354-374`（`consumeSse` 无超时）
- **问题**：
  1. `handleInboundMessage` 在 spawn 后台聊天后**立即返回**，所以 `withTimeout(..., 90_000)` 只覆盖了图片下载/视觉/文件入库/建会话/typing 这段同步前缀，**完全不约束真正的 `chatOnce`**。
  2. `chatOnce` 的 `fetch` 只传了 `options.signal`，而 `handleInboundMessage` 调用时**没有传 signal**（`relay.ts:549`），`consumeSse` 的 `reader.read()` 也没有超时。一旦 agent-server 慢响应或连接挂起，聊天无限挂起，`inflightSessions` 永远不释放，之后该 peer 的所有消息都被"上一条还在处理中"挡住。
- **修复建议**：给 `chatOnce` 传独立的 `AbortController`（全局上限，如 5 分钟）并传入 fetch；`consumeSse` 加 per-read 空闲超时；把护栏语义改为真正覆盖后台任务（或将后台任务改为受控、可超时的 Promise 链）。

---

### P1-9　`system.status` 忽略 abort 信号且无超时，子进程可无限存活

- **位置**：`services/agent-server/src/services/system-status.ts:14-37`（`defaultStatusRunner`）、`system-status.ts:155`（`execute` 未传/未用 `context.signal`）
- **问题**：`defaultStatusRunner` 用 `spawn('/bin/bash', ['-lc', script])`，**没有超时、没有监听 abort、没有进程组 kill**。工具声明 `timeoutMs: 30_000`，但 `runToolWithTimeout` 的 Promise.race 只在上层"报告超时"，底层 bash（含 `docker ps` 等可能挂起的子命令）**继续运行**，成为孤儿进程并持续占用 shell。定时任务每 30 秒就可能 spawn 一个这种孤儿。
- **修复建议**：参照 `server-shell.ts:defaultRunner` 的实现，为 `defaultStatusRunner` 加超时定时器、abort 监听与进程组 kill-tree；或在 `execute` 里接收并使用 `context.signal`。

---

### P1-10　`self.apply` 门禁 `lastSelfCheckPassed` 为进程级全局，跨会话/跨通道泄漏

- **位置**：`services/agent-server/src/services/self-tools.ts:89`（模块级 `let lastSelfCheckPassed`）、`self-tools.ts:181`（`self.check` 写入）、`self-tools.ts:215`（`self.apply` 读取门禁）
- **问题**：`self.apply` 是否允许重启只取决于**进程内最近一次 `self.check` 是否通过**，与哪个会话/通道触发的 check 无关。任一桌面会话跑通 `self.check` 后，微信通道（或任何其他会话）的 `self.apply` 即被解锁，可触发 `process.exit(0)` 重启整个 agent-server（拒绝服务）。门禁本意是"我的改动验证过"，但被全局状态污染。
- **修复建议**：把门禁按 sessionId（或 requestId）隔离，或用"待应用的已提交改动标记 + 对应会话"绑定；至少应要求 `self.check` 与 `self.apply` 发生在同一会话且近期。

---

### P1-11　`runToolWithTimeout` 超时只"报告"不"终止"底层工具

- **位置**：`services/agent-server/src/services/tool-execution.ts:26-75`（`runToolWithTimeout`）
- **问题**：`Promise.race` 超时后仅 `controller.abort(...)`，但注释所称"tools that ignore the abort signal still get cut off"并不成立——不响应 signal 的工具（如 P1-9 的 `system.status`、任何内部自建 AbortController 的 fetch）会**在超时后继续执行**。上层已返回"已终止"，实际工作仍在跑，可能产生副作用或资源泄漏。代码应诚实区分"已取消"与"已终止"。
- **修复建议**：对可控工具统一要求真正响应 abort（kill 子进程/中断 fetch）；在 `runToolWithTimeout` 文档与错误信息中明确"超时=已请求取消，是否真正停止取决于工具实现"；对不响应 signal 的工具逐个补齐（优先级最高的就是 `system.status`）。

---

### P1-12　全局 `shellQueue` 串行所有 shell 命令，队头阻塞

- **位置**：`services/agent-server/src/services/server-shell.ts:168-177`（`shellQueue` / `withShellLock`）
- **问题**：所有 `server.shell` 命令（聊天、语音、定时任务）共用一个进程级串行队列。一个 5 分钟的长命令会阻塞其它所有会话的 shell 调用；若某命令因 bug 未返回（或超时后子进程未死），后续所有 shell 命令永久排队。串行化本意是避免重命令互扰，但粒度过粗。
- **修复建议**：按 sessionId 分片（每会话串行、跨会话并行），或用有界并发 + 按资源类型分类；同时保证超时/取消一定会释放队列槽位（`withShellLock` 已用 `.then(fn, fn)` 兜底，需确认 abort 后 `fn` 一定 settle）。

---

### P1-13　多个内存集合无界增长

- **位置**：`services/agent-server/src/services/approval.ts:60/147-155`（`#approved` Map 永不清理）、`services/agent-server/src/services/engineer-task-runner.ts:110`（`#tasks` Map 永不驱逐，仅持久化末 50 条）、`services/weixin-bridge/src/jobs.ts`（`FileJobManager.#jobs` 无界）、`services/agent-server/src/services/hook-service.ts:85-88`（每次事件 `createSession` 新会话，无清理）
- **问题**：长跑进程里这些集合只增不减：approved 指纹、历史任务、文件任务、hook 会话（每个 webhook 事件建一个 session，且都进入 `collectPersistentContext` 的全量记忆扫描）都会随时间线性膨胀内存与 DB。
- **修复建议**：给 `#approved` 加 LRU/上限并在会话删除时清理；`#tasks` 加定时清理或上限；`FileJobManager.#jobs` 完成即删或设上限；hook 会话复用固定会话或加保留上限。

---

## 四、P2（优化建议）

### P2-14　`collectPersistentContext` 每轮全量加载所有记忆

- **位置**：`services/agent-server/src/services/conversation.ts:218-272`（`collectPersistentContext`，`memory.list()` 无 kind 过滤）
- **问题**：每轮对话都 `memory.list()` 拉**全部**记忆到内存再过滤（Postgres 下是全表查询），随记忆增长每轮延迟与内存占用上升。
- **修复建议**：给 `MemoryStore.list` 增加 tag/kind 过滤并下推到 SQL（`WHERE tag='goal'`），只取目标/反馈两类；或增加 `limit` 参数。

### P2-15　`validate.ts` 未捕获的正则构造

- **位置**：`packages/tools/src/validate.ts`（`new RegExp(schema.pattern)`）
- **问题**：若某个工具 schema 的 `pattern` 是非法正则，会在请求校验时抛异常（可能 500 而非返回校验失败），属于未防御的输入。
- **修复建议**：try/catch 包裹 `new RegExp`，构造失败视为校验错误返回，而非抛出。

### P2-16　`collectSecrets` 跳过 <8 字符密钥，短密钥不脱敏

- **位置**：`services/agent-server/src/services/server-shell.ts:90-111`（`collectSecrets` / `redactOutput`）
- **问题**：长度 <8 的密钥值被直接跳过，且 `redactOutput` 也只替换 `>=8` 的值。短 token/口令（如 6 位密码）会原样出现在 shell 输出与会话历史中。
- **修复建议**：降低阈值（如 >=4），并对脱敏命中做审计日志；注意过短值误替换率高，可结合 key 名精确匹配。

### P2-17　`databaseUrl` 日志可能泄露密码片段

- **位置**：`services/agent-server/src/index.ts:139`（`config.databaseUrl.split('@')[1]`）
- **问题**：当数据库密码含 `@` 时，`split('@')[1]` 会把密码的剩余片段一并打出来（`postgres://user:pa@ss@host/db` → `ss@host/db`）。
- **修复建议**：改用 `new URL(databaseUrl)` 解析，仅打印 `host:port/db`，绝不打 user/password。

### P2-18　`autoApproveAll` 全局全权限是易踩雷开关

- **位置**：`packages/config/src/index.ts`（`AUTO_APPROVE_ALL`）、`services/agent-server/src/services/conversation.ts:70-72`（注入 `AUTO_APPROVE_PROMPT`）
- **问题**：开启后所有 L2/L3 工具自动执行、且系统提示明确告诉模型"不要询问"——任何通道（含微信）都变成全权限。若误开（或 .env 里残留 true），风险极高。
- **修复建议**：启动日志强警告 + `/health` 已暴露 `autoApproveAll`（可保留）；建议增加"开启时禁止微信通道会话创建"或明确隔离到指定会话/通道。

### P2-19　hook 密钥非恒定时间比较

- **位置**：`services/agent-server/src/routes/hooks.ts:37`（`provided !== deps.secret`）
- **问题**：普通字符串 `!==` 比较存在时序侧信道（极低实际风险，但属于可改进点）。
- **修复建议**：改用 `crypto.timingSafeEqual`（需先长度对齐）。

### P2-20　工具名下划线化的潜在冲突（待验证）

- **位置**：`services/agent-server/src/services/conversation.ts:392-394`（`sanitizeToolName`）、`conversation.ts:464-472`（`restoreToolName`）
- **问题**：`.` 等被统一替换为 `_`，若未来出现 `foo.bar` 与 `foo_bar` 两个工具，会碰撞且反查表只能映射到一个。当前工具集无此对，属**潜在隐患**。
- **修复建议**：注册时校验 sanitize 后名称唯一；或用双向唯一映射表替代字符替换。

### P2-21　其它待验证 / 轻微项

- **openrouter 最终总结中出现 tool_calls（待验证）**：`packages/openrouter/src/index.ts` 在"工具轮次用尽后的最终总结"（不带 tools 的请求）中若仍残留 tool_calls，需要确认是否会随无工具请求发出。**待验证**。
- **`state.ts` save 并发非原子（待验证）**：weixin-bridge 的 state 持久化在并发 `persist()` 下是否保证原子写。**待验证**。
- **`files.ts` 路径穿越**：`sanitizeFileName` 用 `path.basename` + 反斜杠替换，**已基本处理**，未发现可利用穿越；仅提示对 unicode/绝对路径做回归测试。
- **`weixin.delete_file`（L1）**：description 已标注"永久删除，不可恢复"，符合 AGENTS.md 的描述要求；但"任何会话都可用"配合无鉴权桥端点（P1-6）放大了风险，建议一并评估。

---

## 五、总结

### 项目整体健康度

架构清晰、工程纪律良好：工具注册/权限分级/审批流（ApprovalRegistry、L2 指纹记忆、L3 双确认）、LLM 流式重试与空闲超时、会话级串行队列、shell 进程组 kill-tree、输出脱敏、SSE 重放、重启恢复、派单硬校验、工具预算熔断等设计都在，且大量吸收了 OpenClaw/OpenCrabs/Prime Agent 等参考项目的成熟思路。类型系统与分层（packages/services/routes）合理，错误处理普遍有兜底。

**但存在一条系统性风险主线**：**权限策略（AGENTS.md）与实现脱节**。最严重的三条 P0（微信 L2/L3 未拒绝、高风险工具被标 L1、微信发图任意读文件）本质是同一个问题——"通道"这一维度在 `runToolCallWithApproval` 里不存在，导致针对微信的硬约束完全没有落地。此外，**存储层读-改-写**与**多实例共享 store** 的组合埋下了数据丢失的确定性竞态。

### 最值得先做的 3 件事

1. **落地通道感知的权限闸门（P0-1 + P0-2 + P0-3）**：在工具执行入口识别 `weixinPeer`，对微信通道一律拒绝 L2/L3；并把 `coding.run`/`engineer.delegate`/`self.commit`/`self.apply`/`cloud.firewall_open` 提升到 L2+、`weixin.send_image` 收敛到允许目录。这三项同源、改动集中，能把最严重的攻击面一次性收口。
2. **修会话/画像读-改-写竞态（P0-4）**：把会话级互斥提升为进程级（跨实例共享锁），或将 `addMessage` 改为原子追加、`updateSession`/`upsertEntry` 加 `SELECT ... FOR UPDATE`。这是数据正确性的根基。
3. **补 weixin-bridge 鉴权 + SSE 重放去重（P1-6、P1-7）**：bridge 默认绑 127.0.0.1 或加共享密钥；`events.ts` 把 `push` 移到单一订阅写入点。两项改动小、收益直接，能消除外泄通道与重复推送。

完成这三组后，再依次处理 P1-8（relay 超时失效）、P1-9（system.status 孤儿进程）、P1-10（self.apply 门禁全局化）等可靠性问题。

---

*本报告为只读审计产出，未对任何代码进行修改。*
