# 自主循环 / 全端接入前置 / 安全加固：参考项目代码对照

> 检索日期：2026-08-20。范围：JARVIS 路线图剩余项——阶段 3（自主循环
> 深化）、阶段 2 补齐（GitHub 全流程 / 网页抓取）、阶段 6（安全加固）。
> 依据架构参考政策：只吸收架构与设计，不复制代码。
> 桌面 computer-use 升级、车机/树莓派接入已按用户决定暂缓。

## 1. 自主循环深化（阶段 3）

### OpenClaw heartbeat —— 常驻自主唤醒的范式

`src/auto-reply/heartbeat.ts`：

- 默认每 **30 分钟**唤醒一次 agent（`DEFAULT_HEARTBEAT_EVERY = "30m"`）
- 唤醒时注入 heartbeat 上下文，核心协议是**不打扰**：
  `If nothing needs attention, reply HEARTBEAT_OK.`
- 通过 `heartbeat_respond` 工具回报：`notify=false` 无事不打扰；
  `notify=true + notificationText` 只在真的需要用户注意时才推送
- 明确禁止在 heartbeat 里"编造/复述旧任务"：只处理当前 scratch 上下文

→ 我们可吸收：把"巡检"升级为真正的**常驻 heartbeat**——定期唤醒、
检查服务器/任务/待办，**没事静默，有事才 push**（现在巡检任务已是
"正常回一句话"，可进一步静默化；并扩展检查范围到更多事件源）。

### OpenClaw cron —— 定时任务的工程细节

`src/cron/`：

- `pacing.ts`：调度间隔 min/max 钳制，防抖/错峰
- `tools-allow.ts`：**定时任务可用工具白名单**（`toolsAllow: ["*"]`），
  无人值守任务只开放指定工具
- `failure-notification-text.ts`：**失败分类通知**——timeout /
  `tool_budget_exceeded` / `output_limit_exceeded` / `snapshot_limit_exceeded`
  / internal_error，按原因分类上报，而不是笼统报错
- `run-timeout-override.ts`、`session-reaper.ts`（会话清理）、
  `trigger-script.ts`（脚本触发）、`delivery-plan.ts`（投递计划 + 失败重试）

### Mastra signals / background-tasks / events

- `background-tasks/manager.ts`：后台任务管理器（创建/生命周期）
- `signals/task-signal-provider.ts`、`webhook-signal-provider.ts`：
  **事件驱动触发**——任务完成信号、Webhook 信号可以唤醒 agent
- `events/pubsub.ts`、`caching-pubsub.ts`：发布/订阅 + 缓存断点

→ 我们已有 `/api/events` SSE + weixin event-pusher + task 系统；
可吸收：**Webhook/信号源**（外部事件唤醒）、后台任务生命周期管理。

### OpenCrabs cron —— 任务隔离

`src/cron/scheduler.rs`：60 秒轮询 `cron_jobs` 表、每个任务独立会话、
每次运行后插入 **compaction marker**（下次运行从空上下文开始，
任务之间不串历史）；特例任务（`__opencrabs_rebuild__` 自更新重启）。

→ 我们 headless 任务已是独立会话，可补"任务隔离确认 + 自更新任务"。

### Prime Agent harness —— 持久状态

`prime-agent-runtime/src/rlm/harness.py`：harness 持久状态
（prompt / memory / skill / subagent，local / global 双作用域）——
目标/预算/refine 的持久化底座。我们 `self.*` 已吸收目标/预算/回滚。

## 2. GitHub 全流程（阶段 2 补齐）

**结论：8 个参考项目都没有现成的 GitHub issue/PR 工具**（Mastra 只有
内部 git backport，OpenClaw 的 github 命中都是测试/构建脚本）。
需要自研，参照我们已有的 `github.search_repos` 模式，用 GitHub REST API
（无需新依赖）扩展 3 个工具：

- `github.issues`：列/查 issue（仓库、状态、label 过滤）
- `github.create_issue` / `github.comment`：提 issue / 评论
- `github.code_search`：代码搜索（Q 语法）

权限：只读 L0；创建/评论 L1（description 标注会真实写入 GitHub）。

## 3. 网页抓取 / 搜索（阶段 2 补齐）

- OpenClaw `src/web-search/runtime.ts` + `runtime-execution.ts`：
  搜索 provider 化，凭据/作用域安全解析
- OpenClaw `src/web-fetch/runtime.ts` + `content-extractors.runtime.ts`：
  **正文内容提取器**（去导航/广告，取正文）+ provider 化 + 沙箱安全 scope

→ 我们已有 `web.search`（简单关键词）；可补 `web.fetch` 工具：
抓取 URL → 提取正文（复用 content-extractors 思路）→ 截断输出，
带 SSRF 防护（只允许 http/https、限制大小）。

## 4. 安全加固（阶段 6）

- OpenClaw `src/secrets/audit.ts` + `audit-store.ts`：**密钥访问审计**
  （谁/何时读了哪个 secret，落库可查）——我们已做输出脱敏，
  可补访问审计日志
- OpenClaw `src/security/`：channel 权限审计、readonly 解析
- OpenClaw `extensions/policy`：sandbox findings / doctor（沙箱健康检查）
- OpenDex `permissions.ts`：allow_once/always/deny/never（已吸收
  allow-once；always/never 待回退正常权限模式时补）
- OpenClaw cron `tool_budget_exceeded`：**工具预算熔断**——
  一次自主任务限制工具调用次数/成本，超限即熔断并通知。
  我们目前只有 TOOL_REPEAT_LIMIT + MAX_TOOL_TURNS，可升级为预算制

## 结论：建议吸收优先级

1. **Heartbeat 不打扰协议**：巡检任务升级为"有事才 push"的常驻自主循环
   （成本最低，直接改善"主动但不烦人"）
2. **定时任务加固**：tools-allow 白名单 + 失败分类通知（任务可靠性）
3. **GitHub 全流程自研**：3 个工具（有明确使用场景：bot 自主提 issue/PR）
4. **web.fetch 内容提取器**：让 bot 能读懂网页正文
5. **工具预算熔断**：自主任务成本/次数上限
6. **密钥访问审计**：安全可追溯
