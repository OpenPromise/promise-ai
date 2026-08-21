# Promise_ai 代码审计报告（Opus 5 版）

> 审计日期：2026-08-21
> 审计方式：只读审计，**未修改任何代码**
> 审计者：Claude Opus 5（独立复核 DeepSeek 版 `claude-code-audit.md`）
>
> 级别定义：
> - **P0** 必修：数据丢失 / 远程权限提升 / 确定性损坏
> - **P1** 该修：可靠性、正确性、资源泄漏、功能形同虚设
> - **P2** 可优化：性能、可维护性、纵深防御
>
> 前置约定（用户明确指定）：**P0-1 / P0-2 / P0-3（通道权限、高风险工具标 L1、`weixin.send_image` 任意读文件）属于有意设计的"全权限模式"，不算问题，本报告不复核、不重复报告。** 同理 `AUTO_APPROVE_ALL`（原 P2-18）、`engineer.delegate` 目录无白名单、`coding.run` 免沙箱等同源项一并视为设计选择，仅在必要处作为"风险放大器"提及。

---

## 一、审计范围

| 模块 | 已通读文件 |
|---|---|
| agent-server services | `conversation.ts`、`tool-execution.ts`、`approval.ts`、`task-service.ts`、`hook-service.ts`、`profile-ingestor.ts`、`profile-tools.ts`、`engineer-task-runner.ts`、`engineer-tools.ts`、`coding-tool.ts`、`server-shell.ts`、`system-status.ts`、`self-tools.ts`、`weixin-tools.ts`、`cloud-tools.ts`、`desktop-bridge.ts`、`restart-recovery.ts`、`failure-classifier.ts`、`reminder-service.ts` |
| agent-server routes | `app.ts`、`index.ts`、`sessions.ts`、`events.ts`、`hooks.ts`、`desktop.ts`、`health.ts`、`xiaohei.ts`、`voice.ts`、`qwen-voice.ts`、`qwen-voice-s2s.ts` |
| weixin-bridge | `relay.ts`、`event-pusher.ts`、`ilink.ts`、`state.ts`、`markdown.ts`、`vision.ts`、`files.ts`、`jobs.ts`、`index.ts`、`login.ts` |
| packages/memory | `index.ts`、`postgres.ts`、`postgres-sessions.ts`、`memory.ts`、`profile.ts`、`tasks.ts`、`timeline.ts` |
| packages/tools | `index.ts`、`filesystem.ts`、`sensitive.ts`、`validate.ts`、`web-fetch.ts`、`web-search.ts`、`github.ts`、`task-tools.ts`、`reminders.ts`、`memory-tools.ts`、`goal-tools.ts` |
| packages 其它 | `llm`、`openrouter`、`config`、`qwen-realtime` |
| 规范 | `AGENTS.md`（工具权限准则、微信通道约束、破坏性操作标注）；仓库无 `CLAUDE.md` |

审计重点：真实 bug、安全隐患（命令注入 / 路径穿越 / 密钥泄漏 / 权限提升 / SSRF）、错误处理缺陷、超时与取消遗漏、并发与竞态、流式处理、资源泄漏、性能，以及与 `AGENTS.md` 的冲突。

---

## 二、上一份报告（DeepSeek 版）复核结果

### 2.1 P0-4（读-改-写丢失更新）—— 用户重点要求验证

**结论：会话（sessions）真修好了；用户画像（profile）只是"缓解"，不是修好；任务（tasks）同族问题被漏掉了；另外压缩路径仍有残留窗口。**

**（a）会话存储：已真正修复 ✅**

`packages/memory/src/postgres-sessions.ts:addMessage`（第 115-121 行）已改为数据库侧原子追加，不再读-改-写：

```ts
`UPDATE sessions SET messages = messages || $2::jsonb, updated_at = $3 WHERE id = $1`
```

`updateSession`（第 131-144 行）也是单条语句：`messages = COALESCE($2::jsonb, messages)`，metadata 用 `COALESCE(metadata,'{}') || $3::jsonb` 合并，未提供的字段保留原值。两者都用 `result.rowCount === 0` 判定会话不存在并抛 `SessionNotFoundError`（旧实现依赖先 SELECT，这点也顺带修对了）。**多写入方（文本聊天 / 语音 cascade / 语音 S2S / 定时任务 / hook）并发追加消息不再互相覆盖**，跨进程也安全。这条修复是扎实的。

**（b）用户画像：只是进程内缓解，未修复根因 ⚠️（仍属 P1）**

`packages/memory/src/profile.ts:PostgresProfileStore.#runExclusive`（第 304-321 行）新增了按 `userId` 的**进程内串行队列**，`upsertEntry` / `removeEntry` / `replaceAll` 都包在里面。这解决了"同进程内画像工具与对话后异步抽取并发"的场景，但：

- 数据库侧仍是 `getProfile()` → 内存改 → 整列 `INSERT ... ON CONFLICT DO UPDATE SET entries = $2`（第 391-406 行），**没有 `SELECT ... FOR UPDATE`、没有版本号**。多进程 / 多副本（或未来水平扩容、以及任何直接连库的写入方）依然丢失更新。
- `rollbackEntry`（第 497-516 行）**在锁外**先 `listHistory` + `resolveRollbackTarget`，然后才调用加锁的 `upsertEntry`。这是 TOCTOU：读历史与写回之间若有并发 `upsertEntry`，回滚会基于过期历史把新值覆盖掉。
- `clear()`（第 518-520 行）也在锁外，且只删 `user_profiles` 不删 `profile_events`——与 `InMemoryProfileStore.clear`（同时清空 `#events`）行为不一致，语义漂移。

**（c）任务存储：同族问题，上一份报告漏报 ⚠️（新发现，见 P1-3）**

`packages/memory/src/tasks.ts:PostgresTaskStore.updateTask`（第 253-278 行）仍是 `getTask()` → 展开 patch → 整行 `UPDATE`。调度器每次 tick 写 `lastRunAt`（`task-service.ts:133`），与用户通过工具改 `schedule`/`enabled` 并发时会互相覆盖。

**（d）对话压缩：残留丢失窗口 + 只能压缩一次 ⚠️（见 P1-4）**

`services/agent-server/src/services/conversation.ts:#compactIfNeeded`（第 816-859 行）：读 session → 一次 LLM 摘要（秒级到十秒级）→ `updateSession({ messages: [摘要, ...最近N条] })` 整列替换。这段窗口里被其它通道 `addMessage` 追加的消息会被整列替换抹掉。存储层的原子性帮不上——这里语义上就是"整列覆盖"。

**P0-4 综合判定：部分修复。** 会话（最主要的数据）已修好，可以从 P0 降级；画像、任务、压缩三处残留，合并降为 P1。

### 2.2 其余 P0/P1/P2 逐条复核

