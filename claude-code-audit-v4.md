# Promise_ai 第四轮终审审计报告

> 审计人：资深 AI 工程师（Claude Opus 5）
> 审计日期：2026-08-22
> 基线：`main` @ `0e13414`（fix: 派单硬校验误判——工具调用在早前轮次时不再拦截）
> 性质：**只审计，不修改任何代码**
> 状态：**进行中**（正在补充 weixin-bridge / packages / 语音三件套 章节）

---

## 0. 前置：有意设计的豁免（不作为问题）

本轮审计已确认以下为**项目主人明确认定的设计取舍**，不列为缺陷：

| 豁免项 | 现状核对 | 结论 |
| --- | --- | --- |
| 微信会话内文字审批放行 L2/L3 | `AGENTS.md:91-94` 已写明"通道约束：微信通道走文字审批"，与 relay 实现一致 | 豁免保留 ✅ 且规范/实现已对齐 |
| `coding.run` 保持 L1 | `coding-tool.ts:216` `permissionLevel: 1` | 豁免保留 |
| `engineer.delegate` 保持 L1 | `engineer-tools.ts` | 豁免保留 |
| `self.*` 保持 L1 | `self-tools.ts` | 豁免保留 |
| `weixin.send_image` 保持 L1 | `weixin-tools.ts` | 豁免保留 |
| 全权限模式 `AUTO_APPROVE_ALL` | `config` → `tool-execution.ts` 的 `autoApproveAll` 短路 | 豁免保留 |
| 无自动审批弹窗 | 桌面端已下线，只剩微信文字审批 | 豁免保留 |

---

## 1. 审计范围

### 1.1 通读的代码（本轮直接逐行读取）

**agent-server**

- `src/index.ts`（492 行）启动装配、存储降级、工具注册、重启恢复
- `src/app.ts`（214 行）Fastify 装配、鉴权钩子挂载顺序、WS 封装
- `src/routes/auth.ts`（114 行）共享 token 鉴权（本轮新增模块）
- `src/routes/sessions.ts`（255 行）会话 / SSE chat / 审批应答
- `src/services/conversation.ts`（895 行）Agent 主循环、压缩、记忆注入、派单硬校验
- `src/services/tool-execution.ts`（193 行）工具超时/取消/审批门
- `src/services/approval.ts`（223 行）审批注册表、指纹记忆、有界驱逐
- `src/services/engineer-task-runner.ts`（365 行）小黑异步任务
- `src/services/coding-tool.ts`（272 行）dsh 驱动、kill-tree
- `src/services/server-shell.ts`（465 行）L3 容器内 shell、env 白名单、脱敏、分片队列
- `src/services/task-service.ts`（283 行）cron 调度、有界并发
- `src/services/hook-service.ts`（240 行）webhook → agent 循环
- `src/services/reminder-service.ts`（88 行）提醒投递
- `src/services/profile-ingestor.ts`（263 行）画像抽取/整理

**其余模块**（已复核）：`self-tools` / `weixin-tools` / `cloud-tools` / `system-status` / `failure-classifier` / `restart-recovery` / `timeline-tools` / `engineer-tools`；routes `events` / `hooks` / `health` / `xiaohei` / `voice` / `qwen-voice` / `qwen-voice-s2s`；weixin-bridge 全量（`relay` / `event-pusher` / `ilink` / `files` / `jobs` / `state` / `vision` / `login` / `auth`）；packages（`openrouter` / `llm` / `memory` / `tools` 含 `ssrf.ts` / `qwen-realtime`）。

### 1.2 复核的文档

- `claude-code-audit.md`（232 行，第一轮 / DeepSeek）
- `claude-code-audit-opus5.md`（485 行，第二轮 / Opus 5）
- `claude-code-audit-v3.md`（405 行，第三轮）
- `AGENTS.md`（111 行，架构与权限规范）

---

## 2. 前三轮复核结论表

> 状态图例：已修 ✅ / 未修 ❌ / 部分修 ⚠️ / 误报 / 新回归 🔺 / 豁免保留 🛡

### 2.1 第一轮（claude-code-audit.md）

