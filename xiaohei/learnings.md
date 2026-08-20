# 小黑 · GitHub AI 工程师/编码智能体调研报告

> 调研人：小黑（dsh 底盘工程师子代理）
> 调研日期：2026-08-20
> 调研方式：GitHub REST API（`/search/repositories`、`/repos/{owner}/{repo}/readme`、contents API）抓取仓库元数据与 README/官方文档，无浏览器；数据（star 数、描述）以抓取当日 GitHub API 返回为准。
> 调研范围：AI 工程师/编码智能体（AI coding agent）方向的 5 个高星标开源项目 + 1 个关键延伸项目（mini-swe-agent）。
> 依据：本仓库《架构参考政策》——只吸收架构与设计思想，不复制代码。

---

## 一、调研项目总览

| 项目 | 仓库 | Star（2026-08-20） | 语言 | 定位 |
|---|---|---|---|---|
| OpenHands | [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) | ~84.6k | TypeScript | AI 驱动开发平台 / 自托管 Agent 控制中心 |
| Cline | [cline/cline](https://github.com/cline/cline) | ~66.5k | TypeScript | IDE / 终端 / CLI / SDK 全形态编码 Agent |
| aider | [Aider-AI/aider](https://github.com/Aider-AI/aider) | ~48.4k | Python | 终端 AI 结对编程 |
| Goose | [aaif-goose/goose](https://github.com/aaif-goose/goose) | ~53k | Rust | 通用型本机 Agent（Linux 基金会托管） |
| SWE-agent | [SWE-agent/SWE-agent](https://github.com/SWE-agent/SWE-agent) | ~20k | Python | 研究型：Agent-Computer Interface（ACI） |
| mini-swe-agent（延伸） | [SWE-agent/mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) | — | Python | SWE-agent 的"100 倍简化"版，官方推荐替代 |

---

## 二、逐项目分析

### 1. OpenHands —— 沙箱隔离 + 事件驱动自动化

- **核心理念**：AI 驱动的软件开发（"AI-Driven Development"）。Agent 在受控运行时（Docker 沙箱 / VM / 云）中自主读代码、改代码、跑命令；当前主线产品 Agent Canvas 是自托管的"开发者控制中心"，可同时运行 OpenHands、Claude Code、Codex 等任意 **ACP（Agent-Client Protocol）兼容 agent**，并跨本地/远程/云 backend 切换。
- **工作流程设计**：`会话 → Agent Server（REST API）→ 沙箱运行时执行 → 结果回传`；配 Automation Server 支持**定时（schedule）与事件（webhook）触发**的无人值守运行（如"生成报告发 Slack""自动拆解 GitHub issue 为任务"）。
- **质量保障机制**：CI 质量门为 typecheck / ESLint / Prettier / 单元与组件测试 / 应用与库构建 / `npm pack --dry-run`，另有可选 live E2E QA 与测试矩阵；文档明确警告"无沙箱模式 agent 拥有宿主机完整文件系统访问权"，推荐 Docker 沙箱做工作区隔离。
- **人机协作方式**：Agent Canvas 提供对话/终端/文件/自动化 UI 监控；一个 Agent Server 可团队共享（代码评审、依赖更新），个人 agent 跑在笔记本上。
- **值得借鉴的亮点**：
  1. **沙箱即安全边界**：把"agent 能碰什么"工程化（挂载 `PROJECTS_PATH` 白名单目录），与小黑 dsh 的权限分层（L0-L3）同思路但落在隔离层；
  2. **事件驱动无人值守**：webhook/schedule 唤醒 agent 做例行工程，而非只靠人类发消息；
  3. **多 backend 可切换**：同一前端切换不同执行环境。

### 2. Cline —— Plan/Act 双模式 + 每步人类批准 + Checkpoint 回滚

- **核心理念**：开放源码的编码 agent，覆盖 VS Code 插件 / JetBrains 插件 / CLI / 无头 CI 模式 / SDK / 多 agent 看板（Kanban）全形态；核心是 **human-in-the-loop** 的自主编码。
- **工作流程设计**：**Plan 模式**先探索代码库、提问澄清、给出策略；对齐后切 **Act 模式**执行。每个文件编辑与终端命令默认**逐条要求用户批准**（可开 auto-approve 完全自主）。执行中实时监控 linter 与编译器错误，未等用户看到就自修（缺 import、类型不匹配、语法错误）。
- **质量保障机制**：每次编辑以 **checkpoint** 跟踪，可逐点 undo；项目级 `.clinerules` 规则文件约束编码规范/架构约定/测试要求，CLI/插件自动拾取；Skills 按需加载规则。
- **人机协作方式**：diff 可审查/修改/回滚；`Plan → Act` 两段式；Kanban 多 agent 并行（每张卡独立 worktree + auto-commit + 依赖链）；cron 定时 agent；可接 Slack/Telegram/Discord/WhatsApp（线程即会话）；无头 CLI 接 CI/CD（`git diff origin/main | cline "Review"`）。
- **值得借鉴的亮点**：
  1. **Plan/Act 分离 + 批准门**：方案先行、批准后执行，和小黑"确认目标 → 说明方案 → 动手"准则同构，但 Cline 把批准做成**强制门**；
  2. **Checkpoint 细粒度回滚**：不是"回滚到任务起点"，而是能退到任意一步；
  3. **边改边监控错误并自修**：质量保障内建于执行循环内部。

### 3. aider —— 每次改动自动 lint+test 的闭环 + Git 自动提交 + 仓库地图

- **核心理念**：终端里的 AI 结对编程（"AI pair programming in your terminal"），让 LLM 直接在真实代码仓库里干活。
- **工作流程设计**：在仓库内启动 → LLM 编辑文件 → **自动 git commit（语义化提交信息）** → **每次改动自动跑 lint 与测试**，发现的问题由 aider 继续修复 → 循环直到通过。
- **质量保障机制**：
  - **"Automatically lint and test your code every time aider makes changes. Aider can fix problems detected by your linters and test suites."**——质量门内建于每次改动之后，而非任务终点；
  - **repo map（仓库地图）**：为整个代码库生成地图，使模型在大项目中定位与跨文件修改；
  - **Git 即回滚层**：每个 AI 改动都是一个 commit，可用原生 git diff/undo；
  - 吃自己的狗粮：aider 自身最新版本约 **88% 的新代码由 aider 自己编写**（Singularity 指标）。
- **人机协作方式**：终端交互式对话；voice-to-code 语音改代码；IDE watch 模式（在代码里写注释即需求）；图片/网页作上下文；与任意 web chat 复制粘贴协作。
- **值得借鉴的亮点**：
  1. **"改 → 测 → 修"内环**：质量门不是终点仪式，而是每次编辑后的自动反馈，失败立即修；
  2. **repo map 上下文压缩**：用结构索引代替塞入全文，解决大仓库上下文问题；
  3. **git 自动提交 = 天然回滚点**，与小黑"动手前记 git 基线"同思路但更频繁（每步一提交）。

### 4. Goose —— 错误即自愈信号 + 上下文修订 + MCP 扩展生态

- **核心理念**：运行在你机器上的通用 AI agent（桌面 App / CLI / API），不止写代码；Rust 实现，Linux 基金会（AAIF）托管，兼容 15+ 模型供应商、70+ MCP 扩展。
- **工作流程设计**（官方架构文档）：`Human Request → Provider Chat（请求 + 工具清单）→ Model Extension Call（工具调用）→ 执行工具并取回结果 → 回传模型 → Context Revision → 最终响应`。**Context Revision**：用更小更快的模型做总结、用算法删除旧/无关内容、find-and-replace 代替重写大文件、ripgrep 跳过系统文件、摘要冗长命令输出——把 token 管理做成主动机制。
- **质量保障机制**（官方 error-handling 文档）：
  - **错误分类**：传统错误（网络/模型不可用）抛给调用方（anyhow）；**agent 错误（未知工具名、参数错误、工具执行失败）不中断，而是作为 `ToolResult` 回传给 LLM 让它自愈**——"error messages are in some ways prompting"，错误消息本身就是指导恢复的提示；
  - 架构上 `ToolUse` / `ToolResult` 以 `Result<T, AgentError>` 贯穿 API，工具调用的错误立即变成工具结果的错误再喂回模型；
  - CI + Linux 基金会健康分。
- **人机协作方式**：桌面/CLI/API 三形态；MCP 扩展即插即用；ACP 双向——既可被 JetBrains/Zed 当 server，也可委托 Claude Code/Codex 当 provider。
- **值得借鉴的亮点**：
  1. **错误回喂模型自愈**：非确定性 LLM 产生的错误是可恢复的、预期内的，用结构化错误 + 恢复提示引导模型修正，而不是中断或盲目重试；
  2. **Context Revision**：主动做上下文修剪/摘要，而不是等上下文爆掉；
  3. **扩展协议标准化**：MCP/ACP 生态，能力靠标准协议外接而非全部自研。

### 5. SWE-agent —— ACI（Agent-Computer Interface）研究 + 基准驱动迭代

- **核心理念**：论文《SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering》的核心发现——**给 LLM 的工具接口设计（ACI）比模型本身更决定任务成败**：不给任意 shell，而是精心设计的小工具集（搜索/查看/编辑/执行），显著提升成功率。
- **工作流程设计**：读 GitHub issue → 用 ACI 工具搜索/定位/修改 → 跑测试验证；1.0 版转向 **free-flowing**（"Leaves maximal agency to the LM"）——LM 变强后不再强制严格输出格式，由单个 **yaml 配置文件**统辖全部行为；批量模式可直接跑 SWE-bench 评测。
- **质量保障机制**：**基准驱动开发**——以 SWE-bench verified/light 的通过率为每个改动的验收标准（1.0 + Claude 3.7 曾为开源项目 SoTA）；CI（pytest、codecov、pre-commit、文档链接周期检查）。
- **人机协作方式**：交互式命令行、浏览器 Codespaces 即开即用、**trajectory browser（轨迹浏览器）** 回放 agent 每步轨迹用于复盘与调试。
- **值得借鉴的亮点**：
  1. **用可复现基准量化每次迭代**，避免"感觉变强了"；
  2. **轨迹可回放**：agent 的每一步可复盘，是调试与改进的望远镜；
  3. 配置即代码（yaml 控制 agent 行为），行为可版本化、可对比。

### 6. mini-swe-agent（延伸）—— 100 倍简化的反直觉结论

- **核心理念**："What if our agent was 100x simpler, and still worked nearly as well?"——SWE-agent 团队一年后复盘：LM 能力变强后，**大量花哨工具接口不再必要**。
- **具体做法**：agent 核心类约 **100 行 Python**，SWE-bench verified 得分 >74%（超过不少复杂脚手架）：
  - **只有 bash 一个工具**，甚至不依赖 LM 的 tool-calling 接口（任何模型都能跑）；
  - **完全线性历史**：轨迹 == 喂给 LM 的消息，没有任何差异，**利于调试与微调**；
  - **`subprocess.run` 无状态执行**：每次命令独立，不维持有状态 shell 会话——换 `docker exec` 即可沙箱化，易扩展、稳定性好；
  - 定位是 **hackable 而非黑盒**：简单到一眼能看懂、方便扩展。
- **值得借鉴的亮点**：**简单性本身就是工程价值**；脚手架不应抢模型的风头；线性、无状态、可调试的 agent 核心比功能堆叠更可靠。

---

## 三、优秀实践总结（做好 AI 工程师的关键原则）

### 原则 1：质量门内建于"每次改动"的循环里，而不是任务终点的仪式
- **来源**：aider（每次改动自动 lint+test 并自动修复）、Cline（执行中实时监控 linter/编译器错误并自修）。
- **具体做法**：把"改 → 测 → 修"做成 agent 循环的内环：每完成一小步改动立即跑相关质量检查，失败先修再继续；全部完成后才做全量门。
- **启示**：错误早发现、早修复，成本最低；质量门同时是给 agent 的**反馈信号**，驱动它自我修正，而不是等人类发现。

### 原则 2：简单性本身是性能——工具与抽象要克制
- **来源**：mini-swe-agent（100 行 Python、只有 bash 一个工具、线性历史、无状态执行，性能不输复杂脚手架）、SWE-agent（LM 变强后主动砍掉严格接口）。
- **具体做法**：优先用最简工具集完成任务；执行保持无状态、可沙箱化；轨迹与喂给模型的消息一致，便于调试。
- **启示**：工具的多少不等于能力；每多一个工具/抽象都在增加上下文与出错面。和本仓库《架构参考政策》的"禁止过度工程化"同源。

### 原则 3：把错误当作喂回模型的自愈信号，而不是中断
- **来源**：Goose（`ToolUse`/`ToolResult` 以 `Result<T, AgentError>` 贯穿，未知工具/参数错/执行失败全部回传 LLM 自愈；"error messages are in some ways prompting"）。
- **具体做法**：对 LLM 非确定性产生的错误分类处理：传统错误（网络等）交给调用方；**agent 错误**结构化回传模型，错误消息附恢复指引，让模型修正参数/换方案/修代码后继续。
- **启示**：一次任务中出现若干 agent 错误是**预期内的常态**，能否自愈决定自主性上限；盲目重试和直接中断都不如"带上下文的自愈"。

### 原则 4：人类在环的授权 + 细粒度回滚，是信任的底座
- **来源**：Cline（Plan/Act 双模式、每步批准门、checkpoint 逐点 undo）、aider（git 自动提交，每个 AI 改动都可 diff/回滚）。
- **具体做法**：高风险/多文件任务先 Plan 后 Act，关键动作需批准；每个改动留快照（commit/checkpoint），可回退到任意一步而非只能回到起点。
- **启示**：自主性要和可控性一起给；人类愿意放权，前提是"每一步都能看清楚、随时能退回去"。

### 原则 5：用可复现的基准/轨迹驱动迭代，不靠感觉
- **来源**：SWE-agent / mini-swe-agent（SWE-bench 通过率是每个改动的验收标准；trajectory browser 回放轨迹复盘）、aider（Singularity 88%：用"自己写自己代码的比例"量化吃狗粮）。
- **具体做法**：沉淀一组代表性任务作为"能力基准"，每个 agent 改动/自我改进都用它在基准上的表现验收；轨迹可回放，失败可复盘到具体一步。
- **启示**：AI 工程师的自我改进如果没有量化基线，就无法确认"改进了"；轨迹是调试与成长的望远镜。

> 补充（上下文工程）：Goose 的 Context Revision（小模型总结、算法删旧内容、find&replace 代替重写、摘要冗长输出）与 aider 的 repo map（仓库地图代替全文），共同证明**主动上下文管理**是长期任务可靠性的关键——与上述 5 条并列值得借鉴。

---

## 四、小黑的差距（对照上述实践）

对照小黑当前工作准则（确认目标 → 阅读代码 → 小步实现 → typecheck+test 质量门 → 结构化汇报）与 dsh 底盘现状：

1. **质量门是"终点仪式"，不是"循环内环"**：当前只在任务完成时跑一次 `npm run typecheck` + `npm test`；中途的编译/测试错误可能累积到最后一并爆出，修复成本高。aider/Cline 的做法是每次改动后立即跑并自修。
2. **方案确认是"软性说明"，没有强制批准门**：准则要求"说明改动方案后再动手"，但缺少 Plan/Act 分离和逐步批准机制；对 L2+ / 多文件改动缺少"方案 → 批准 → 执行"的强制流程（Cline 的 Plan mode）。
3. **错误处理策略偏"中断式"**：工具失败时当前倾向"说明原因、必要时回滚"；缺少 Goose 式的**错误回喂自愈环**（结构化错误 + 恢复提示 → 模型自愈一次 → 再失败才停止）。
4. **无能力评测基线**：没有代表性任务集来量化"小黑是否在进步"；自我改进（如本文档）缺乏数据支撑；也没有轨迹回放/复盘机制（SWE-agent trajectory browser）。
5. **上下文管理被动依赖 dsh 压缩**：工具输出、仓库结构、历史学习结论都靠底盘自动压缩；没有主动做"工具输出截断/摘要、仓库地图、学习沉淀文件（本文档就是第一步）"。
6. **回滚粒度粗**：只有"任务前 git 基线 + 失败回滚到基线"，没有 Cline 式 checkpoint（回退到任意一步）。
7. **单 agent 无编排**：具备 subagent 能力，但未形成 coordinator → specialist 的正式工作流（Cline Kanban / 多 agent 团队）。

---

## 五、改进建议（可落地，按优先级排序）

### 建议 1（高）质量门前移：建立"改-测-修"内环
- **做法**：把现有"最后一次性全量门"拆成两级：小步实现中，**每个独立改动（一个文件或一组相关文件）完成后立即跑相关测试与 typecheck**，失败先自修再继续；全部完成后仍跑全量 `npm run typecheck` + `npm test` 作为最终门。
- **理由**：对齐 aider 的 lint/test loop 与 Cline 的实时监控；错误越早发现修复成本越低，且质量结果成为下一步决策的输入，避免"改一大片后统一爆错"。

### 建议 2（高）错误自愈协议：工具失败先"带上下文自愈一次"
- **做法**：约定失败处理阶梯：① 工具返回结构化错误（退出码/关键 stderr/可能原因）→ ② 基于结果读代码/确认事实 → ③ 尝试一次修正（换参数、改方案、修代码）后重跑 → ④ 仍失败才停止并按准则报告/回滚。保持现有"不编造、以工具结果为准"纪律不变（每一步断言都以工具结果为依据）。
- **理由**：Goose 证明 LLM 非确定性产生的错误大部分可自愈，且错误消息本身是最好的恢复提示；能显著减少人工介入，提升自主任务完成率，同时不牺牲可靠性。

### 建议 3（中）Plan/Act 分离 + Checkpoint 细粒度回滚
- **做法**：对多文件或 L2+ 权限任务，先输出完整方案（改动文件清单、影响面、回滚点）经监督者确认后再动手；执行中在关键节点打快照（git 临时分支/tag/`git stash` 或记录 diff 摘要），失败时可回退到**最近 checkpoint** 而非只能回任务基线。
- **理由**：Cline 证明"方案批准 + 逐点回滚"是赢得放权信任的关键；细粒度回滚降低每次实验的心理与真实成本，也符合"小步实现、可回滚"准则的加强版。

### 建议 4（中）建立能力评测基线（小黑的 SWE-bench）
- **做法**：沉淀 8-10 个代表性任务（如"新增一个 L0/L1 工具并配测试""重构某模块并保持测试全绿""按 issue 修 bug"），每次任务完成后记录通过/失败与耗时；定期（如每月）复盘趋势，作为自我改进的量化依据；可在文档（如 `xiaohei/` 下）维护基线结果表。
- **理由**：SWE-agent/mini-swe-agent 证明基准驱动迭代是编码 agent 进步最可靠的引擎；没有基线，"变强了"只是感觉。同时可与"轨迹回放"结合，失败任务复盘到具体一步。

### 建议 5（低）主动上下文工程与学习沉淀
- **做法**：① 长输出/大文件读取默认截断+摘要（对齐 goose 的 Context Revision 与 dsh 输出管理）；② 大型代码库工作时先生成仓库地图（目录树 + 关键文件索引）再定位，而不是全文塞入；③ 把跨任务的学习结论沉淀到 `xiaohei/learnings.md` 这类文件，形成可复用的长期记忆，避免每次重新摸索。
- **理由**：长期 subagent 的上下文是稀缺资源；aider 的 repo map 与 goose 的 Context Revision 证明主动管理显著提升大项目表现；本文档本身就是第 ③ 条的第一份落地物。

---

## 六、参考链接

- OpenHands：https://github.com/OpenHands/OpenHands （README / docs/architecture.md）
- Cline：https://github.com/cline/cline （README：Plan and Act / Rules and Skills / Multi-Agent Teams）
- aider：https://github.com/Aider-AI/aider （README：Git integration / Linting & testing / Maps your codebase）
- Goose：https://github.com/aaif-goose/goose （README / documentation/docs/goose-architecture/goose-architecture.md、error-handling.md）
- SWE-agent：https://github.com/SWE-agent/SWE-agent （README / arXiv:2405.15793）
- mini-swe-agent：https://github.com/SWE-agent/mini-swe-agent （README）

---

## 七、自我进化记录

> 本小节记录小黑把"优秀实践总结"落地到自己工作方式中的过程与效果，作为能力评测基线（建议 4）的第一条数据。

### 进化 #1（2026-08-20）：落地质量门前移 / 错误自愈 / Plan-Act 分离

- **落地内容**（同步到 `XIAO_HEI_PROMPT` 工作准则，services/agent-server/src/services/engineer-tools.ts）：
  1. **质量门前移**：准则新增"每完成一小步改动立即跑相关测试/typecheck，失败先自修再继续，不把错误攒到任务终点"——把 aider/Cline 的"改 → 测 → 修"内环写进小黑的任务单；本次任务即按此执行（改完 engineer-tools.ts 后立即跑该文件测试，5/5 通过再继续）。
  2. **错误自愈协议**：准则新增"失败时先自愈一次（分析错误 → 修复 → 重跑），仍失败才停止并报告"，对齐 Goose 的"错误即自愈信号"；同时保留"每一步断言都以工具结果为依据，不编造"的纪律。
  3. **Plan/Act 分离**：准则把"说明改动方案"升级为"多文件/高风险（L2+）改动先输出方案（改动清单、影响面、回滚点）经监督者确认后再动手"，对齐 Cline 的 Plan mode 批准门；并补充"执行中关键节点留快照，可回退到最近一步"。
- **同步动作**：主页（xiaohei/index.html）工作准则更新为 6 步（确认 → 方案先行 → 小步实现 → 错误自愈 → 质量门 → 结构化汇报），新增"自我进化"小节；engineer-tools.test.ts 增加对新准则关键词（质量门前移/自愈/Plan/Act 分离）的断言，防回归。
- **效果**：准则层落地完成，全量 `npm run typecheck` + `npm test` 全绿；量化收益（任务成功率/返工率）待能力评测基线建立后补充。
- **下一步**：① 建立 8-10 个代表性任务的能力评测基线（建议 4，SWE-bench 思路）；② 落地主动上下文工程——工具输出截断/摘要、仓库地图（建议 5）；③ 轨迹回放/复盘机制（建议 4 配套）。