| 编号 | 原始结论 | 复核结论 | 代码依据 |
|---|---|---|---|
| P0-1 / P0-2 / P0-3 | 通道权限 / 高风险工具 L1 / send_image 读文件 | **不复核**（用户指定：有意设计的全权限模式） | — |
| P0-4 | 读-改-写丢失更新，声称已修 | **部分修复**：会话已修 ✅；画像/任务/压缩未修 ⚠️ | 见 2.1 |
| P1-5 | `web.fetch` SSRF | **未修复** | `packages/tools/src/web-fetch.ts`：`permissionLevel: 0`，只校验 `http:`/`https:`，随后 `fetchImpl(parsed, { redirect: 'follow' })`，无 host/IP/端口过滤。**另有新缺陷**：2MB 上限判断放在 `await response.text()` 之后，body 已全量进内存，限流没起到防内存爆的作用 |
| P1-6 | bridge 监听 0.0.0.0 且端点无鉴权 | **未修复** | `services/weixin-bridge/src/index.ts:444`：`app.listen({ port, host: '0.0.0.0' })`；全文无 `x-bridge-token` / secret / preHandler 鉴权 |
| P1-7 | SSE 缓冲被每连接重复 push | **已修复** ✅ | `routes/events.ts:78-91`：单一 `eventBuffer` + 单一 `broadcast` 写入点，事件源只订阅一次（第 93-108 行），每连接只负责 `write`。**残留小 bug**：`system.boot` 的 `bootSent` 是每连接局部变量（第 136 行），第二个客户端连上会再广播一次 boot，见 P1-9 |
| P1-8 | relay 90s 护栏不约束实际聊天；`chatOnce` 无超时 | **未修复** | `relay.ts:693` 的 `withTimeout(handleInboundMessage(...), 90_000)` 只覆盖同步前缀——`handleInboundMessage` 在 `relay.ts:547` `void (async () => {...})()` 后立即返回；`chatOnce`（第 213-221 行）调用时**未传 signal**（第 549 行没有 signal 字段），`consumeSse`（第 354-369 行）的 `reader.read()` 也无空闲超时。**另发现 `withTimeout` 自身写错了**，见 P1-6 |
| P1-9 | `system.status` 忽略 abort、无超时、孤儿进程 | **未修复** | `services/agent-server/src/services/system-status.ts`：`spawn('/bin/bash', ['-lc', script], { stdio, env: process.env })` 无 `detached`、无定时器、无 abort 监听、无进程组 kill；`async execute(): Promise<ToolResult>` **连 `context` 参数都没接**，`context.signal` 结构上不可达，尽管声明了 `timeoutMs: 30_000` |
| P1-10 | `self.apply` 门禁为进程级全局 | **未修复** | `services/agent-server/src/services/self-tools.ts:89` 模块级 `let lastSelfCheckPassed = false`；第 181 行 `self.check` 写、第 215 行 `self.apply` 读。**新增观察**：apply 后从不复位，一次通过的 check 永久解锁无限次重启 |
| P1-11 | `runToolWithTimeout` 超时只报告不终止 | **未修复** | `tool-execution.ts:26-75` 仍是 `Promise.race` + `controller.abort()`；`system.status`、`coding.run`、`server.shell` 三个最重的工具都不消费 `context.signal`，注释所称"仍被切断"不成立 |
| P1-12 | 全局 `shellQueue` 串行所有 shell | **未修复** | `server-shell.ts:168-177`：进程级单队列 `shellQueue`，无按 sessionId 分片 |
| P1-13 | 多个内存集合无界增长 | **未修复** | `approval.ts:60` `#approved` Map 无清理（仅 `clearSession` 手动调用）；`engineer-task-runner.ts:110` `#tasks` 无驱逐（`#persist` 只写末 50 条，内存表仍全量）；`hook-service.ts` 每事件新建 session |
| P2-14 | `collectPersistentContext` 每轮全量加载记忆 | **未修复** | `packages/memory/src/postgres.ts:127` `async list(kind?)` 无 limit 参数；`conversation.ts` 每轮调用 |
| P2-15 | `validate.ts` 未捕获的 `new RegExp` | **未修复** | `packages/tools/src/validate.ts:81`：`!new RegExp(schema.pattern).test(...)` 无 try/catch，非法 pattern 直接抛出 |
| P2-16 | `collectSecrets` 跳过 <8 字符密钥 | **未修复** | `server-shell.ts:93` `if (!value || value.length < 8) continue;`、第 106 行 `if (secret.length >= 8)` |
| P2-17 | `databaseUrl` 日志泄露密码片段 | **未修复** | `services/agent-server/src/index.ts:139` 仍用 `config.databaseUrl.split('@')[1]` |
| P2-18 | `autoApproveAll` 全局全权限 | **不复核**（有意设计） | `packages/config/src/index.ts` 注释即写明"全权限模式" |
| P2-19 | hook 密钥非恒定时间比较 | **未修复** | `routes/hooks.ts:37` `provided !== deps.secret`。**另发现**：`deps.secret` 为可选，未配置时端点完全开放 |
| P2-20 | 工具名下划线化潜在冲突 | **仍成立（潜在）** | `packages/tools/src/index.ts` 的 `register` 只对原始名去重，无法察觉 sanitize 后碰撞；`conversation.ts:392` `sanitizeToolName` 把 `.` 转 `_` |
| P2-21① | openrouter 最终总结仍带 tool_calls | **误报 ❌** | `packages/openrouter/src/index.ts` 的 `chat`/`generate` 均为条件展开：`...(input.tools && input.tools.length > 0 ? { tools: input.tools } : {})`、`...(input.toolChoice ? { tool_choice: input.toolChoice } : {})`。无工具的最终总结请求两个字段都不发送 |
| P2-21② | `state.ts` save 并发非原子 | **基本误报 ❌（残留小问题）** | `weixin-bridge/src/state.ts:save` 是 `writeFile(tmp)` + `rename(tmp, file)` 的原子替换，不会写出半个文件。残留：并发 `save()` 共用同一个 `${file}.tmp` 且无串行化，交错写入可能 rename 出一个内容错乱的文件（见 P2-16） |
| P2-21③ | `files.ts` 路径穿越 | **确认已处理 ✅** | `sanitizeFileName` 用 `path.basename` + 反斜杠替换，未发现可利用穿越 |

**复核汇总**：已修 2 项（P0-4 的会话部分、P1-7）；误报 2 项（P2-21 的 openrouter 与 state.ts）；其余 P1-5、P1-6、P1-8、P1-9、P1-10、P1-11、P1-12、P1-13、P2-14、P2-15、P2-16、P2-17、P2-19、P2-20 全部未修；P0-1/2/3、P2-18 按用户要求不复核。

---

## 三、新发现（按级别分组）

### P0（必修）

#### P0-1　`/ws/desktop` 无鉴权 + 客户端自报 `permissionLevel` 注入全局工具表 → 远程权限提升

- **位置**：`services/agent-server/src/routes/desktop.ts:10-12`（`registerDesktopRoutes`）、`services/agent-server/src/services/desktop-bridge.ts:40-61`（`DesktopToolBridge.registerTools`）
- **问题**：`/ws/desktop` WebSocket **没有任何认证**（无 token、无来源校验），而 `agent-server` 监听 `0.0.0.0`（`index.ts:427`）。任何能连到该端口的主机发一条 `hello` 消息，其声明的工具就被直接注册进**全局共享的 `ToolRegistry`**，且权限级别取自客户端自报字段：

  ```ts
  const tool: Tool = {
    name: declaration.name,
    description: declaration.description,
    inputSchema: declaration.inputSchema,
    permissionLevel: declaration.permissionLevel,   // ← 客户端说自己是 L0 就是 L0
    ...
  };
  this.#registry.register(tool);
  ```

  后果：攻击者可注册一个描述诱人（如"查询系统信息"）的 **L0** 工具，它随后对**所有会话与所有通道**（微信、定时任务、语音、hook）可见并**自动执行零确认**，参数由 LLM 生成、结果回流进对话上下文。这与"全权限模式"不同——全权限是主人自己授权本机工具，这里是**未认证的第三方向主人的 agent 注入工具**，属于外部权限提升，不在用户声明的设计豁免范围内。