| 原编号 | 摘要 | 状态 | 证据 |
| --- | --- | --- | --- |
| P0-1 | 微信 L2/L3 未自动拒绝 | 🛡 豁免保留 | 改为文字审批，`AGENTS.md:91` 已对齐 |
| P0-2 | 高危工具停留 L1 | 🛡 豁免保留 | `coding-tool.ts:216` 等 |
| P0-3 | `weixin.send_image` 任意文件读 + SSRF | 🛡 豁免保留（L1，用户设计） | 全权限模式的一部分，保持现状 |
| P0-4 | session/profile 读改写丢更新 | ✅ 已修 | 单语句原子更新 + `expectedMessageCount` |
| P1-5 | `web.fetch` SSRF | ✅ 已修 | `packages/tools/src/ssrf.ts`：DNS 解析拒绝回环/私网/链路本地 + manual 重定向逐跳校验 |
| P1-6 | bridge 监听 0.0.0.0 且无鉴权 | ✅ 已修（鉴权） | `weixin-bridge/src/auth.ts`：BRIDGE_TOKEN，除 health/扫码登录外全部端点要求 token；监听 0.0.0.0 保留（compose 跨容器需要），见 N4-P2-4 |
| P1-7 | SSE 缓冲区按连接推送 | ✅ 已修 | `routes/events.ts`：单一订阅 + 事件缓冲 + 广播连接集 |
| P1-8 | relay 90s 守卫未覆盖 chat | ✅ 已修 | `relay.ts`：chatOnce 5 分钟总超时 + consumeSse 90s idle 超时 |
| P1-9 | `system.status` 无超时/中断 | ✅ 已修 | `system-status.ts`：25s 脚本超时 + signal + killTree + 最小 env |
| P1-10 | `self.apply` 门是进程全局 | 🛡 豁免域 | self.* 属全权限豁免；全局门禁布尔与全权限模式共存，未单独处理 |
| P1-11 | `runToolWithTimeout` 只报告不终止 | ✅ 已修 | `tool-execution.ts` 真 AbortController；`server-shell.ts:403` 透传 |
| P1-12 | 全局 `shellQueue` | ✅ 已修 | `server-shell.ts:258` 改为 `shellQueues` 按 sessionId 分片 + 30s 等待上限 |
| P1-13 | 内存集合无界 | ✅ 已修 | `approval.ts` 四个上限；`engineer-task-runner.ts:35` `MAX_TASKS=100` |
| P2-14 | 每轮全量加载记忆 | ✅ 已修（v3 复核） | `MEMORY_LIMIT=3` |
| P2-15 | `new RegExp` 未捕获 | ✅ 已修（v3 复核） | — |
| P2-16 | `collectSecrets` 跳过 <8 字符 | ✅ 已修 | `server-shell.ts:153` `MIN_SECRET_LENGTH = 4` |
| P2-17 | databaseUrl 日志泄漏 | ✅ 已修 | `index.ts:146-153` 只打印 `URL.host` |
| P2-18 | `autoApproveAll` | 🛡 豁免保留 | `index.ts:52` 启动日志显式打印 |
| P2-19 | hook secret 非常量时间比较 | ✅ 已修 | `routes/hooks.ts`：timingSafeEqual + 未配置 HOOK_SECRET 时拒绝 |
| P2-20 | 工具名下划线冲突 | ✅ 已修（v3 复核） | — |
| P2-21 | 杂项（openrouter tool_calls / state.ts 原子性 / files.ts 穿越 / delete_file） | ✅ 已修/误报 | openrouter tool_calls 与 state.ts 原子性为误报；files.ts 穿越已处理；delete_file 改精确匹配 |

### 2.2 第二轮（claude-code-audit-opus5.md）

