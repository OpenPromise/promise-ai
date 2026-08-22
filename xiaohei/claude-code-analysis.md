# Claude Code（anthropics/claude-code）调研分析

> 调研人：小黑（dsh 底盘工程师子代理）
> 调研日期：2026-08-23
> 调研方式：GitHub REST API（`/repos/anthropics/claude-code`、contents API）+ raw 文件抓取，无浏览器；star 数/语言等以抓取当日 GitHub API 返回为准。
> 依据：本仓库《架构参考政策》——只吸收架构与设计思想，不复制代码（本项目为专有许可证，本就不可复制）。

---

## 一、调研概览

### 1. 仓库元数据（2026-08-23 GitHub API）

| 项 | 值 |
|---|---|
| 仓库 | [anthropics/claude-code](https://github.com/anthropics/claude-code) |
| Stars | 142,474 |
| Forks | 22,834 |
| Subscribers | 872 |
| 创建时间 | 2025-02-22 |
| 最近推送 | 2026-08-22 |
| API 语言 | Python（仓库内含 Python 实现的 hooks，如 security-guidance 的 `security_reminder_hook.py`） |
| 许可证 | **专有（非开源）**：LICENSE.md 为 "© Anthropic PBC. All rights reserved. Use is subject to Anthropic's Commercial Terms of Service"；API license 字段为 null |
| 主页 | https://code.claude.com/docs/en/overview |
| 描述 | "Claude Code is an agentic coding tool that lives in your terminal, understands your codebase, and helps you code faster by executing routine tasks, explaining complex code, and handling git workflows - all through natural language commands." |

### 2. 仓库性质澄清（重要）

Claude Code **产品本体是闭源的**（npm 包 `@anthropic-ai/claude-code`，代码混淆分发，本仓库不含产品源码）。本仓库实际内容是：

- **README.md**（72 行）：安装方式（curl / brew / winget，npm 安装已标记 deprecated）、插件目录入口、`/bug` 上报、Discord、数据收集与隐私策略——核心文档全部指向外部官方文档站（code.claude.com/docs，本沙箱网络不可达，未抓取到正文）。
- **plugins/**：13 个官方插件（命令/agents/skills/hooks/MCP 的完整范例，是本次最有价值的调研对象）。
- **.claude/commands/**：3 个自用 slash 命令（commit-push-pr / dedupe / triage-issue）。
- **.claude-plugin/marketplace.json**：插件市场清单。
- **examples/**：settings 权限预设（strict / bash-sandbox / lax）、hooks、gateway、mdm 示例。
- **scripts/** + **.github/workflows/**：GitHub issue 自动化运维脚本与 12 个 CI 工作流（多为 issue 生命周期自动化：triage / dedupe / auto-close / sweep）。
- **CHANGELOG.md**（5,759 行）：产品功能演进记录（v2.1.x 最新），是"产品形态与能力"的可靠旁证。

> 结论：调研价值集中在 **plugins 生态范式（命令/agents/skills/hooks 四件套）+ 权限/sandbox 配置模型 + 多 agent 工作流设计**，这些全部有仓库内一手文件可实证。

---

## 二、核心定位与产品形态

- **定位**：终端里的 agentic 编码工具——"understands your codebase, executes routine tasks, explains complex code, handles git workflows"。可在终端、IDE（VS Code/JetBrains 插件）、或 GitHub 上 @claude 使用（README + CHANGELOG 旁证）。
- **多形态**：CLI / IDE 插件 / 网页与桌面（cloud sessions）/ 远程会话 / Agent SDK（CHANGELOG 提及 `ListAgents`/`SendMessage` 多 agent 互通与 `claude-code` 进程间消息）。
- **产品形态核心**：以"slash 命令 + 插件市场"为扩展主入口，官方文档把能力拆成 **Commands / Agents / Skills / Hooks / MCP** 五类扩展载体——这是本仓库最值得吸收的"产品分层"。

---

## 三、核心功能与工作机制（仓库一手证据）

### 1. 插件系统（plugins）——扩展分层范式

标准插件结构（plugins/README.md 明示）：

```
plugin-name/
├── .claude-plugin/plugin.json   # 插件元数据（name/description/version/author）
├── commands/                    # slash 命令（可选）
├── agents/                      # 专业子代理（可选）
├── skills/                      # Agent Skills（可选）
├── hooks/                       # 事件处理器（可选）
├── .mcp.json                    # 外部工具配置（可选）
└── README.md
```

marketplace.json 声明插件（name/description/source/category/author/version），支持市场分发与团队共享。

### 2. 命令系统（slash commands）——权限收敛的可复用工作流

`.claude/commands/*.md` 与插件 commands/ 用 **YAML frontmatter + Markdown 正文** 定义命令，关键字段：

- `description` / `argument-hint`：命令说明与参数提示；
- **`allowed-tools`：命令级工具白名单**（如 `Bash(gh issue view:*)`、`Bash(./scripts/gh.sh:*)`、`mcp__github_inline_comment__create_inline_comment`）——命令只能使用白名单内的工具，把工作流约束在最小工具面；
- `hide-from-slash-command-tool`：隐藏命令；
- 正文支持 **`!` shell 命令插值**（如 `!git status`、`!git diff HEAD`）注入实时上下文，然后给模型精确的任务步骤。

实证（commit-push-pr.md）：allowed-tools 只放行 git checkout/add/status/push/commit/gh pr create，任务明确"单条消息内完成建分支→提交→推送→建 PR，不用其他工具、不发其他文本"——**权限收敛 + 单回合完成**的设计。

实证（triage-issue.md / dedupe.md）：用 wrapper 脚本（`./scripts/gh.sh`）而非裸 `gh` 进一步收窄工具面；给模型明确的判定规则（如 needs-repro/needs-info 标签的 7 天生命周期、重复 issue 只标记未关闭的）；**dedupe 也用"并行搜索 → 过滤假阳性"两段式**。

### 3. Agents（子代理）——类型化 + 工具白名单 + 模型分层

`agents/*.md` 用 YAML frontmatter 声明：

- `name` / `description`：驱动模型按需拉起；
- **`tools`：工具白名单**（如 code-explorer 只给 Glob/Grep/LS/Read/WebFetch/TodoWrite/WebSearch 等只读工具）；
- `model`：模型分层（code-review 用 haiku 做预检查、sonnet 做 CLAUDE.md 合规与总结、opus 做 bug 检测）；
- `color`：终端展示用。

feature-dev 插件提供 3 个专业子代理：`code-explorer`（只读深度分析代码库，返回 5-10 个关键文件清单）、`code-architect`（架构设计）、`code-reviewer`（质量评审）——**子代理负责"读"与"评"，主代理负责"读文件建上下文 + 决策 + 写"**。

### 4. Hooks——事件驱动的质量/安全拦截（hooks.json 实证）

security-guidance 插件的 hooks.json 展示了完整 hook 事件面：

- **事件**：`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`；
- **matcher**：按工具匹配（`Edit|Write|MultiEdit|NotebookEdit`、`Bash`）；
- **if 条件**：按命令模式匹配（`Bash(git commit:*)`、`Bash(git push:*)`）；
- **`asyncRewake` + `rewakeMessage` + `rewakeSummary`**：后台异步评审（如 git diff 的 LLM 安全审查）完成后**重新唤醒 agent** 处理发现——不阻塞主流程，但保证问题不被丢；
- 超时配置、命令式 hook（bash/python 脚本）均可。

hookify 插件把 hooks 门槛降到"零代码"：**markdown 文件 + YAML frontmatter（name/enabled/event/pattern/action: warn|block）** 定义行为规则，正则匹配 + 警告/阻断，无需重启即时生效；还能用 conversation-analyzer agent 从对话中自动提取用户纠正过的行为生成规则。

### 5. 权限与沙箱（examples/settings 实证）

settings.json 权限模型（settings-strict.json）：

```json
{
  "permissions": {
    "disableBypassPermissionsMode": "disable",
    "ask": ["Bash"],
    "deny": ["WebSearch", "WebFetch"]
  },
  "allowManagedPermissionRulesOnly": true,
  "allowManagedHooksOnly": true,
  "strictKnownMarketplaces": [],
  "sandbox": {
    "autoAllowBashIfSandboxed": false,
    "excludedCommands": [],
    "network": { "allowUnixSockets": [], "allowAllUnixSockets": false, "allowLocalBinding": false, "allowedDomains": [], "httpProxyPort": null, "socksProxyPort": null },
    "enableWeakerNestedSandbox": false
  }
}
```

- 权限动作：`allow` / `ask` / `deny` + `disableBypassPermissionsMode`（禁止用户绕过审批模式）；
- 规则模式：`Bash(git commit:*)` 工具+参数模式匹配（可精确到"允许 commit 但不允许 push"）；
- **sandbox 网络白名单**（allowedDomains / unix socket / 本地绑定 / 代理端口）；
- **allowManagedPermissionRulesOnly / allowManagedHooksOnly**：只允许"托管"规则/hook——防插件市场供应链注入的开关（安全纵深）；
- 三档预设：strict（默认 ask+deny、禁 bypass）/ bash-sandbox（Bash 强制沙箱）/ lax。

### 6. 质量保障——多 agent 评审 + 置信度过滤（最有价值的机制）

**code-review 插件**（命令 `code-review.md`）流程：

1. haiku 预检：PR 是否已关闭/草稿/无需评审/已被评论过 → 是则停止（**避免无效劳动**）；
2. 定位所有相关 CLAUDE.md（**分层作用域：只考虑与文件路径共享的 CLAUDE.md**）；
3. sonnet 总结 PR；
4. **4 个评审 agent 并行独立评审**（2 个 CLAUDE.md 合规 + 2 个 opus bug 检测）；
5. **独立验证 agent 复核每条 issue**（"真的成立吗？CLAUDE.md 规则真的作用到这个文件吗？"）——**两段式过滤假阳性**；
6. 只保留验证通过的问题；
7. 输出结论，按需发布评论（每条 issue 只发一条、附可提交补丁或修复建议，超 6 行结构改动不给补丁只给建议）。

核心信条（原文）：**"We only want HIGH SIGNAL issues… False positives erode trust and waste reviewer time."** 明确不 flag：lint 能抓的、主观建议、依赖特定输入才出现的潜在问题、未验证就无法确认的问题；"If you are not certain an issue is real, do not flag it."

**pr-review-toolkit 插件**：6 个专业评审 agent 维度化拆分——comments / tests / **silent-failure-hunter（静默失败猎手）** / type design / code quality / code simplify。

**feature-dev 插件**：7 阶段功能开发（Discovery → Codebase Exploration（并行 explorer）→ **Clarifying Questions（DO NOT SKIP，等用户回答）** → Architecture Design（多方案对比 + 推荐 + 用户选择）→ Implementation（**明确用户批准后才开始**）→ Quality Review（3 个并行 reviewer：简洁性/正确性/约定）→ Summary）。核心原则："Ask clarifying questions early… Wait for answers before proceeding."

### 7. 人机协作与成本/上下文管理（CHANGELOG 旁证）

- `/goal` 长任务检查点：重复 check-in 退避（30min → 1h → 2h），恢复会话时恢复 goal（**长任务报告节奏管理**）；
- `/cost`、状态行、`--max-budget-usd`：预算上限与成本可见性；
- compaction 后提醒"skill 原参数不重跑"、WebFetch 页面内容 15 分钟过期（上下文新鲜度）；
- ralph-wiggum 插件：**completion-promise 机制**——循环迭代时"只有陈述完全且明确为真才能输出完成承诺，禁止为了逃出循环撒谎"（自指迭代的诚实约束）。

---

## 四、与小黑现状对照（已有 / 可吸收）

### 已有、无需重复（对标维度）

| Claude Code 机制 | 小黑现状 |
|---|---|
| Plan/Act 分离 + 批准门（feature-dev Phase 5） | 准则 1：多文件/高风险先出方案经监督者确认；规划期只读硬约束 |
| 质量门才算完成（Stop hook 语义） | 准则 5：typecheck + test 全绿才算完成 |
| 错误自愈（错误回喂模型） | 准则 4：失败先自愈一次再停止 |
| 权限模型（allow/ask/deny + 规则模式） | dsh 底盘权限分层 L0-L3 + ask 审批 + workspace-write 沙箱 |
| 破坏性操作防护 | 准则 7：永久/不可恢复显式标注、自愈不绕过安全边界 |
| 跨会话记忆（CLAUDE.md / MEMORY.md） | 准则 8：learnings.md 跨任务沉淀 |
| 子代理（agents 白名单） | dsh harness 的子代理工具面由 harness 控制；深度限制已在 harness 层 |
| CLAUDE.md 分层作用域 | 仓库 AGENTS.md 单层注入（分层作用域可作 harness 候选） |

### 值得小黑吸取的功能点（3-5 条）

**1. 澄清先行（feature-dev Phase 3，DO NOT SKIP）**
- 功能：实现前显式列出所有歧义/未定义行为，一次性向用户提问并**等待回答**，不带着假设开工。
- 具体做法：Discovery 后把"未决问题清单"组织成结构化列表，用户答复后再进入设计；用户说"你决定"时给出推荐并要显式确认。
- 对小黑的价值：准则 1 目前只有"一句话确认目标"，升级为"方案含待澄清问题 + 默认假设"，减少带错假设开工的返工（与 code-review 的"不基于猜测 flag"同源）。

**2. 高信号过滤的两段式评审（code-review）**
- 功能：评审产出先并行收集、再独立验证，只保留"编译/运行必失败、逻辑确定错误、明确违规"级别的问题；假阳性侵蚀信任。
- 具体做法：先让 4 个 agent 并行找问题 → 验证 agent 复核每个问题真实性 → 过滤 → 输出；明确列出"不 flag"清单（lint 能抓的、主观的、无法验证的）。
- 对小黑的价值：错误自愈前先确认问题真实；质量门前移时按高信号优先级处理，不修假阳性、不把疑似当事实——直接强化准则 4/6 的"不编造"纪律。

**3. 结论分级：区分"已确认事实"与"疑似/推断"（code-review + ralph-wiggum 的诚实约束）**
- 功能：任何断言都标注依据等级；完成承诺只有在陈述完全为真时才可给出。
- 具体做法：评审输出按证据分级；循环迭代禁止为逃出而谎报完成。
- 对小黑的价值：与准则 4"每一步断言都以工具结果为依据"互补，把"有依据"升级为"标注置信度与假设"。

**4. 命令/子代理级工具白名单（allowed-tools / agents tools）**
- 功能：每个命令、每个子代理显式声明可用工具集，把工作流约束在最小工具面；wrapper 脚本进一步收窄（triage-issue 用 `./scripts/gh.sh` 而非裸 gh）。
- 具体做法：frontmatter `allowed-tools: Bash(gh issue view:*), ...`；`tools: Glob, Grep, Read, ...`。
- 对小黑的价值：属于 **dsh harness 层**能力（子代理工具面由 harness 注入），准则层无法实现——列为 harness 层建议，不硬塞进准则。

**5. hooks 事件面 + asyncRewake 异步唤醒（security-guidance）**
- 功能：关键事件（PreToolUse/PostToolUse/Stop）挂检查器；后台评审跑完再唤醒 agent 处理，不阻塞主流程也不丢问题。
- 具体做法：hooks.json 声明事件+matcher+if+asyncRewake；hookify 用 markdown 规则文件零代码定义（warn/block）。
- 对小黑的价值：质量门前移目前是"同步自查"，异步后台检查 + 唤醒属于 **dsh harness 层**能力（事件系统）。列为 harness 候选。

---

## 五、落地吸收（本次改动）

### 准则层落地 2 条（本次任务，改 XIAO_HEI_PROMPT）

1. **澄清先行 + 假设显式化**（对应亮点 1）：准则 1 追加——需求有歧义时方案列出"待澄清问题"，监督者未答复按最小假设推进并显式写进方案与报告。
2. **结论分级 + 高信号优先**（对应亮点 2/3）：准则 4 追加"先验证问题真实性再修，高信号优先，不修假阳性"；准则 6 追加"报告与断言区分'已确认（有工具结果依据）'与'疑似/推断（未验证假设）'"。

### harness 层建议（不塞进准则，如实标注"建议后续在 harness 层实现"）

- **命令/子代理工具白名单**（allowed-tools / agents tools）：dsh 派生子代理时按角色注入只读/全能力工具面（本仓库 AGENTS.md 已有"新增工具权限准则"，可延伸为按任务类型限工具）；
- **hooks 事件面 + asyncRewake**：dsh 在 PreToolUse/PostToolUse 挂检查器、后台评审异步唤醒主 agent；
- **CLAUDE.md 分层作用域**：按目录层级加载项目规则（现为 AGENTS.md 单层注入）；
- **sandbox 网络白名单**（allowedDomains/Unix socket）：细化 dsh 沙箱网络策略。

---

## 六、参考链接

- 仓库：https://github.com/anthropics/claude-code
- README：https://raw.githubusercontent.com/anthropics/claude-code/main/README.md
- 官方文档（沙箱内不可达，依据仓库内文件与搜索结果）：https://code.claude.com/docs/en/overview
- 插件总览：`plugins/README.md`；marketplace：`.claude-plugin/marketplace.json`
- 关键实证文件：
  - `plugins/code-review/commands/code-review.md`（高信号两段式评审）
  - `plugins/feature-dev/commands/feature-dev.md` + `agents/code-explorer.md`（7 阶段流程 + 子代理白名单）
  - `plugins/security-guidance/hooks/hooks.json`（hooks 事件面 + asyncRewake）
  - `plugins/hookify/README.md`（markdown 规则 hook）
  - `plugins/pr-review-toolkit`、`plugins/ralph-wiggum/commands/ralph-loop.md`、`plugins/commit-commands`
  - `.claude/commands/commit-push-pr.md` / `triage-issue.md` / `dedupe.md`（allowed-tools 命令白名单）
  - `examples/settings/settings-strict.json` / `settings-bash-sandbox.json`（权限与沙箱模型）
  - `CHANGELOG.md`（v2.1.x 产品能力演进旁证）