- **附带缺陷**：`#cleanup()`（`desktop-bridge.ts:123-133`）按名字无条件 `unregister`，**无归属校验**。两个桌面客户端先后连接时，A 断开会把 A 注册的工具从全局注册表摘掉——而 B 因为 `registerTools` 里的 `if (this.#registry.has(name)) continue` 曾静默跳过同名注册，B 之后调用该工具就变成"工具不存在"。同时 `#executeRemote`（第 63-85 行）完全忽略 `context.signal`，只有自己的 60s 定时器，上层 abort 无法中断远端执行。
- **修复建议**：
  1. `/ws/desktop` 加共享密钥握手（`?token=` 或首帧 `auth`，用 `crypto.timingSafeEqual` 比较），未通过直接 `socket.close()`；并把默认监听改为 `127.0.0.1` 或通过反代限制。
  2. **服务端强制权限级别**：忽略 `declaration.permissionLevel`，对桌面注入工具统一按 L2（或从服务端配置的白名单映射取级别）。客户端自报的权限级别在任何情况下都不应被信任。
  3. 给注入工具名加命名空间前缀（如 `desktop.<name>`）并记录归属 bridge 实例，`#cleanup` 只注销自己注册的、且仍归属自己的名字。
  4. `#executeRemote` 监听 `context.signal`，abort 时立即 resolve 并向桌面端发 `tool.cancel`。

---

### P1（该修）

#### P1-2　`weixin-bridge` 的 `withTimeout` 实现错误：`finally` 里立即 `clearTimeout`，超时永不触发

- **位置**：`services/weixin-bridge/src/relay.ts:733-744`（`withTimeout`）
- **问题**：

  ```ts
  try {
    return Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);   // ← 同步执行，Promise.race 尚未 settle
  }
  ```

  `try` 块里是 `return` 一个 Promise，**`finally` 在返回前就同步跑完**，定时器在 race 还没决出胜负时就被清掉了。于是 `timeout` 分支永远不会 reject，`withTimeout` 退化成 `Promise.race([promise])` —— **这个"单条消息处理护栏"（`relay.ts:693`）完全失效**。这与 P1-8 叠加：既然 `chatOnce` 本身也没有超时（未传 signal、`consumeSse` 无空闲超时），一旦 agent-server 挂起，`inflightSessions` 永不释放，该 peer 后续所有消息都被"⏳ 上一条还在处理中"拒绝，微信侧彻底失联，只能重启 bridge。
- **修复建议**：把清理移到 race 结果之后：

  ```ts
  async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_r, reject) => {
      timer = setTimeout(() => reject(new Error(`${label}（${ms}ms）`)), ms);
      timer.unref?.();
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  ```

  同时给 `chatOnce` 传一个独立 `AbortController`（如 5 分钟上限）并透传进 `fetch`，`consumeSse` 加 per-read 空闲超时；`inflightSessions` 的释放应挂在带超时的 promise 上，而非无约束的后台任务。

#### P1-3　`PostgresTaskStore.updateTask` 读-改-写丢失更新（P0-4 同族，上一份漏报）

- **位置**：`packages/memory/src/tasks.ts:253-278`（`PostgresTaskStore.updateTask`）；触发方 `services/agent-server/src/services/task-service.ts:133`（`updateTask(task.id, { lastRunAt })`）、`task-service.ts:143`（`{ sessionId }`）
- **问题**：`const current = await this.getTask(id)` → 展开 patch → 整行 `UPDATE tasks SET ...`。调度器每 tick 都会写 `lastRunAt`，用户此刻通过 `task.create`/编辑改动 `schedule`、`enabled`、`tools` 的话，两边互相覆盖：调度器的整行写会把用户刚改的 `enabled=false` 复原（导致"已关掉的任务又跑起来"），反之也可能丢掉 `lastRunAt` 造成重复触发。
- **附带**：`updateTask` 的入参类型是 `Partial<Pick<Task, ...>>`，其中**没有列出 `tools`**，但函数体里写了 `next.tools`（类型上依赖 `current` 的展开）——若将来通过工具修改白名单，类型层面拦不住，属签名与实现不一致。
- **修复建议**：改成只更新提供字段的单条语句，`COALESCE` 兜底：

  ```sql
  UPDATE tasks SET
    name = COALESCE($2, name),
    schedule = COALESCE($3, schedule),
    enabled = COALESCE($4, enabled),
    last_run_at = COALESCE($5, last_run_at),
    session_id = COALESCE($6, session_id),
    tools = COALESCE($7::jsonb, tools)
  WHERE id = $1 RETURNING *
  ```

  并把 `tools` 补进 `Pick<>` 类型。

#### P1-4　对话压缩仍有丢失窗口，且每个会话只能压缩一次（长会话必然重回全量上下文）

- **位置**：`services/agent-server/src/services/conversation.ts:816-859`（`#compactIfNeeded`）
- **问题**（两条）：
  1. **丢失窗口**：读 session → LLM 摘要（数秒）→ `updateSession({ messages: [摘要, ...最近N条] })`。整列替换会抹掉这期间由语音路由 / 定时任务 / hook 通过 `addMessage` 追加的消息。存储层的原子追加解决不了"整列替换"的语义。
  2. **只压一次**：第 818 行 `if (session.metadata?.compacted === true) return session;`，而压缩后又把 `compacted: true` 写进 metadata（第 847 行）。于是**任何会话终生只压缩一次**——第二次超过阈值时直接返回，上下文继续无界增长，压缩机制形同一次性。微信/桌面长期使用同一会话时这条几乎必然踩到。
- **修复建议**：
  1. 门槛改为按数量判断而非布尔标记，例如记 `compactedUpTo`（已摘要的消息条数）或 `lastCompactedAt`，只要 `messages.length > COMPACTION_THRESHOLD` 且距上次压缩超过冷却期就再压一次（摘要可级联：把上次摘要当作最早一条历史一起喂进去）。
  2. 压缩写回改为"基于读取时的消息数做条件替换"：在 `updateSession` 增加 `expectedMessageCount`，SQL 侧 `WHERE jsonb_array_length(messages) = $n`，不匹配则跳过本次压缩（下轮再来），避免覆盖并发新增。

#### P1-5　`system.status` 无超时/无 abort/无进程组 kill，且把全部环境变量交给子进程

- **位置**：`services/agent-server/src/services/system-status.ts:14-37`（`defaultStatusRunner`）、`:155`（`execute` 未接 `context`）
- **问题**：这是复核确认的 P1-9，本报告补充两点新内容：（a）`execute` 的签名根本没有 `context` 参数，因此"传 signal 就能修"这条路在当前结构下不成立，需要同时改签名；（b）`env: process.env` 把 `OPENROUTER_API_KEY`、`DASHSCOPE_API_KEY`、`DATABASE_URL`、`HOOK_SECRET` 等全部交给 `/bin/bash -lc` 脚本及其所有子命令，脚本一旦被改动（`self.apply` 路径可写代码）即为密钥外泄面。定时任务每 30 秒可能 spawn 一个不受控 bash。
- **修复建议**：照抄 `server-shell.ts:defaultRunner` 的模式——`detached: true` + 超时定时器 + `context.signal` 监听 + `process.kill(-child.pid, 'SIGTERM')` 宽限后 `SIGKILL`；`env` 改为显式最小集合（`PATH`、`LANG`、`HOME`）。