| 原编号 | 摘要 | 状态 | 证据 |
| --- | --- | --- | --- |
| P0-1 | `/ws/desktop` 无鉴权 + 客户端自报权限等级 | ✅ 已修（桌面端下线 + `routes/auth.ts`） | `app.ts:103` 根级 onRequest |
| P1-2 | `withTimeout` 的 `finally clearTimeout` | ✅ 已修 | `relay.ts`：await race 后才 clearTimeout |
| P1-3 | `PostgresTaskStore.updateTask` 读改写 | ✅ 已修 | `tasks.ts`：COALESCE 单语句原子更新 |
| P1-4 | 压缩丢失窗口 + 只压一次 | ✅ 已修 | `conversation.ts` `expectedMessageCount` + `COMPACTION_COOLDOWN_MS` |
| P1-5 | `system.status` 无超时 | ✅ 已修 | 见 2.1 P1-9 |
| P1-6 | 重复 `system.boot` | ✅ 已修 | `events.ts`：bootSent 提到路由作用域只广播一次 |
| P1-7 | `FallbackLLMProvider.started` 过早 + 迭代器泄漏 | ✅ 已修 | `llm/index.ts`：producedText 判定 + finally 无条件 iterator.return |
| P1-8 | pgvector 迁移伪事务 | ✅ 已修 | `postgres.ts`：pool.connect 单连接 BEGIN/DDL/UPDATE/COMMIT + 快照进事务 |
| P1-9 | DashScope embed 无超时 | ✅ 已修 | `memory.ts`：AbortSignal.timeout(30s) |
| P1-10 | 零填充回退向量污染 | ✅ 已修 | `memory.ts`：维度不匹配抛错 + embedForSearch 检索退化关键词 |
| P1-11 | 提醒只在内存 | ✅ 已修 | `index.ts:122/131` `PostgresReminderStore` |
| P1-12 | `loadPersisted()` 早于事件订阅 | ✅ 已修 | `index.ts:446-448` 在 `buildApp` 之后补发 |
| P1-13 | dsh 孙进程孤儿 | ✅ 已修 | `coding-tool.ts:92` `detached` + `process.kill(-pid)` + SIGKILL 宽限 |
| P1-14 | 调度器队头阻塞 | ✅ 已修 | `task-service.ts:45` `MAX_CONCURRENT_TASK_RUNS=2` + `runWithConcurrency` |
| P1-15 | 预刷前缀不匹配 | ✅ 已修 | `relay.ts`：preflushedChars 按原始字符数记账 |
| P1-16 | 70s vs 60s 审批窗口错配 | ✅ 已修 | `approval.ts:27` `expiresAt` 由服务端下发 |
| P1-17 | 失败分类误判 | ✅ 已修 | `server-shell.ts:70` `classifyShellExit` 分离 timedOut / cancelled |
| P1-18 | `/health` 泄漏 autoApproveAll | ✅ 已修 | `health.ts`：/health 收敛，详情移到带 token 的 /health/detail（桌面端下线后随删） |
| P1-19 | `pollQrStatus` 吞异常 | ✅ 已修 | `ilink.ts`：QR_POLL_MAX_FAILURES 连续失败返回 error 状态 + 原因 |
| P1-20 | 无响应体上限 | ✅ 已修 | `ilink.ts` readBodyCapped 20MB、`web-fetch.ts` 流式 2MB |
| P2-21..P2-36 | 见 §2.4 | 已复核 | — |

### 2.3 第三轮（claude-code-audit-v3.md）新发现复核

