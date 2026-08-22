# ECC（affaan-m/ECC）专项分析——小黑可吸收功能点

> 调研人：小黑（dsh 底盘工程师子代理）
> 调研日期：2026-08-23
> 调研方式：GitHub REST API（`/repos/{owner}/{repo}`、`/contents/{path}`）+ raw 文件抓取，无浏览器；数据（star 数、组件数量）以抓取当日 GitHub API 与仓库 README 返回为准。
> 依据：本仓库《架构参考政策》——只吸收架构与设计思想，不复制代码；与 OpenAI 参考列表交叉检查，本项目不在《架构参考政策》名单内，仅作为行业实践对标参考。

---

## 一、项目定位与核心价值

- **仓库**：[affaan-m/ECC](https://github.com/affaan-m/ECC)。GitHub API 描述："The agent harness performance optimization system. Skills, instincts, memory, security, and research-first development for Claude Code, Codex, Opencode, Cursor and beyond."
- **数据**：242,111 stars / 36,696 forks（2026-08-22 API 返回）；语言 JavaScript；许可证 MIT；主页 https://ecc.tools；创建 2026-01-18，最近推送 2026-08-21。
- **定位**：ECC 既不是 Educational Codeforces，也不是椭圆曲线密码学，而是 **"Agent Harness 操作系统"（the agent harness operating system）**——面向 Claude Code、Codex、OpenCode、Cursor、Gemini、Zed、Qwen、Kimi、Hermes、OpenClaw 等十余种 AI 编码代理的**性能优化与工程化系统**，一次安装即成为 agent 工作方式的一部分，不必在每个 prompt 里重建工程流程。
- **核心循环**（README 原文）：`plan -> test -> implement -> review -> verify -> remember -> improve`（"Your agent can write code, but ECC gives it a coordinated engineering system and toolbox: it plans before it builds, verifies changes with tests, reviews its own work from a fresh context, remembers what matters, and turns repeated wins into reusable skills and workflows."）。
- **设计哲学**（README 原文）：**"Optimize the context window. Persist everything else."**——上下文窗口只装当下需要的，其余全部持久化到外部（记忆/技能/规则）。
- **构成规模**（README 原文）：68 agents（规划/评审/构建修复/安全/架构/领域工作）、286 skills（TDD/研究/安全/文档/前端/数据/ML/运维）、94 commands（迁移期兼容入口）、hooks + memory 运行时（强制检查、会话摘要、连续学习、instincts、上下文控制）、rules（按语言/项目选择性常驻）、AgentShield（对 prompts/hooks/MCP 配置/权限/密钥/agent 文件的安全扫描）。

## 二、架构与代码组织

仓库根目录即"唯一事实源（source of truth）"，平台适配器（.claude-plugin/ .codex/ .cursor/ .opencode/ .gemini/ .qwen/ .kimi/ .zed/ .trae/ 等）打包或映射同一套工作流，而非为每个平台维护独立副本。核心目录：

| 目录 | 内容 | 上下文行为（README "Skills keep the context focused" 一节） |
|---|---|---|
| `agents/` | 68 个可委派的专门子代理（planner/architect/code-reviewer/security-reviewer/build-error-resolver/各语言 reviewer…） | 带自身上下文与工具权限的隔离工人，隔离规划/实现/评审 |
| `skills/` | 286 个按需加载的可复用工作流（tdd-workflow/security-review/continuous-learning-v2/context-budget/iterative-retrieval…） | 任务需要时才加载 |
| `commands/` + `legacy-command-shims/` | 94 个斜杠命令兼容入口 + 退役 shim | 迁移期便利入口，新工作流优先落 skills/ |
| `rules/` | 常驻标准，`common/`（语言无关）+ 20+ 语言/框架包 | 始终加载，因此要求"选择性安装" |
| `hooks/` | 事件触发脚本（hooks.json + memory-persistence/ 等） | 在模型上下文之外运行，可做确定性强制检查 |
| `scripts/` | 安装/修复/同步/编排/检查（Node.js） | — |
| `tests/` | 测试套件（lib/ hooks/ run-all.js） | — |
| `contexts/` | 动态系统提示注入上下文（dev/review/research） | — |
| `examples/` | 各技术栈真实 CLAUDE.md 范例（saas-nextjs/go-microservice/django-api…） | — |
| `mcp-configs/` | MCP 服务器配置清单 | — |

**关键设计点**：
1. **五类载体职责分离**：Skills（按需加载的工作流）/ Agents（隔离上下文与工具权限的工人）/ Rules（常驻标准）/ Hooks（上下文外执行的确定性检查）/ Instincts（带置信度分数的会话学习模式）——各管一摊，是 ECC"不加能力的同时不把整个仓库倒进每个会话"的关键。
2. **agent 定义 = frontmatter + Markdown 正文**：`agents/code-reviewer.md` 以 `---` frontmatter 声明 `name / description / tools（Read,Grep,Glob,Bash）/ model（sonnet|opus）`，正文是完整行为规范——与 Claude Code 的 agent 文件规范同构。
3. **根目录是事实源、适配器是映射**：跨 harness 一致性靠"一份工作流 + 多份薄适配"，不靠复制粘贴。
4. **多语言 README（12 种）与分角色 guide**：the-shortform-guide（上手）/ the-longform-guide（上下文经济学/记忆/evals/并行 agent）/ the-security-guide（提示注入/hooks/MCP/AgentShield）。

## 三、质量与工程实践

1. **TDD 门控工作流**：`/ecc:plan` → 确认/编辑 plan → 激活 tdd-workflow → 捕获 RED 证据 → 实现到 GREEN → 新鲜上下文评审 → 带回归测试修复发现 → 验证 build/lint/types/tests。结果不只是代码，而是一条**证据链（evidence trail）**：plan、失败测试、通过测试、评审发现、最终验证。
2. **Fresh-context review（新鲜上下文评审）**：同一个上下文既写代码又评审会漏掉盲区，ECC 用独立 reviewer agent（code-reviewer，sonnet 模型）从干净上下文看 diff——"The same context writes and reviews the code" vs "A fresh-context reviewer looks for regressions and blind spots"。
3. **评审置信度纪律（agents/code-reviewer.md，本次最有价值的可操作实践）**：
   - **>80% 确信才报告**，跳过风格偏好、跳过未改动代码里的非 CRITICAL 问题、合并同类问题、按"会导致 bug/安全漏洞/数据丢失"排序；
   - **Pre-Report Gate 四问**（任一答否就降级或丢弃）：① 能否引用确切行？② 能否描述具体失败模式（输入、状态、坏结果）？③ 是否读过周边上下文（调用方、导入、测试）？④ 严重性是否站得住（JSDoc 缺失永远不是 HIGH）？
   - **HIGH/CRITICAL 必须带证明**：确切片段+行号、具体失败场景（输入/状态/结果）、为何现有防护（类型/校验/框架默认）拦不住——三条缺一降级；
   - **"返回零发现是有效结果"（It Is Acceptable And Expected To Return Zero Findings）**：干净的评审就是有效评审，禁止制造发现来证明调用价值；"manufactured findings, filler nits, speculative 'consider using X'" 是 LLM 评审者的头号失败模式；
   - **Common False Positives 清单**：明确列出 LLM 评审常误报的模式（"consider adding error handling"（错误路径已被上游处理时）、"missing input validation"（内部函数且调用方已校验时）、魔法数、过长函数（switch/配置/测试表）、缺 JSDoc、N+1 查询（固定基数循环）等），无具体代码库证据就跳过。
4. **Hooks 确定性质量门**："Quality checks depend on reminders" vs "Hooks can enforce deterministic checks outside the prompt"——质量检查从"提示词提醒"升级为"上下文外确定性脚本"，不依赖模型自觉；hooks.json 里 PreToolUse（Bash/Write/Edit 前置检查）、async observe（连续学习观测）、governance capture（密钥/策略违规/审批请求）等。
5. **AgentShield 安全扫描（security-scan skill）**：把 agent 配置本身当作攻击面——CLAUDE.md 硬编码密钥/自动执行指令/提示注入模式、settings.json 过度授权 allow 列表/缺失 deny 列表、mcp.json 风险 MCP 服务器/npx 供应链风险、hooks 命令注入/数据外泄、agents/*.md 工具暴露过宽；支持 `--min-severity` 过滤、JSON/Markdown/HTML 报告、auto-fix 安全项，可进 CI。
6. **测试与多语言规则**：tests/ 目录覆盖 lib 与 hooks；rules 按 common + 语言包组织，按需安装（"始终加载所以必须选择性"）。

## 四、值得小黑吸取的功能点（3-5 条，每条含具体做法）

### 功能点 1：评审"报告前四问门禁 + 零发现有效"（来源：agents/code-reviewer.md）
- **具体做法**：任何评审发现在上报前过四问——① 能引用确切文件行吗；② 能说出具体失败模式（输入/状态/坏结果）吗；③ 读过周边上下文（调用方/导入/测试）吗；④ 严重性站得住吗（JSDoc 缺失 ≠ HIGH）。任一答否即降级或丢弃。HIGH/CRITICAL 必须附"片段+行号+失败场景+为何现有防护拦不住"三件套。明确接受"零发现"为有效评审结果。
- **对小黑的价值**：小黑已有"高信号优先、不修假阳性"原则，但缺**可执行的判据**。四问把"高信号"变成四个可自检的问题，直接提升报告可信度、降低噪音返工；"零发现有效"消解"必须找出问题"的隐性压力，防止为交差制造假问题。

### 功能点 2：Instinct 式连续学习（来源：skills/continuous-learning-v2/SKILL.md）
- **具体做法**：v2 把"会话结束 Stop-hook 一次性提取整篇 skill"升级为"PreToolUse/PostToolUse 观测（100% 可靠）+ 后台 observer agent 分析 + **原子化 instinct**"。instinct = 一条经验一个触发、一个动作，带**置信度（0.3-0.9 加权）**、**域标签**（code-style/testing/git/debugging…）、**证据背书**（由哪些观察产生），按**项目作用域**隔离（React 经验不污染 Python 项目），置信度低的暂存、被反驳的衰减；成熟后经 /evolve 聚类升级为 skill/command/agent。v1 的教训被明确记录："skills are probabilistic—they fire ~50-80% of the time. v2 uses hooks for observation (100% reliable)"——观测机制可靠性优先于优雅。
- **对小黑的价值**：小黑的 learnings.md 是自由格式长文，缺"一条经验=一个触发+一个动作+证据"的原子格式，也无置信度标注。原子化+置信度可防止"单次观察当普遍规律"、防止跨项目经验污染；"记忆是未审查上下文、重要结论须回溯权威来源验证"的信任边界可直接复用。

### 功能点 3：上下文预算审计（来源：skills/context-budget/SKILL.md）
- **具体做法**：对每个常驻组件做 token 量化——agents（>200 行标记 heavy、description >30 词标记膨胀）、skills（>400 行标记）、rules（>100 行标记、查同语言包内内容重叠）、MCP（每工具 ~500 token schema 估算、>20 工具/包装 CLI 的服务器标记）、CLAUDE.md 链（合计 >300 行标记）；产出分级报告（Always/Sometimes/Rarely needed）与按 token 节省排序的 Top 优化建议。
- **对小黑的价值**：量化意识——上下文是有限预算，组件增删要"先审计后决策"。纯提示词层无法自审计，需 harness 统计各注入组件 token 开销 → **列为 harness 层建议**。

### 功能点 4：AgentShield 把 harness 配置当攻击面（来源：security-scan skill + README）
- **具体做法**：不信任 agent 配置本身——对 CLAUDE.md/settings.json/mcp.json/hooks/agent 定义逐项扫描（密钥、过度授权、命令注入、供应链、工具暴露过宽），支持最低严重级过滤、多格式报告、auto-fix 与 CI 集成。
- **对小黑的价值**：小黑准则 7 只约束"自己不碰敏感配置"，ECC 提醒**配置本身可能被污染**（提示注入、恶意 MCP、过度授权）。小黑是 agent 而非 harness，自身无法扫描 harness → **列为 harness 层建议**（dsh 对注入的规则/技能/agent 文件做类似扫描）。

### 功能点 5：五类载体职责分离 + 证据链交付（来源：README "Skills keep the context focused" + TDD 一节）
- **具体做法**：Skills/Agents/Rules/Hooks/Instincts 五类载体按"加载时机×上下文成本×职责"分工，新工作流优先落 skills；每个交付物是一条证据链（plan → RED 测试 → GREEN 测试 → 评审发现 → 最终验证），不是一段代码。
- **对小黑的价值**：小黑的准则已含"结构化报告+工具结果依据"，但"证据链"视角（把中间产物当交付物保存）可强化"验证结果可回放"；五类载体分离对 dsh harness 的规则/工具分层有参考价值 → **部分落地（证据链已有）、部分列为 harness 层建议（载体分层）**。

## 五、与小黑现状对照（已有 / 新增 / harness 层）

- **已有，无需重复落地**：Plan/Act 分离 + 方案确认门（= ECC 的 plan→confirm 语义）；质量门全绿才算完成（= Stop hook 语义）；错误自愈一次再停止（= 错误回喂模型）；高信号优先、不修假阳性（= code-reviewer 的 >80% 确信过滤）；结构化报告 + 区分已确认/疑似（= 证据链 + 结论分级）；破坏性操作防护（= 准则 7）；跨任务记忆沉淀（= 准则 8 learnings.md）；权限分层（= AgentShield 的 allow/deny 审计对象，dsh 已有 L0-L3）。
- **本次落地 2 条（准则层强化，非新增抽象）**：
  1. **评审四问门禁 + 零发现有效 + HIGH 需证据**（功能点 1）→ 准则 4：把"高信号优先"从原则升级为可自检判据；
  2. **学习沉淀原子化 + 置信度分级 + 记忆信任边界**（功能点 2）→ 准则 8：learnings.md 从"自由格式长文"升级为"触发+动作+证据+置信度"格式，并明确"记忆是未审查上下文，重要结论须回溯权威来源验证"。
- **harness 层建议（不塞进准则，如实标注）**：① 上下文预算审计（context-budget）——需 harness 统计各注入组件 token 开销；② AgentShield 式配置安全扫描——需 harness 对注入的规则/技能/agent 文件做扫描；③ hooks 确定性质量门——需 harness 事件系统（dsh 已有部分：工程任务 runner 的 typecheck/test 门）；④ 五类载体分层注入——需 harness 按角色注入工具面/规则面（与 Claude Code 分析结论一致）。

## 六、参考链接

- 仓库与 README：https://github.com/affaan-m/ECC
- 关键实证文件：`README.md`（Why Choose ECC / What's Inside / Key Concepts）、`agents/code-reviewer.md`、`agents/planner.md`、`skills/continuous-learning/SKILL.md`（v1 归档）、`skills/continuous-learning-v2/SKILL.md`、`skills/context-budget/SKILL.md`、`skills/security-scan/SKILL.md`、`hooks/hooks.json`、`research/ecc2-codebase-analysis.md`