#### P1-6　重复的 `system.boot` 通知：`bootSent` 是每连接局部变量

- **位置**：`services/agent-server/src/routes/events.ts:136-145`
- **问题**：

  ```ts
  let bootSent = false;                    // ← 每个连接各有一份
  if (!bootSent && shouldEmitBootNotice(...)) {
    bootSent = true;
    broadcast('system.boot', {...}, true); // ← 广播给所有连接
  }
  ```

  `bootSent` 在 `app.get` 回调内部声明，永远是 `false`，所以**每个新连接**只要还在 10 分钟窗口内就会再 `broadcast` 一次 boot，且是广播——已在线的客户端会收到 N 份"云服务器重启完成"。开机后桌面端 + weixin event-pusher 陆续连上、或任一端重连，微信就会收到多条重复通知（`event-pusher.ts:48-50` 直接转成文字推送）。
- **修复建议**：把 `bootSent` 提到 `registerEventRoutes` 作用域（与 `eventBuffer`、`connections` 同级），只广播一次；后连接的客户端靠 `Last-Event-ID` 重放补收（缓冲机制已支持）。

#### P1-7　`FallbackLLMProvider.chat` 的 `started` 判定过早，导致故障切换失效 + 主流迭代器泄漏

- **位置**：`packages/llm/src/index.ts:258-280`（`FallbackLLMProvider.chat`）
- **问题**：
  1. `started = true` 在**第一个 chunk 被 yield 时**就置位，而首个 chunk 常常是不含可见文本的（`delta: ''` 的 role/usage/tool_calls chunk）。此后主模型立刻失败（限流、连接重置）就不再切备用，直接抛给上层 → 用户看到"聊天失败"，而设计意图（首 token 前失败才切换）本应覆盖这种"实质上还没输出任何内容"的情况。判定应基于"是否已产出可见 delta"。
  2. `finally` 只在 `!started` 时调 `iterator.return()`。一旦 `started` 为真而**消费方提前 break**（`conversation.ts` 的工具轮次、超时、abort 都会提前退出 for-await），主模型的底层 reader 不会被关闭，HTTP 连接与 `ReadableStream` 悬挂直到 GC/服务端超时。
- **修复建议**：`started` 改为 `producedText`（`value.delta` 非空才置位）；`finally` 无条件调用 `iterator.return?.()`（对已完成的迭代器是无害的幂等操作）。

#### P1-8　pgvector 维度迁移不是真事务：`BEGIN/COMMIT/ROLLBACK` 发在连接池上

- **位置**：`packages/memory/src/postgres.ts:82-113`（`#ensureDimensionMatches`）
- **问题**：`BEGIN`、`ALTER TABLE ... DROP COLUMN embedding`、`ADD COLUMN`、逐行重嵌入 `UPDATE`、`COMMIT`/`ROLLBACK` **全部通过 `this.#pool.query(...)` 发出**。pool 每次 `query` 可能拿到不同连接，所以这些语句可能落在不同 session 上——事务边界不存在，`ROLLBACK` 甚至可能发给一条无关连接。中途失败（比如逐行重嵌入时云嵌入接口报错）会留下**已 DROP 又未回填的 embedding 列**：向量检索静默退化为"全空向量"，且没有任何告警。存量记忆越多，逐行重嵌入的失败概率越高。
- **修复建议**：用 `const client = await this.#pool.connect()`，在**同一 client** 上跑 `BEGIN`/DDL/UPDATE/`COMMIT`，`finally` 里 `client.release()`；重嵌入建议分批并在失败时明确抛错阻止服务启动（而非静默进入降级状态），或改为"新增 `embedding_v2` 列 → 回填完成后再切换"的双列迁移，避免任何时刻检索列为空。

#### P1-9　DashScope 嵌入无超时/无 signal：`memory.add` / `search` 可无限挂起

- **位置**：`packages/memory/src/memory.ts:85-126`（`createDashScopeEmbedder.embed`）；调用方 `packages/memory/src/postgres.ts:117`（`add` 先 `await embed` 再 INSERT）
- **问题**：`embed` 内部 `fetch` 未传任何 `signal`、未设超时。云嵌入接口挂起时，`memory.add`/`memory.search` 无限等待——而 `collectPersistentContext` 每轮对话都会走记忆路径，等价于**整条对话链路挂死**（上层 `runToolWithTimeout` 只能 abort 那些消费 signal 的工具，这里的 fetch 不消费）。
- **修复建议**：`embed` 内部 `AbortSignal.timeout(10_000)`（并支持外部传入 signal 组合），失败即走 `createResilientEmbedder` 的 fallback 路径。

#### P1-10　`createResilientEmbedder` 零填充降级会污染向量库，静默破坏检索质量

- **位置**：`packages/memory/src/memory.ts:128-142`（`createResilientEmbedder`）
- **问题**：云嵌入失败时用本地 384 维 bigram 向量，**零填充到 1024 维后照常写库**：

  ```ts
  if (vector.length > dimensions) return vector.slice(0, dimensions);
  return [...vector, ...new Array<number>(dimensions - vector.length).fill(0)];
  ```

  这些"假 1024 维"向量与真云向量处在同一个 pgvector 列里，语义空间完全不同。余弦相似度会给出无意义的排名，而且**不可见**——记忆看起来存进去了，检索时却永远召回不出来（或错误地压过真相关项）。写坏的数据只能靠维度迁移重嵌入修复。
- **修复建议**：记录每条记忆的嵌入来源（`embedder` 列，如 `dashscope-v3` / `local-bigram`），检索时按来源过滤或分别检索后融合（项目已有 RRF 融合基础设施）；或者降级时**不写 embedding**（置 NULL），仅靠关键词/全文检索兜底，并在嵌入器恢复后由后台任务回填。

#### P1-11　提醒全部存在内存里，重启/部署即丢

- **位置**：`services/agent-server/src/services/reminder-service.ts:9-22`（`ReminderServiceDeps.reminders: InMemoryReminderStore`）、`packages/tools/src/reminders.ts:21-49`（`InMemoryReminderStore`）、`services/agent-server/src/index.ts:380`
- **问题**：`reminder.create`（L1，微信可直接用）写进 `InMemoryReminderStore` 的数组，**没有任何持久化**。`self.apply` / `system.restart` / 部署 / 容器重启后所有未到期提醒消失，用户不会收到任何"提醒丢了"的通知。项目其它状态（会话、任务、画像、时间线、小黑任务）都已上 Postgres，唯独提醒还是内存态——这与"提醒"这个功能的语义直接冲突（主人交代的事情说没了就没了）。
- **附带**：`ReminderService.#emit` 吞掉监听器异常（与 `task-service.ts:218` 一致，可接受但应至少记日志）。
- **修复建议**：新增 `PostgresReminderStore`（表 `reminders(id, text, due_at, done, created_at)`），与 `PostgresTaskStore` 同风格；`ReminderService` 轮询改为查 `due_at <= now() AND NOT done`，派发成功后原子置 `done`（`UPDATE ... WHERE id = $1 AND NOT done RETURNING id`，天然防重复派发）。

#### P1-12　`engineer.delegate` 的"进程重启，任务中断"通知会丢：`loadPersisted()` 早于事件订阅