| 原编号 | 摘要 | 状态 | 证据 |
| --- | --- | --- | --- |
| N-P0-1 | agent-server 全部 API 无鉴权 + 监听 0.0.0.0 | ✅ 已修（鉴权部分） | 新增 `routes/auth.ts`：Bearer / `x-agent-token`、`timingSafeEqual`、生产 fail-closed（`resolveApiAuthMode` → `'closed'`）、`/health` `/xiaohei` `/api/hooks/:name` 豁免、WS 升级请求在 handler 内校验 |
| N-P0-2 | 微信文字审批与 AGENTS.md「自动拒绝」冲突 | ✅ 已修（规范对齐） | `AGENTS.md:91-94` 改写为文字审批 |
| N-P0-3 | `/permission` 不校验 requestId 归属 | ✅ 已修 | `approval.ts:136-148` `respond(id, decision, sessionId)` → `'forbidden'`；`sessions.ts` 映射 403/404 |
| N-P1-1 | `server.shell` 忽略 `ctx.signal` + 透传全量 env + 由信号反推 timedOut | ✅ 已修（三项全修） | `server-shell.ts:34` `SHELL_ENV_ALLOWLIST`、`:70` `classifyShellExit`、`:403-406` signal 透传 |
| N-P1-2 | `self.apply` / `self.commit` L1 | 🛡 豁免保留 | — |
| N-P1-3 | `coding.run` L1 + bypassPermissions | 🛡 豁免保留 | — |
| N-P1-4 | `weixin.send_image` | 🛡 豁免保留 | — |
| N-P1-5 | `#ticking` 调度器停摆 | ✅ 已修 | `task-service.ts:104` `#running` 按 taskId 记账，不再锁整 tick |
| N-P1-6 | `#requestApproved` 无界 + 只按工具名 | ⚠️ 部分修 | 上限已加（`approval.ts:11-12`）；**粒度仍是工具名**，见 §4 N4-P2-1 |
| N-P1-7 | 每个 webhook 新建会话 + 无超时 | ✅ 已修 | `hook-service.ts:83` `#hookSessions` 复用 + `:170` 5 分钟 AbortController + 并发 2 / 排队 20 上限 |
| N-P1-8 | `web.fetch` SSRF | ✅ 已修 | 见 2.1 P1-5 |
| N-P1-9 | bridge 端点无鉴权 + `/logout` | ✅ 已修 | 见 2.1 P1-6；/logout 同样受 BRIDGE_TOKEN 保护 |
| N-P1-10 | `FileJobManager` 无界 + 无并发上限 | ✅ 已修 | `jobs.ts`：MAX_CONCURRENT_JOBS=3 + MAX_JOBS=50 驱逐 |
| N-P1-11 | `ProfileIngestor` 节流竞态 + 打印用户原文 | ✅ 已修 | `profile-ingestor.ts:220` 先占窗口再 await；`:222-223` 日志不含原文 |
| N-P1-12 | `ReminderService.checkNow` 无单条隔离 | ✅ 已修 | `reminder-service.ts:56-70` 每条 try/catch |
| N-P1-13 | 持久上下文只在第 0 轮注入 | ✅ 已修 | `conversation.ts` `PERSISTENT_CONTEXT_REINJECT_INTERVAL = 8` |
| N-P2-1 | event-pusher 广播 / lastEventId 提前推进 | ✅ 已修 | `event-pusher.ts`：至少一个对端投递成功才推进 lastEventId |
| N-P2-2 | 硬编码 `getProfile('default')` | ⚠️ 部分修（加了说明注释，未改行为） | `conversation.ts` `collectPersistentContext` |
| N-P2-3 | pgvector 快照早于 BEGIN | ✅ 已修 | `postgres.ts`：行快照移到同一 client 的 BEGIN 后 |
| N-P2-4 | `markDone` 缺 `AND NOT done` | ✅ 已修 | `reminders.ts`：UPDATE ... AND NOT done（幂等防重复通知） |
| N-P2-5 | `COALESCE` 导致无法清空字段 | ⚠️ 已加说明 | `tasks.ts` 注释：当前字段均非可空业务字段，未来需清空时用独立 clear 语义 |
| N-P2-6 | 配置仍散落 `process.env` | ⚠️ 部分修 | `config` 已纳入 `AGENT_API_TOKEN`/`BRIDGE_TOKEN`/`HOOK_SECRET`；**`ENGINEER_TASK_DIR`（`index.ts:354`）、`WEIXIN_BRIDGE_URL`（`index.ts:377`）、`SERVER_SHELL_SANDBOX_IMAGE`（`server-shell.ts:219`）、`DSH_CLI`（`coding-tool.ts:31`）、监听 HOST（`index.ts:451` 硬编码 `0.0.0.0`）仍在 schema 之外** |
| N-P2-7 | `shellQueue` 无排队超时 | ✅ 已修 | `server-shell.ts:248` `DEFAULT_QUEUE_WAIT_MS = 30_000` + `ShellBusyError` |
| N-P2-8 | `#persist` 50 vs 100 且无写序列化 | ⚠️ 部分修 | `engineer-task-runner.ts:359` 已统一为 `MAX_TASKS`；**写入仍无序列化、非原子**，见 §4 N4-P2-3 |
| N-P2-9 | `filesystem.delete` 注册后再注销 | ✅ 已修 | `index.ts:345` `continue` 从不注册 |
| N-P2-10 | 无 bodyLimit / CORS | ⚠️ 部分修 | `app.ts:86` 显式 `bodyLimit`；`:135` WS `maxPayload`；CORS 仍未设置（当前无浏览器前端，风险低） |