- **位置**：`services/agent-server/src/index.ts:338`（`await engineerTaskRunner.loadPersisted()`）与 `:416`（`subscribeEngineerEvents` 在 `buildApp`/`registerEventRoutes` 里才注册）；`services/agent-server/src/services/engineer-task-runner.ts:153-157`（补发 done 事件）
- **问题**：`loadPersisted()` 在启动早期就把残留 `running` 记录改成 `failed` 并 `#emit({ type:'done', ... })`，但此时 `#listeners` 还是空集（SSE 路由的订阅要等 `registerEventRoutes` 执行、且 weixin-bridge 的 event-pusher 要等 HTTP 端口起来后才连上）。事件被发进虚空，SSE 缓冲也还不存在（缓冲在 `registerEventRoutes` 内创建），**重放救不回来**。结果：主人派的小黑任务因重启中断，永远收不到"任务中断"通知，只能主动 `engineer.status` 才发现。
- **修复建议**：把 `loadPersisted()` 移到 `registerEventRoutes` 之后（或 `app.listen` 之后）；更稳妥的做法是让 `loadPersisted` 不直接 emit，而是返回中断任务列表，由 `index.ts` 在事件通道就绪后再补发（并让这些补发事件进 SSE 缓冲，使晚连接的 event-pusher 能靠 `Last-Event-ID` 拉到）。

#### P1-13　`coding.run` / `engineer.delegate` 的 dsh 子进程只 kill 直接子进程，孙进程成孤儿

- **位置**：`services/agent-server/src/services/coding-tool.ts:71-118`（`runChild`）
- **问题**：`spawn` 未设 `detached`，超时后 `child.kill('SIGTERM')` + 5s 后 `child.kill('SIGKILL')` 只作用于 dsh 本身。dsh 作为编码代理会派生大量孙进程（npm、tsc、vitest、git…），这些进程**不在 kill 范围内**，dsh 死后继续跑，占 CPU/内存/文件锁（最典型的是留下的 `vitest --watch` 或 `pnpm build`）。`server-shell.ts` 已经用进程组 kill-tree 做对了这件事，`coding-tool.ts` 没有跟上。
- **附带**：`runChild` 完全不消费 `context.signal`——用户取消/上层超时都无法停掉一个 60 分钟上限的 dsh 任务。
- **修复建议**：`spawn(..., { detached: true })` + `process.kill(-child.pid, 'SIGTERM')` / `SIGKILL`（Linux 生产路径；Windows 下退回 `taskkill /T /F`）；并把 `context.signal`（`engineer-task-runner` 侧则是任务自己的 controller）接进来，abort 时走同一 kill 路径。

#### P1-14　定时任务调度器队头阻塞：一个慢任务拖垮同 tick 内所有后续任务

- **位置**：`services/agent-server/src/services/task-service.ts:110-128`（`checkNow`）、`:130-147`（`#runTask`）
- **问题**：`for (const task of tasks) { if (due) await this.#runTask(task); }` 是**串行 await**，且 `#ticking` 保证同一时刻只有一个 tick。一个跑 10 分钟的任务（`server.shell` 长命令、`coding.run`）会让同 tick 内其它到期任务全部推迟，`#ticking` 也一直为真，后续 tick 直接跳过。此外 `#runTask` 里 `await this.#sessions.getSession(...)` 抛出的**非 `SessionNotFoundError` 异常会向上冒到 `checkNow` 的 catch**，直接终止整个 tick——后面的任务这一轮全不跑（临时性数据库抖动就足以造成"当天定时任务集体不执行"，且只有一行 console.error）。
- **修复建议**：`#runTask` 用 `Promise.allSettled` 并发（可加有界并发，如 3），或至少把每个任务包在自己的 try/catch 里，保证单任务失败/超时不影响其它任务；给单任务加整体超时（借 `runChat` 的 signal）；`#ticking` 改为按任务 id 记录在跑集合，而非全局布尔。

#### P1-15　`weixin-bridge` 提前分段发送与最终补发的前缀比对不一致，可能重复或截断

- **位置**：`services/weixin-bridge/src/relay.ts:264-272`（`preflushed += seg.send`）、`:603`（`reply.text.slice(reply.preflushed?.length ?? 0)`）
- **问题**：`seg.send` 是 `pending.slice(...).trim()` 的结果（`takeEarlySegment` 每个分支都 `.trim()`），而 `preflushed` 只是把这些 **trim 过的片段拼起来**；最终补发却用 `reply.text.slice(preflushed.length)` 对**未 trim 的原始 text** 做长度切割。只要片段边界被 trim 掉了空白/换行（段落分支必然 trim 掉 `\n\n` 之前的尾部空白，空格兜底分支还额外 `trimStart`），`preflushed.length` 就**短于**实际已发送的原始长度，`remaining` 于是把已发过的尾部内容再发一遍；反之若 `keep` 侧被 trim，也可能多切掉字符导致补发内容缺头。表现为微信里偶发重复片段或掉字。
- **修复建议**：不要用长度做偏移。改为记录已消费的原始下标（`consumedIndex`，每次分段时 `consumedIndex += seg.send原始长度 + 被丢弃的空白长度`），或更简单：让 `takeEarlySegment` 返回 `{ sendRaw, sendDisplay, keep }`，`preflushed` 累加 `sendRaw`，发送用 `sendDisplay`。

#### P1-16　微信文字审批窗口与服务端审批超时错配（70s vs 60s）

- **位置**：`services/weixin-bridge/src/relay.ts:282-299`（`setTimeout(..., 70_000)`）、`services/agent-server/src/services/approval.ts:67`（`this.#timeoutMs = options.timeoutMs ?? 60_000`）
- **问题**：服务端 60 秒后已把 pending 审批判为超时并拒绝，bridge 侧还保留 10 秒的可回复窗口。用户在第 61~70 秒回复"允许"，bridge 会照常 `POST /permission {approved:true}`，服务端返回"请求不存在/已超时"，而用户侧只看到之前的授权提示，**没有任何"已超时，请重新发指令"的反馈**——体感是"我明明允许了，它没反应"。
- **修复建议**：bridge 窗口设为略**小于**服务端（如 55s），超时时主动给用户发一条"授权已超时，请重新发送指令"；或让 `permission.request` 事件携带服务端 `expiresAt`，bridge 按它计时。

#### P1-17　`failure-classifier` 把真实缺陷误判为"可恢复"，自愈规则永远沉淀不下来

- **位置**：`services/agent-server/src/services/failure-classifier.ts:10-32`（`RECOVERABLE_PATTERNS`）、`:35-46`（`DEFECT_PATTERNS`）、`:48-53`（`classifyToolFailure`）
- **问题**：`classifyToolFailure` 先判可恢复、后判缺陷：

  ```ts
  if (RECOVERABLE_PATTERNS.some((p) => p.test(e))) return 'recoverable';
  if (DEFECT_PATTERNS.some((p) => p.test(e))) return 'defect';
  ```

  而 `RECOVERABLE_PATTERNS` 里含 `/稍后/i`、`/重试/i`、`/暂时/i`、`/取消/i`、`/no such file/i`、`/占用/i` 这类极宽泛的词。中文错误消息里"请稍后重试"几乎是万能后缀——包括真正由参数错误引起的失败。举例：工具返回 `参数 path 非法，请稍后重试`，同时命中 `/稍后/`（可恢复）与 `/非法/`、`/参数/`（缺陷），因为可恢复先判，结果是 `recoverable`，`self.refine` 学不到任何规则，自愈闭环空转。`/no such file/i` 归为可恢复更值得商榷：`ENOENT` 通常正是"模型传了错路径"这一典型参数缺陷。
- **附带**：`const e = error.toLowerCase()` 之后所有正则又都带 `/i`（冗余但无害）；`DEFECT_PATTERNS` 里裸的 `/参数/i` 太宽（任何提到"参数"的说明性文字都算缺陷），只是因为排在后面才没造成误判。
- **修复建议**：（a）交换判定顺序，先判缺陷；（b）删掉靠自然语言措辞的模式（`/稍后/`、`/重试/`、`/暂时/`、`/取消/`），可恢复改用结构化信号判定（HTTP 5xx/429、`ETIMEDOUT`/`ECONNRESET`/`ECONNREFUSED`、`AbortError`）；（c）把 `/no such file/`、`/目录不存在/` 移到 `DEFECT_PATTERNS`；（d）`/参数/i` 收紧为 `/参数.*(非法|缺少|无效|错误)/`。

#### P1-18　`/health` 无鉴权且泄露"是否处于全权限模式"

- **位置**：`services/agent-server/src/routes/health.ts:18-28`；监听 `0.0.0.0`（`index.ts:427`）
- **问题**：未认证的 `/health` 返回 `uptime`、`version`、`autoApproveAll`、`voiceEnabled`、`voiceTtsEnabled`、`memory.backend`、LLM provider/model。对外网扫描者而言，`autoApproveAll: true` 是一个明确的"这台机器上的 agent 无需确认即可执行任意工具"信号，等于替攻击者做了目标筛选；`version` 还便于匹配已知缺陷。全权限模式本身是主人的选择，**把这个事实向未认证访问者广播不是**。
- **修复建议**：`/health` 只返回 `{ status: 'ok', uptime }`；详细信息移到需鉴权的 `/health/detail`（或仅 `127.0.0.1` 可访问）；`autoApproveAll` 这类安全姿态字段不对外暴露。

#### P1-19　`ilink.pollQrStatus` 吞掉所有错误伪装成"等待扫码"，登录故障永久静默

- **位置**：`services/weixin-bridge/src/ilink.ts`（`pollQrStatus` 的 catch 返回 `{ status: 'wait' }`）
- **问题**：网络错误、HTTP 500、JSON 解析失败一律映射成"继续等待扫码"。真实故障（token 失效、接口变更、DNS 挂了）表现为二维码页面无限转圈，日志里没有任何线索。
- **修复建议**：区分"接口明确说还没扫"与"调用失败"；后者累计 N 次（如 5 次）后返回 `{ status: 'error', message }` 并写日志，前端展示"登录服务异常，请重试"。

#### P1-20　`downloadMedia` / 视觉链路 / `web.fetch` 均无响应体大小上限

- **位置**：`services/weixin-bridge/src/ilink.ts`（`downloadMedia` 把整个 CDN 响应读成 Buffer）、`services/weixin-bridge/src/vision.ts`（整图 base64 成 data URL，约 1.33× 膨胀）、`services/agent-server/src/services/weixin-tools.ts:113-133`（`loadImageBytes` 的 URL 分支无超时无上限）、`packages/tools/src/web-fetch.ts`（2MB 判断在 `await response.text()` 之后）
- **问题**：四处都是"先全量读进内存，再（也许）判大小"。一个大文件/大图/大网页就能把 Node 堆打满，`web.fetch` 是 L0 全通道可用，最容易被触发。
- **修复建议**：统一用流式读取 + 累计字节数超限即 `reader.cancel()` 的读法（可抽一个 `readCapped(response, maxBytes)` 工具函数放 `packages/tools`），并给所有出网请求加显式超时。

### P2（可优化）

#### P2-21　`createBuiltinTools` 在缺省时创建两个互不相通的记忆存储

- **位置**：`packages/tools/src/index.ts:129-130`
  ```ts
  ...createMemoryTools(options.memoryStore ?? new InMemoryMemoryStore()),
  ...createGoalTools(options.memoryStore ?? new InMemoryMemoryStore()),
  ```
- **问题**：两个 `??` 各自 new 一个实例。未注入 `memoryStore` 时（测试、纯内存模式），`memory.*` 与 `goal.*` 写入**不同的存储**——`goal.add` 存的目标 `memory.list` 看不到，`collectPersistentContext` 也拿不到。生产路径注入了 Postgres store 所以不表现，但这是等着被踩的坑。
- **修复建议**：`const store = options.memoryStore ?? new InMemoryMemoryStore();` 提到上面，两处共用。

#### P2-22　语音路由的 `requestId` 按连接生成，把"仅本次允许"放大成"整个通话允许"

- **位置**：`services/agent-server/src/routes/qwen-voice.ts:54`、`routes/qwen-voice-s2s.ts:54`（`const requestId = randomUUID()` 在连接建立时执行一次）
- **问题**：`requestId` 是审批记忆的作用域键之一（`approval.ts` 的 `#requestApproved`）。语音会话里所有轮次共用同一个 `requestId`，于是用户在第 1 轮说的"允许一次"，在第 20 轮仍然生效。用户对"一次"的预期是单次工具调用，不是整通电话。
- **修复建议**：每轮对话（每次 `runChat`）生成新的 `requestId`。

#### P2-23　语音中断时的部分回复未 await 持久化，消息顺序可能错乱

- **位置**：`services/agent-server/src/routes/qwen-voice.ts:179/212`（`void deps.store.addMessage(...)`，`interrupt()` 路径不 await）
- **问题**：打断时 fire-and-forget 写入部分助手回复，若数据库稍慢，这条 assistant 消息可能**排在下一轮 user 消息之后**落库。历史顺序错乱会让后续 LLM 上下文出现"助手先答后问"的错位（工具调用配对也可能受影响）。
- **修复建议**：把打断写入串进该会话的写队列（或直接 await，打断路径本就不在热路径上）。

#### P2-24　`splitLongText` 硬切点未做 UTF-16 边界保护，长无换行文本可能切出乱码

- **位置**：`services/weixin-bridge/src/markdown.ts:32-35`（`splitLongText`）
  ```ts
  let cut = remaining.lastIndexOf('\n', maxLen);
  if (cut <= 0) cut = maxLen;
  parts.push(remaining.slice(0, cut).trim());
  ```
- **问题**：`relay.ts` 的提前分段已有 `clampToCharBoundary` 做 surrogate pair 保护，这里没有。一段没有换行的长文本（一整行 JSON、含 emoji 的长句）在 `maxLen` 处硬切，若正好落在代理对中间，微信端显示 `�`。这条路径正是**最终补发**用的（`relay.ts:607`），也就是长回复必经之路。
- **修复建议**：把 `relay.ts` 的 `clampToCharBoundary` 提到公共模块（或 `markdown.ts`），`cut` 计算后先回退到合法码点边界；顺带可复用 `findSegmentBoundary` 让硬切退化为"按句末标点切"。

#### P2-25　`weixin.delete_file` 的模糊匹配用于"永久删除"过于宽松