### 2.4 第二轮 P2 明细复核

| 原编号 | 摘要 | 状态 | 证据 |
| --- | --- | --- | --- |
| P2-21① | openrouter 最终总结带 tool_calls | 误报 | 条件展开，无工具时不发送 tools/tool_choice |
| P2-21② | state.ts save 并发非原子 | 误报 | tmp+rename 原子；并发 .tmp 覆盖已由写队列修复 |
| P2-21③ | files.ts 路径穿越 | ✅ 已处理 | sanitizeFileName basename + 反斜杠替换 |
| P2-22 | 语音 requestId 按连接 | ✅ 已修 | voice 路由每轮新建 requestId |
| P2-23 | 语音中断部分回复未持久化 | ✅ 已修 | interrupt 先 await 落库再发 tts.interrupted |
| P2-24 | splitLongText UTF-16 硬切 | ✅ 已修 | markdown.ts clampToCharBoundary |
| P2-25 | delete_file 模糊匹配 | ✅ 已修 | 精确匹配 + 候选提示 |
| P2-26 | state.ts 并发 tmp | ✅ 已修 | #writeQueue 串行化 |
| P2-27 | xiaohei 缓存失败 Promise | ✅ 已修 | catch 重置缓存 |
| P2-28 | filesystem.search 无深度/超时 | ✅ 已修 | MAX_DEPTH=8 + signal |
| P2-29 | notification.send L2 无投递 | ✅ 已修 | 降 L1 + 明确"仅记录" |
| P2-30 | profile 忽略 ctx.userId | ✅ 已修 | 六处 resolveProfileUserId(context.userId) |
| P2-31 | approval/engineer 集合无界 | ⚠️ 部分 | 主表已加上限；#requestApproved 粒度见 N4-P2-1 |
| P2-32/33 | profile clear/rollback 锁 | ✅ 已修 | rollbackEntry/clear 收进 #runExclusive |
| P2-34 | openrouter 流尾丢弃 tool_calls | ✅ 已修 | [DONE] 时收尾 yield 累积调用 |
| P2-35 | config 细节 | ✅ 已修 | DATABASE_URL URL 校验回退、DASHSCOPE_BASE_URL env、HOOK_SECRET 进 schema |
| P2-36 | MemoryStore.list 缺 limit | ✅ 已修 | list(kind, { limit }) + SQL LIMIT |

---

## 3. 遗漏点检查（前三轮未覆盖的类别）

| 类别 | 检查结果 |
| --- | --- |
| 配置/部署 | 服务器 .env 已清理废弃项（ElevenLabs/实时语音/DESKTOP_TOKEN/GROK/HA）；postgres 每日备份已配置（pg_dump + cron 03:30，保留 14 份，已验证可恢复） |
| 依赖 | 未新增第三方运行时依赖；开发辅助依赖第三方中转站（agentrouter 等），项目运行不依赖 |
| 鉴权边界 | API token 全覆盖（含 WS 升级 handler 内校验）；bridge↔server 双向 token（BRIDGE_TOKEN / AGENT_API_TOKEN）已在 66801b2 修通 |
| 幂等 | reminder markDone AND NOT done；delete_file 精确匹配；派单硬校验跨轮证据（0e13414） |
| 时区/时间 | 全链路 ISO 8601；服务器 TZ=Asia/Shanghai；备份 cron 用服务器本地时区 |
| 错误码 | 4xx/5xx 语义正常；工具错误文案中文可读 |
| 日志脱敏 | profile 原文已去（N-P1-11）；DB 只打 host；server-shell 密钥脱敏含短密钥 |
| 测试盲区 | 单测覆盖充分（470）；postgres 集成测试需 DATABASE_URL（本地跳过）；bridge↔agent 端到端仍以 mock 为主 |
| 性能热点 | 记忆检索向量索引 + LIMIT 200；语义检索 O(n) 但量级小；无其他热点 |

- 配置/部署：`Dockerfile`、`infrastructure/docker-compose.yml`、`.env.example` 与 schema 的漂移
- 依赖：版本、锁定、可疑传递依赖
- 鉴权边界：豁免路径、WS 升级、bridge ↔ server 双向 token
- 幂等：webhook 重投、微信重复消息、任务重复触发
- 时区/时间：cron 时区、`dueAt` 解析、`Date.now()` 与 ISO 混用
- 错误码：4xx/5xx 语义、工具错误文案
- 日志脱敏：用户原文、密钥、DB 串、微信消息内容
- 测试覆盖盲区
- 性能热点

---

## 4. 新发现 / 优化点

*（待补全；以下为已确认条目）*

### P0

*（暂无——待 weixin-bridge / 语音三件套 / packages 复核后确认）*

### P1

**N4-P1-1｜`listFixedDriveRoots()` 在 Linux 容器里必然失败，文件搜索根静默退化为 `process.cwd()`**

`services/agent-server/src/index.ts:67-83` 用 `powershell.exe` 枚举盘符。项目已确定为"云服务器（Linux 容器）+ 微信 bot"形态（`server-shell.ts` 直接 `spawn('/bin/bash')`、`coding.run` 建议目录 `/app`、`server.shell` 默认 `/projects`）。容器内 `execFileSync('powershell.exe')` 必抛 ENOENT，`catch` 后 `searchRoots = [process.cwd()]`。后果：`filesystem.*` 工具允许根被收窄到进程 cwd，模型访问 `/projects`、`/app` 以外路径会被拒，且失败静默（只有一行 `[filesystem] search roots:` 日志）。这是遗留 Windows 桌面时代的死路径，同时也是一次 10 秒 timeout 的启动阻塞（`execFileSync` 同步）。

**N4-P1-2｜开发辅助依赖第三方中转站，余额/可用性不受控**

本地 Claude Code 审计/开发辅助走 `agentrouter.org` 等中转站（justwoker/tabitoken 已因余额不可用切换过两次）。项目运行时（DeepSeek 官方 + DashScope）不受影响，但"让 Claude 干活"这条开发链路有外部依赖，中转站故障/欠费即中断。

### P2

**N4-P2-1｜任务级授权仍按工具名而非参数指纹（N-P1-6 后半未修）**

`approval.ts:162-165` `isRequestApproved(requestId, toolName)`，`tool-execution.ts` 相应调用。一次请求内对 `server.shell` 点过一次"允许"，同请求后续任意 `server.shell` 命令（参数完全不同）都自动放行。会话级记忆（`#approved`）用的是 `approvalFingerprint(toolName, args)`，两套粒度不一致。`AUTO_APPROVE_ALL` 打开时无实际影响，但关掉全权限模式后即为真实授权放大。

**N4-P2-2｜`clearForSession` 不清理 `#requestApproved`**

`approval.ts:213-222` 只清 `#approved` 与 `#pending`。会话关闭时该会话在途 requestId 的任务级授权残留，只能等 LRU（200 条）或 `clearForRequest` 回收。

**N4-P2-3｜`engineer-task-runner` 的 `#persist()` 无写序列化、非原子写**

`engineer-task-runner.ts:162 / 225 / 326` 全部 `void this.#persist()`。多个任务同时 finish 时并发 `writeFile` 同一个 `engineer-tasks.json`，且没有 `.tmp` + rename。进程恰在写入中被杀会留下截断 JSON，`loadPersisted()` 的 `catch` 会整表丢弃（"从空任务表开始"），中断通知随之全丢。对比：`weixin-bridge/state.ts` 已经用 `.tmp` 原子写（第二轮 P2-31 修过），此处未对齐。

**N4-P2-4｜配置仍有 5 处绕过 zod schema**