- **位置**：`services/agent-server/src/services/weixin-tools.ts`（`weixin.delete_file`，L1）→ bridge 侧 `files.ts:deleteLibraryFile`（精确 → 前缀 → **includes** 三级匹配）
- **问题**：删除是不可恢复操作，却用 `includes` 兜底：模型说"删掉那个报告"，`报告` 可能命中 `2026-Q1-报告-final.pdf` 之外的多个文件，实现取第一个匹配。`AGENTS.md` 要求破坏性操作在 description 里标注"永久/不可恢复"（这点做到了），但匹配语义本身应更严。
- **修复建议**：`delete` 路径只允许精确文件名（或返回候选列表让模型/用户二次确认）；`includes` 模糊匹配保留给 `send_file` 这类非破坏性操作。

#### P2-26　`state.ts` 并发 `save()` 共用同一个 `.tmp` 文件

- **位置**：`services/weixin-bridge/src/state.ts:save`
- **问题**：原子 rename 已经做对了（这也是上一份报告 P2-21 判为误报的原因），但并发两次 `save()` 会同时写 `${file}.tmp`：A 写一半、B 覆盖、A rename → 落地文件可能是两次内容交错的产物。`syncBuf` 每轮长轮询都会触发 `persist()`，并发窗口真实存在。
- **修复建议**：tmp 文件名加随机后缀（`${file}.${randomUUID()}.tmp`），或给 `save()` 加一个模块级串行队列（同 `PostgresProfileStore.#runExclusive` 的写法）。

#### P2-27　`routes/xiaohei.ts` 缓存了失败的 Promise，一次读文件失败永久 500

- **位置**：`services/agent-server/src/routes/xiaohei.ts:13-17`
  ```ts
  let cachedHtml: Promise<string> | null = null;
  ...
  cachedHtml ??= readFile(xiaoheiHtmlPath, 'utf8');
  return cachedHtml;
  ```
- **问题**：`??=` 缓存的是 **Promise 本身**。若首次读取因临时原因失败（部署中文件未就绪、EMFILE、权限瞬时问题），被 reject 的 Promise 被永久缓存，`/xiaohei` 之后每次请求都拿到同一个 rejection，直到重启才恢复。
- **修复建议**：
  ```ts
  cachedHtml ??= readFile(xiaoheiHtmlPath, 'utf8').catch((error) => {
    cachedHtml = null;   // 允许下次请求重试
    throw error;
  });
  ```

#### P2-28　`filesystem.search` 的 `walk()` 无深度上限、无超时、不响应 signal

- **位置**：`packages/tools/src/filesystem.ts`（`walk`）
- **问题**：包含性校验（`isWithin` + `path.relative`）写得正确，路径穿越没问题。但递归没有 `maxDepth`、没有节点数上限、不消费 `context.signal`——把 `allowedRoots` 指到一个大目录（生产是 `/app`，包含 `node_modules`）时，一次 L0 搜索能跑很久且无法取消，`runToolWithTimeout` 只能"报告超时"（P1-11 同源）。
- **修复建议**：加 `maxDepth`（如 8）、访问节点数上限（如 20000）、默认跳过 `node_modules`/`.git`，并在每次迭代检查 `signal.aborted`。

#### P2-29　`notification.send` 是 L2，却只写内存、没有任何投递通道

- **位置**：`packages/tools/src/sensitive.ts`（`notification.send`，`permissionLevel: 2`）
- **问题**：工具花掉一次 L2 用户确认，实际只把消息 push 进一个进程内数组，没有任何出口（微信推送走的是 `weixin.*` 与 event-pusher）。模型会以为"通知已发出"，用户以为自己批准了一次真实通知。语义与实现脱节。
- **修复建议**：要么接到真实通道（复用 event-pusher 的 SSE 事件，或直接调 `weixin.send_text`），要么降为 L0 并在 description 里写明"仅记录在本地通知列表，不主动发送"。

#### P2-30　`profile.*` 工具族忽略 `ctx.userId`，全部落到 `'default'`

- **位置**：`services/agent-server/src/services/profile-tools.ts`（每个工具都 `resolveProfileUserId()` 空参调用）
- **问题**：当前单用户场景下正确，但 `resolveProfileUserId(userId?)` 的签名暗示支持多用户，而调用点全都不传参。将来接入第二个用户时，所有画像会静默混在同一个 `default` 里。
- **修复建议**：把 `ctx.userId`（或会话 metadata 里的 `weixinPeer`）传进去；暂不支持多用户时，在 `profile-tools.ts` 顶部加一行注释说明"单用户设计，userId 恒为 default"，避免后来者误以为已支持。

#### P2-31　`ApprovalRegistry.#approved` 与 `EngineerTaskRunner.#tasks` 仍无上限（P1-13 的具体化）

- **位置**：`services/agent-server/src/services/approval.ts:60/149-158`、`services/agent-server/src/services/engineer-task-runner.ts:110/329`
- **问题**：`#approved` 只在显式 `clearSession` 时清理，会话从不删除的场景下指纹集合只增不减；`#tasks` 内存表全量保留，`#persist` 只写末 50 条（重启后内存表反而变小，说明内存态本可以同样裁剪）。
- **修复建议**：`#approved` 加 LRU（如 200 会话）；`#tasks` 保留最近 200 条（`list()` 已只取 limit 条，裁剪无副作用）。

#### P2-32　`clear()` 语义在 profile 的两种实现间不一致

- **位置**：`packages/memory/src/profile.ts:245-248`（`InMemoryProfileStore.clear` 同时清 `#profiles` 与 `#events`）vs `:518-520`（`PostgresProfileStore.clear` 只删 `user_profiles`）
- **问题**：Postgres 版清空画像后，`profile_events` 里的历史仍在，`listHistory`/`rollbackEntry` 会基于"已被清空的画像"的旧历史做回滚，恢复出用户以为已经删掉的条目。两个实现同一接口不同语义，测试用内存版就发现不了。
- **修复建议**：Postgres 版 `clear` 同时 `DELETE FROM profile_events WHERE user_id = $1`（或明确改名为 `clearEntries` 并在接口注释里写明保留历史）。

#### P2-33　`PostgresProfileStore.rollbackEntry` 与 `clear` 在串行锁之外

- **位置**：`packages/memory/src/profile.ts:497-516`、`:518-520`
- **问题**：`#runExclusive` 只包了三个写方法。`rollbackEntry` 先在锁外 `listHistory` 再调加锁的 `upsertEntry`（TOCTOU），`clear` 完全不加锁（可能与正在进行的 `upsertEntry` 交错，导致"清空后又冒出一条"）。
- **修复建议**：把 `rollbackEntry` 整体（含读历史）和 `clear` 一起包进 `#runExclusive`；注意 `rollbackEntry` 内部调用 `upsertEntry` 会造成**重入死锁**，需要抽出不加锁的 `#upsertEntryLocked` 内部方法供两处复用。

#### P2-34　openrouter 流未以 `finish_reason === 'tool_calls'` 结束时静默丢弃已累积的工具调用

- **位置**：`packages/openrouter/src/index.ts`（`accumulateToolCalls` / `finalizeToolCalls` 的收尾判定）
- **问题**：若上游因网络截断或返回 `finish_reason: 'length'` 而结束，已累积的 tool_call delta 被直接丢弃，表现为"模型明明要调工具，却什么都没发生"，且没有日志。
- **修复建议**：流结束时只要 `toolCalls` 非空就 finalize 并产出（或至少 `console.warn` 记录被丢弃的调用名），让上层能按错误路径处理。