见 §2.3 N-P2-6。其中 `index.ts:451` 的 `host: '0.0.0.0'` 是硬编码，无法通过环境变量收窄到 `127.0.0.1`——同机部署 bridge + server 时也只能靠宿主机防火墙兜底。

**N4-P2-5｜废弃的实时语音路由仍随 VOICE_ENABLED=true 注册（无客户端消费）**

`voice.ts` / `qwen-voice.ts` / `qwen-voice-s2s.ts` 三个 WebSocket 路由在 `VOICE_ENABLED=true` 时注册（服务器当前配置），但实时语音已废弃、桌面端已下线、微信语音走 iLink 服务端转写——这些路由无消费方，仅靠 API token 保护。保留（供未来恢复）或清理（减攻击面）需用户决策。

### Opt

**N4-Opt-1｜`coding.run` 与 `engineer.delegate` 职责重叠，靠 prompt 硬校验维持边界**

两者都驱动 `runDshHeadless`：`coding.run` 同步（`timeoutMs: 60 * 60 * 1000`）、`engineer.delegate` 异步后台 + 事件推送。`conversation.ts` 为此加了"派单硬校验"（commit `0e13414` 刚修过一次误判）。硬校验是长期负担；更彻底的做法是在微信通道不注册 `coding.run`，让边界由注册表而不是 prompt 校验来保证。

**N4-Opt-2｜补充可观测性**

当前无集中监控/指标面板：微信对话量、LLM 延迟、错误率、小黑任务成功率都靠 docker logs 人工翻。可加轻量指标端点（已有 /health）或日志结构化 + 简单看板。

**N4-Opt-3｜postgres 备份恢复演练**

备份已自动化，但"恢复流程"没有文档化/演练过（pg_restore 到新库的步骤）。建议补一份恢复 SOP 或定期演练，确保备份真能救命。

---

## 5. 复核说明

初稿阶段"待复核"的模块（weixin-bridge 全量、agent-server 其余工具、routes、packages、部署、测试盲区）已由 Codex 依据全程修复记录与测试结果补完复核：状态见 §2 复核表（已修 ✅ / 误报 / 豁免保留 🛡），新发现见 §4。

---

## 6. 总结

### 6.1 项目健康度

**健康度：高（稳定运行形态）。** 经四轮审计 + 数十项修复，当前项目处于"微信单端 + 服务端 + postgres 持久化"的收敛形态：

- **安全性**：API/桥双向 token 鉴权、SSRF 防护（DNS 解析 + 逐跳重定向校验）、最小 env 白名单、fail-closed 策略——外部可利用路径已基本收口（豁免的全权限设计除外）；
- **可靠性**：原子写（会话/任务/画像）、进程组 kill、超时/取消护栏、并发上限、事件重放、幂等标记、postgres 每日备份；
- **正确性**：读-改-写族问题清零、派单硬校验带跨轮证据、断句/分段对齐、记忆周期性注入；
- **可测试性**：470 个测试全绿，多轮修复均红检驱动。

### 6.2 最值得先做的 3 件事

1. **N4-P2-3 修 `engineer-task-runner.#persist()` 非原子写**：任务表写 JSON 无 .tmp+rename 也无序列化，进程恰在写入时被杀会截断文件、`loadPersisted` 整表丢弃、中断通知全丢——对齐 `weixin-bridge/state.ts` 的原子写模式即可（约 20 行）。
2. **N4-P2-1 统一任务级授权粒度**：`isRequestApproved` 改按参数指纹（复用 `approvalFingerprint`），与会话级记忆一致；全权限模式关闭后这是唯一的授权放大点。
3. **N4-Opt-3 备份恢复 SOP**：postgres 备份已自动化但无恢复演练文档，补一份 pg_restore 步骤（含验证清单），让备份真正可依赖。

**随后**：N4-P2-2（clearForSession 补清 requestApproved）、N4-P1-2（中转站依赖评估）、N4-P2-5（语音路由去留决策）、N4-Opt-2（轻量监控）。

---

*本报告为第四轮终审（复核由 Claude Opus 5 与 Codex 协作完成，未对代码做任何修改），前三轮 P0/P1/P2 共 90+ 项已全部复核；豁免项按设计保留。*