#### P2-35　`config` 的若干细节

- **位置**：`packages/config/src/index.ts`
- **问题**：（a）`DATABASE_URL` 用 `optionalString` 而非 URL 校验，写错格式要等到 pg 连接时才炸；（b）`dashscope.baseUrl` 硬编码，忽略环境变量，切换代理/私有网关需改代码；（c）`HOOK_SECRET`、bridge token、监听地址等安全相关配置不在 schema 里，散落在各处 `process.env` 读取，无法集中审计；（d）默认模型 id `qwen3.8-max` / `x-ai/grok-4.6` / `deepseek-v4-flash` 与 `vision.ts` 默认视觉模型是否有效**待验证**（本次审计无法联网核实）。
- **修复建议**：`DATABASE_URL` 改 URL 校验；`dashscope.baseUrl` 读 `DASHSCOPE_BASE_URL` 兜底默认值；把所有安全相关 env 收进 config schema。

#### P2-36　P2-14 的具体修法：`MemoryStore.list` 缺 limit

- **位置**：`packages/memory/src/postgres.ts:127`（`async list(kind?: MemoryKind)`）、`services/agent-server/src/services/conversation.ts:218-272`（`collectPersistentContext`）
- **问题**：接口层面就没有 `limit`，所以调用方无法"只要最近 N 条"，每轮对话全表扫描 + 全量进内存。
- **修复建议**：`list(kind?, options?: { tag?: MemoryTag; limit?: number })`，把 `WHERE tag = $1` 与 `LIMIT` 下推 SQL；`collectPersistentContext` 只取 goal/feedback 两类各最近 20 条。

---

## 四、总结

### 4.1 项目健康度

**架构与工程纪律：良好。** 工具注册 + 四级权限 + 审批流（L2 指纹记忆、L3 双确认）、LLM 流式重试与空闲超时、`FallbackLLMProvider` 首 token 前故障切换、会话级串行队列、`server.shell` 的进程组 kill-tree 与输出脱敏、SSE 重放缓冲、重启恢复（悬挂 tool_call 检测 + 幂等标记）、派单硬校验、工具预算熔断、微信断句的假句号保护与 emoji 安全切分——这些都不是脚手架水平的实现，看得出反复打磨过。分层（`packages` / `services` / `routes`）清晰，类型定义严谨（大量条件展开保证 `exactOptionalPropertyTypes` 合规），测试覆盖了关键纯函数。

**上一轮修复的质量：参差。** P0-4 的会话部分和 P1-7 修得很扎实——`messages || $2::jsonb` 和"单一订阅、单一入缓冲、广播到所有连接"都是正确的做法，且注释解释了为什么。但同一份报告里的画像部分只做了进程内串行队列（治标）、任务存储的同族问题完全没被发现，说明修复是"按报告条目对着改"而非"按问题类别扫一遍"。

**本轮暴露的三条主线：**

1. **信任边界缺口。** 全权限模式是主人的选择，但它的前提是"只有主人能下指令"。`/ws/desktop` 无鉴权 + 客户端自报权限级别（P0-1）、weixin-bridge 全端点无鉴权且绑 `0.0.0.0`（复核 P1-6）、`/health` 广播 `autoApproveAll`（P1-18）合在一起，等于把这个前提拆掉了：未认证的第三方能往主人的 agent 里注入 L0 工具，或直接驱动微信发文件。**"我自己要全权限"和"任何人都能用我的全权限"是两件事**，这是本次审计最重要的判断。
2. **超时与取消普遍只做了一半。** `withTimeout` 因 `finally` 写错而完全失效（P1-2）、`chatOnce` 没传 signal、`system.status`/`coding.run` 不消费 signal 也不 kill 进程树、DashScope 嵌入无超时——`runToolWithTimeout` 的"超时"实际只是"上层放弃等待"，底层照跑。这类问题在正常流量下看不见，在故障时集体爆发（表现为微信永久失联、孤儿进程堆积、对话挂死）。
3. **降级路径静默污染数据。** `createResilientEmbedder` 零填充写库（P1-10）、pgvector 维度迁移伪事务（P1-8）、`failure-classifier` 误分类（P1-17）、提醒纯内存（P1-11）——共同特征是**失败时不报错、继续工作、但结果已经错了**。这比直接崩溃更难发现，也更难修复（数据已经写坏）。

### 4.2 最值得先做的 3 件事

**第一：给 `/ws/desktop` 加鉴权，并在服务端强制桌面工具的权限级别（P0-1）。**
这是唯一一条"外部主体可获得工具执行能力"的路径，也是唯一的 P0。改动很小：`registerDesktopRoutes` 加一次 token 校验（`crypto.timingSafeEqual`），`DesktopToolBridge.registerTools` 里把 `permissionLevel: declaration.permissionLevel` 换成服务端决定的常量（建议 L2），顺手给注入工具加 `desktop.` 前缀并让 `#cleanup` 只注销自己注册的。半小时的工作量，堵住的是"任意主机向你的 agent 注入自动执行工具"。同一批里把 weixin-bridge 默认绑 `127.0.0.1`、`/health` 收敛输出一并做掉——三处同源，都是"信任边界"。

**第二：修 `withTimeout` 并给 `chatOnce` 真正的超时（P1-2）。**
`finally` 里提前 `clearTimeout` 是一个 4 行的 bug，但它让微信通道最重要的一道护栏形同不存在。配合 `chatOnce` 无 signal，后果是**一次 agent-server 挂起就让微信永久失联**——用户体感上这是整个系统最严重的故障模式（"小助手不理我了，只能重启"）。改动量极小、收益极大，应该在第一批就做。同一 PR 里把 `consumeSse` 的空闲超时补上。

**第三：把 P0-4 的修复补完整（P1-3 + P1-4 + 画像锁外路径）。**
上一轮只修了会话。补齐 `PostgresTaskStore.updateTask` 的 `COALESCE` 单语句写法（防止"关掉的定时任务又跑起来"）、`#compactIfNeeded` 的条件替换 + 去掉"只压一次"的限制（否则长会话的上下文控制等于没做）、以及把 `rollbackEntry`/`clear` 收进画像的串行锁。这三处都是数据正确性，且现在改比等数据写坏后再改便宜得多。其中"压缩只能执行一次"我认为是最容易被低估的一条——它不报错，只是让长会话悄悄回到全量上下文，成本和延迟都在无声上涨。

**紧随其后**：P1-10（零填充向量污染记忆库，越晚修污染越多）、P1-11（提醒重启即丢，是功能性缺失）、P1-8（维度迁移伪事务）、P1-13（dsh 孙进程孤儿）、P1-12（小黑中断通知丢失）。

---

### 4.3 数据统计

| 分类 | 数量 |
|---|---|
| 上一份报告已修复 | 2（P0-4 会话部分、P1-7） |
| 上一份报告误报 | 2（P2-21 openrouter、P2-21 state.ts 原子性） |
| 上一份报告未修复 | 14（P1-5/6/8/9/10/11/12/13、P2-14/15/16/17/19/20） |
| 按用户要求不复核 | 4（P0-1/2/3、P2-18） |
| 本次新发现 P0 | 1 |
| 本次新发现 P1 | 19 |
| 本次新发现 P2 | 16 |
| 标注"待验证" | 1（默认模型 id 有效性，需联网核实） |

---

*本报告为只读审计产出，未对任何代码进行修改。*




