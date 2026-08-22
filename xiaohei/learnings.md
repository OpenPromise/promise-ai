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

### 进化 #2（2026-08-20）：落地 grok-build 的 Plan 硬约束 / 安全 deny 优先 / 跨任务记忆沉淀

- **调研来源**：xai-org/grok-build（Grok Build，SpaceXAI 官方编码 agent，Rust）。落地 3 条，全部有官方文档出处：
  1. **Plan 硬约束 + 方案要素结构化**（来源：19-plan-mode.md）：grok-build 在规划阶段除 plan 文件外**拒绝一切文件编辑（任何权限模式下强制）**，且 plan 文件结构化包含"需复用的现有实现（带路径）"与"验证方式"。落地：准则 1 升级为"方案（改动清单、影响面、回滚点、**需复用的现有实现、验证方式**）经监督者确认后再动手；**方案确认前不修改任何文件（规划期只读硬约束）**"。
  2. **安全 deny 优先 + 破坏性操作显式化**（来源：22-permissions-and-safety.md）：grok-build 的 deny > ask > allow，危险命令（rm / git push 等）即使 allow 也始终提示。落地：准则 7 补充"破坏性/永久操作（删除、覆盖、批量变更）即使任务明确要求，也须在方案中显式标注'永久/不可恢复'并预留回滚点；**错误自愈不得绕过安全边界（安全约束优先于自愈）**"——与仓库《新增工具权限准则》的"永久/破坏性操作须标注永久/不可恢复"呼应。
  3. **跨任务记忆沉淀闭环**（来源：13-memory.md）：grok-build 用 /flush（会话要点沉淀）+ 首轮注入（新会话自动复用）+ /dream（合并去重）形成跨会话记忆。落地：新增准则 8"任务完成后把可复用的经验（踩坑、模式、结论）沉淀到 xiaohei/learnings.md 长期记忆，形成跨任务记忆闭环；已有沉淀不重复记录"——把 learnings.md 从"调研报告"升级为"每次任务结束即追加"的活文档。
- **已有、未重复落地**：人格/准则注入（= persona system-reminder 注入）、关键节点留快照（= turn-boundary checkpoint）、质量门全绿才算完成（= Stop hook 硬门）、错误自愈（= 错误回喂模型）。
- **同步动作**：engineer-tools.test.ts 新增三个关键词断言（规划期只读 / 永久/不可恢复 / learnings.md）防回归；主页（xiaohei/index.html）自我进化板块更新；本文件新增"八、Grok Build 专项分析"章节。
- **效果**：准则层落地完成，本次任务全量 `npm run typecheck` + `npm test` 全绿；"任务完成即沉淀"的闭环已在本任务中首次执行（本记录即沉淀物）。
- **下一步**：① 能力评测基线（SWE-bench 思路，8-10 个代表性任务）继续推进；② 子代理能力边界类型化（explore/plan 只读 vs general-purpose 全能力）可作为 harness 层改进候选；③ 建立"记忆 staleness"意识——复用 learnings.md 旧结论前先验证是否仍成立。

### 进化 #3（2026-08-23）：落地 Claude Code 的澄清先行 / 高信号优先 / 结论分级

- **调研来源**：anthropics/claude-code（Claude Code 官方仓库，专有许可证，仓库主体为 plugins 生态）。落地 2 条，全部有仓库内一手文件出处：
  1. **澄清先行 + 假设显式化**（来源：plugins/feature-dev/commands/feature-dev.md 的 Phase 3 Clarifying Questions，"DO NOT SKIP… Wait for answers before proceeding"）。落地：准则 1 追加"需求存在歧义或未定义行为时，方案中列出'待澄清问题'；监督者未答复时按最小假设推进，并把假设显式写进方案与最终报告（不把假设当事实）"——把"一句话确认目标"升级为结构化澄清，防止带错假设开工。
  2. **高信号优先 + 结论分级**（来源：plugins/code-review/commands/code-review.md 的"两段式评审"——先并行找问题、再独立验证、只保留 HIGH SIGNAL；"False positives erode trust and waste reviewer time"，明确不 flag lint 能抓的/主观的/无法验证的）。落地：准则 4 追加"先验证问题真实性再修：优先高信号问题（编译/运行必失败、逻辑确定错误、明确违规），风格/主观/无法验证的疑似问题不擅自大动，避免修假阳性"；准则 6 追加"报告与断言区分'已确认（有工具结果依据）'与'疑似/推断（未验证假设）'，不夸大结论"。
- **已有、未重复落地**：Plan/Act 分离 + 批准门（= feature-dev Phase 5）；质量门全绿才算完成（= Stop hook 语义）；错误自愈（= 错误回喂模型）；权限 allow/ask/deny（= dsh 权限分层 L0-L3）；破坏性操作防护（= 准则 7）；跨会话记忆（= 准则 8 learnings.md）；子代理工具面控制（= harness 层）。
- **harness 层建议（未塞进准则，如实标注）**：① 命令/子代理级工具白名单（allowed-tools / agents tools frontmatter）——dsh 派生子代理按角色注入工具面；② hooks 事件面 + asyncRewake 异步唤醒（security-guidance 的 PostToolUse/Stop + rewakeMessage）——后台安全检查完成再唤醒主 agent；③ CLAUDE.md 分层作用域（目录级规则）；④ sandbox 网络白名单（allowedDomains/Unix socket）。
- **同步动作**：engineer-tools.test.ts 新增 3 个关键词断言（待澄清问题 / 高信号 / 疑似/推断）防回归；主页（xiaohei/index.html）自我进化板块更新；本文件新增"十二、Claude Code 专项分析"章节；调研全文见 xiaohei/claude-code-analysis.md。
- **效果**：准则层落地完成，本次任务全量 `npm run typecheck` + `npm test` 全绿（engineer-tools.test.ts 7/7 通过）。
- **下一步**：① 能力评测基线（SWE-bench 思路）继续推进；② harness 层按上列 4 条建议评估（工具白名单 / hooks 异步唤醒 / 分层规则 / 网络白名单）；③ 在真实任务中验证"澄清先行"与"高信号"的效果并回填本节。

### 进化 #4（2026-08-23）：落地 ECC 的评审四问门禁 / 零发现有效 / 学习沉淀置信度

- **调研来源**：affaan-m/ECC（Agent Harness 操作系统，242k stars，MIT，JavaScript；68 agents / 286 skills / 94 commands / hooks+memory+AgentShield）。落地 2 条，全部有仓库内一手文件出处：
  1. **评审"四问门禁 + 零发现有效 + HIGH 需证据"**（来源：agents/code-reviewer.md 的 Pre-Report Gate 与 "It Is Acceptable And Expected To Return Zero Findings"）。落地：准则 4 追加"提出评审发现前过'四问门禁'：①能引用确切文件行 ②能描述具体失败模式（输入/状态/坏结果）③已读周边上下文（调用方/导入/测试）④严重性站得住（缺失 JSDoc 不等于 HIGH）；HIGH/CRITICAL 必须附证据（片段+行号+失败场景+为何现有防护拦不住）；零发现是有效结果，禁止为证明工作量制造发现"——把"高信号优先"从原则升级为四个可自检判据，并消解"必须找出问题"的隐性压力。
  2. **学习沉淀"原子化+置信度"+ 记忆信任边界**（来源：skills/continuous-learning-v2/SKILL.md 的 instinct 模型——一条经验=一个触发+一个动作，带 0.3-0.9 置信度、域标签、证据背书；"Memory is unreviewed context, not executable policy"）。落地：准则 8 追加"沉淀采用'原子化+置信度'格式：一条经验 = 触发场景 + 动作 + 证据（工具结果/观察依据）；区分高置信（跨任务多次验证）与低置信（单次观察，显式标注'待验证'）；长期记忆属'未审查上下文'，重要结论须回溯权威来源验证后才可当指令复用"——防止单次观察被当普遍规律、防止旧结论直接当指令。
- **已有、未重复落地**：Plan/Act 分离 + 方案确认门（= ECC plan→confirm 语义）；质量门全绿才算完成（= Stop hook 语义）；错误自愈（= 错误回喂模型）；高信号优先、不修假阳性（= code-reviewer >80% 确信过滤）；结构化报告 + 结论分级（= 证据链）；破坏性操作防护（= 准则 7）；跨会话记忆（= 准则 8）；权限分层（= dsh L0-L3，AgentShield 审计对象）。
- **harness 层建议（未塞进准则，如实标注）**：① 上下文预算审计（skills/context-budget——按组件量化 token 开销，需 harness 统计注入成本）；② AgentShield 式配置安全扫描（把注入的规则/技能/agent 文件当攻击面，需 harness 层实现）；③ hooks 确定性质量门（上下文外脚本强制，dsh 已有部分：工程任务 runner 的 typecheck/test 门）；④ 五类载体分层注入（Skills/Agents/Rules/Hooks/Instincts 按加载时机×上下文成本分工）。
- **同步动作**：engineer-tools.test.ts 新增 4 个关键词断言（四问门禁 / 零发现 / 置信度 / 未审查上下文）防回归；本文件新增"十三、ECC 专项分析"章节；调研全文见 xiaohei/ecc-analysis.md。
- **效果**：准则层落地完成，本次任务全量 `npm run typecheck` + `npm test` 全绿。
- **下一步**：① 在真实任务中验证"四问门禁"与"置信度标注"效果并回填本节；② harness 层评估上下文预算审计与配置安全扫描两条建议；③ 能力评测基线（SWE-bench 思路）继续推进。

---

## 八、Grok Build（xai-org/grok-build）专项分析

> 调研人：小黑；调研日期：2026-08-20；调研方式：GitHub REST API（`/search/repositories`、`/repos/{owner}/{repo}/readme`、contents API）抓取仓库元数据、README 与官方用户指南 12 篇文档（plan-mode / subagents / permissions / memory / sandbox / skills / hooks / background-tasks / headless / project-rules / sessions / agent-mode），并抓取 `checkpoint.rs` 源码确认回滚机制。

### 1. 项目概况

- **仓库**：[xai-org/grok-build](https://github.com/xai-org/grok-build)（SpaceXAI 官方，Rust，Apache-2.0，~25.8k stars，2026-07 创建；"synced periodically from the SpaceXAI monorepo"）。
- **命名澄清**：GitHub 搜 "grokbuild"（无连字符）命中的多为第三方项目（如 GreyGunG/grokbuild-proxy，一个把 Grok Build 协议代理成 Claude Code/OpenAI 兼容接口的社区项目）；**官方项目名为 `grok-build`（带连字符）**，位于 xai-org org。同 org 相关项目还有 grok-build-plugin-cc（Claude Code 插件）、grok-1、grok-prompts、xai-cookbook 等。
- **定位**："SpaceXAI's coding agent harness and TUI"——终端 AI 编码 agent，三形态复用同一 agent 运行时：全屏 TUI 交互、headless（脚本/CI）、ACP（Agent Client Protocol）嵌入编辑器。
- **仓库布局**：`xai-grok-pager`（TUI）/ `xai-grok-shell`（agent 运行时 + leader/stdio/headless 入口）/ `xai-grok-tools`（工具实现）/ `xai-grok-workspace`（宿主文件系统、VCS、执行、**checkpoints**）。

### 2. 核心机制（对标小黑的分析维度）

- **工作流程/架构**：TUI 与 agent 运行时分离，三种入口共享同一运行时；`xai-grok-workspace` 内置 **turn-boundary checkpoint**（checkpoint.rs：按 `prompt_index` 打包文件系统 RewindPoint + hunk 增量 + git HEAD/index，恢复到任意一步时各域一起还原）。
- **Plan Mode（19-plan-mode.md）**：规划阶段**除 plan.md 外所有文件编辑被硬性拒绝**——"This holds in every permission mode, including always-approve"，把"先方案后动手"做成工具层强制门，而非软约束；plan 文件结构化：Context（为什么改）/ 推荐方案（不是所有备选）/ 关键改动文件路径 / **需复用的现有函数与工具（带文件路径）** / 验证章节（如何端到端测试）；`exit_plan_mode` 呈现审批（批准 / 要求修改 / 行内评论）。
- **子代理（16-subagents.md）**：内置 `general-purpose`（全能力）、`explore`（只读研究）、`plan`（只读规划）三种类型；persona 是行为覆盖层，以 `<system-reminder>` 注入子代理 prompt，不改 agent 类型/模型/工具；`isolation: worktree` 用 git worktree 隔离子代理改动；**深度限制=1**（子代理不能再生子代理，防失控扩展）；`resume_from` 延续已完成的子代理会话。
- **质量保障**：hooks 的 **Stop 事件可以阻止 agent 结束回合，直到条件满足（如测试通过）并把原因回喂模型**（10-hooks.md）——把"质量门全绿才算完成"做成 harness 层硬门；`/loop` 定时回归测试；CI（cargo check/test/clippy/fmt）。
- **人机协作**：Plan 审批流（预览/行内评论/修改意见）；TUI 任务面板（Ctrl+G 看子代理与后台任务实时状态）；permission mode 交互式批准 + "always allow" 记忆（按项目持久化）；headless 用于 CI 无人值守。
- **权限与安全（22-permissions-and-safety.md）**：permission mode（ask / auto / acceptEdits / dontAsk / always-approve）+ 规则系统（**deny > ask > allow，deny 永远优先**，跨来源合并后按严重度评估）；危险命令清单（rm / chmod / chown / pkill / git push 等**始终提示**，不受"记住的批准"覆盖）；只读 shell 命令白名单（ls/cat/git status…）；规则不是封闭 allowlist（未匹配的命令落到 mode 兜底）；OS 级 sandbox（18-sandbox.md：Landlock/Seatbelt 应用到整个进程，workspace/read-only/strict 等 profile + `deny` glob 内核级拒绝 + shell 环境变量策略，默认剥掉 `*KEY*/*SECRET*/*TOKEN*`）。
- **记忆（13-memory.md）**：跨会话 markdown 记忆（全局 MEMORY.md / 工作区 / 会话日志）+ 索引搜索；**首轮注入**（新会话自动检索相关记忆注入上下文）；`/flush`（LLM 总结本次会话要点写入日志，压缩前/收尾时用）；`/dream`（定期合并去重）；旧会话记忆带 **staleness 提示**（"先验证再依赖"）。
- **Skills（08-skills.md）**：SKILL.md = YAML frontmatter（description/when-to-use 驱动自动唤起）+ 步骤化指令，把可重复流程沉淀一次、按需加载——"too specific for AGENTS.md but too long to retype"。

### 3. 值得小黑学习的亮点（3-5 条，具体到做法）

1. **Plan 硬约束 + 方案要素结构化**：规划期除方案外不落任何文件（工具层强制，任何权限模式都生效）；方案必须含 Context / 推荐方案 / 关键改动文件 / **需复用的现有实现（带路径）** / **验证方式**——比小黑的"软性说明方案"更强，且方案要素可直接照搬。
2. **安全 deny 优先 + 破坏性操作显式化**：破坏性命令（rm / git push 等）即使任务要求或 allow 规则覆盖也始终提示；"永久/不可恢复"必须显式标注；**自愈与放权不得绕过安全边界**（安全约束 > 自主性）。
3. **跨任务记忆闭环**：任务结束 `/flush` 沉淀要点 → 新会话首轮自动注入 → `/dream` 合并去重。小黑的 learnings.md 就是这个思路的文件版，缺的是"每次任务完成即沉淀"的习惯闭环。
4. **子代理能力边界类型化**：explore/plan 只读、general-purpose 全能力；**深度限制=1** 防失控扩展——派生子代理时先定能力边界（只读 vs 读写），避免子代理越权改文件。
5. **三形态复用同一运行时**：TUI / headless / ACP 共享 agent 运行时，对外形态再多不动核心架构——与"把对外接口多形态化"相反，克制地保持单一核心。

### 4. 与小黑现状对照（已有 / 新增）

- **已有，无需重复落地**：人格/准则注入（= persona 以 system-reminder 注入子代理）；关键节点留快照可回退最近一步（= turn-boundary checkpoint 思想）；质量门全绿才算完成（= Stop hook 硬门）；错误自愈一次再停止（= 错误回喂模型自愈）；不碰密钥/不执行破坏性命令（= 权限 deny 底线）。
- **本次落地 3 条**（见"自我进化记录 #2"）：① Plan 硬约束 + 方案要素结构化；② 安全 deny 优先 + 破坏性/永久操作显式标注 + 自愈不绕过安全边界；③ 跨任务记忆沉淀闭环。

### 5. 参考链接

- 仓库与 README：https://github.com/xai-org/grok-build
- 官方文档：docs.x.ai/build/overview；用户指南（仓库内 `crates/codegen/xai-grok-pager/docs/user-guide/`）：
  19-plan-mode.md / 16-subagents.md / 22-permissions-and-safety.md / 13-memory.md / 18-sandbox.md / 08-skills.md / 10-hooks.md / 20-background-tasks.md / 14-headless-mode.md / 12-project-rules.md
- 关键源码：`crates/codegen/xai-grok-workspace/src/session/checkpoint.rs`（turn-boundary 回滚）

---

## 九、微信文件库与文件发送（任务沉淀 #3，2026-08-20）

> 场景：改写文件库文档并发送给微信用户。沉淀可复用的路径/调用方式，避免下次重新摸索。

- **文件库位置**：`/app/weixin-files`（宿主，gitignored 用户数据目录）= weixin-bridge 容器 `assistant-weixin` 的 `/data/weixin-files`（bind mount，由 `WEIXIN_FILES_DIR` 指定）。宿主直接写文件即入文件库，无需经过 bridge。
- **bridge 访问方式**：weixin-bridge 跑在 Docker 容器内（`infrastructure-weixin-bridge` 镜像，容器名 `assistant-weixin`，端口 3100）；宿主沙箱网络无法直连 `127.0.0.1:3100`（Connection refused），**需用 `docker exec assistant-weixin curl http://127.0.0.1:3100/...` 在容器内调用**。
- **文件库 API**（services/weixin-bridge/src/files.ts + index.ts）：
  - `GET /api/weixin/files` —— 列出文件（name/size/modifiedAt）；
  - `POST /api/weixin/send-file` `{fileName}` —— 同步发送给绑定微信对端，返回 `{ok,sent,size}`；
  - `POST /api/weixin/send-file-async` `{fileName}` —— 异步 job 发送，返回 jobId，进度/完成由微信消息实时推送（agent-server 的 `weixin.send_file` 工具走此接口）；
  - `POST /api/weixin/delete-file` `{fileName}` —— 永久删除（匹配规则：精确/前缀/包含）。
  - 发送前提：bridge 已登录且 `state.json` 有 `account.peerSessions`（本次已有绑定对端，未指定 sessionId 时自动落到第一个绑定对端）。
- **文件名匹配**：`resolveFileByName` 精确 > 前缀 > 包含（大小写不敏感），中文文件名直接传原名即可。
- **入库即 gitignore**：`weixin-files/` 在 `.gitignore` 内，文件库内容不入 git；如需版本化备份，把文档副本放到仓库内目录（如 `xiaohei/`）单独提交。

---

## 十、微信视觉模型切换 DeepSeek（任务沉淀 #4，2026-08-22）

> 场景：微信收图理解从 DashScope qwen3.8-max 切到 DeepSeek 官方视觉模型。沉淀调研与改法，避免下次再踩。

- **调研路径（可复用）**：先 `web_search` 找官方新闻/文档 → 抓官方文档页（api-docs.deepseek.com/zh-cn/guides/vision/）核实模型名/端点/协议 → **用现有 key 调 `GET https://api.deepseek.com/models` 实测模型在列** → **用 1x1 PNG 走真实 `chat/completions` 冒烟**（验证 image_url data URL、Bearer 鉴权、响应结构 `choices[0].message.content`）。三步下来模型存在性/端点/协议全部实锤，不靠猜。
- **DeepSeek 官方视觉模型关键事实**：API 模型 id 是小写 `deepseek-v4-flash-vision-exp`（显示名 DeepSeek-V4-Flash-Vision-Exp，2026-08-21 上线，**实验性 Exp 模型**）；端点 `https://api.deepseek.com/chat/completions`（base_url `https://api.deepseek.com`，OpenAI 兼容；也支持 /v1 前缀与 Anthropic /messages、Responses API）；鉴权 `Authorization: Bearer <DEEPSEEK_API_KEY>`；图片仅可放 `user` 消息，非视觉模型传图返回 400 "This model does not support image"；格式 JPEG/PNG/GIF/WebP，单图 ≤32MiB（data URL 内联整体请求 ≤48MiB）。
- **Key 边界**：DASHSCOPE_API_KEY 只对 DashScope 端点有效；切到 DeepSeek 官方端点后必须用 DEEPSEEK_API_KEY，缺 key 时错误信息要明确点名（不能静默回退，也不能把 DashScope key 打到 DeepSeek 端点拿 401）。
- **配置化改法（YAGNI 最小面）**：vision.ts 暴露 `DEFAULT_VISION_MODEL` / `DEFAULT_VISION_ENDPOINT` 常量 + `describeImage(options)`（endpoint/model 可覆盖）；index.ts 用 `WEIXIN_VISION_MODEL` / `WEIXIN_VISION_ENDPOINT` 环境变量覆盖默认；relay.ts 只透传。**函数名要跟着供应商改名**（describeImageWithDashScope → describeImage），别留说谎的名字。
- **改动连带面**：relay.test.ts 的 fetch mock 是按 URL 匹配的（`dashscope.aliyuncs.com` → `api.deepseek.com`），换端点必须同步；README/.env.example 文档同步更新，避免文档与代码打架。
- **坑：本环境 `NODE_ENV=production`**，`npm install` 默认跳过 devDependencies，typescript/vitest 装不上导致质量门没法跑 → 需 `NODE_ENV=development npm install --include=dev`；npm cache 若遇 EACCES（/root/.npm root-owned），加 `--cache /tmp/npm-cache` 绕开。node_modules 缺失时先 `npm ls <pkg>` 确认再动手，别在空工具链上跑门禁。

---

## 十一、派单硬校验守卫误报修复（任务沉淀 #5，2026-08-22）

> 场景：守卫把"闲聊/未来计划提到派单"误判为"声称已派单未调工具"，反复注入强制补调提示。沉淀"守卫判定模式"的写法教训。

- **守卫位置**：`services/agent-server/src/services/conversation.ts` 的 `DISPATCH_CLAIM_PATTERN`（对 bot 回复文字判"声称派单"）+ L585 注入逻辑；触发条件 = 文本命中模式 且 本轮与请求内历史都无 `engineer.delegate`/`coding.run` 真实调用（`dispatchedLongTask` 跨轮证据）。`services/weixin-bridge/src/relay.ts` 的"已派给小黑"确认是**工具调用驱动**（onLongTaskStarted），不走文本匹配，与守卫无关。
- **误报根因**：模式里混入了**无完成态标记**的分支——`派给小黑`（"有活随时喊我，我派给小黑"命中）、`这就(派|开工)`（"这就派"命中）、`让小黑(去|来|分析|做|处理|搞)`（计划指令句式命中）。关键词匹配"提到派单"≠"声称已派单"。
- **修复模式（可复用）**：守卫文本模式只保留**完成态/进行中断言**，且完成态必须有显式标记：`(?:早?已|已经)+动作`（已派给小黑/已经开工/已经让小黑）、`了`结尾（派出去了/派给小黑了/派|让小黑…了）、进行中锚定主体（任务|小黑|后台 + 正在/在 + 跑|运行|执行）。未来/计划句式（这就/马上/我派给/让小黑去）一律不匹配。
- **防误伤锚定**："正在运行/正在执行"这类泛进行时**不能裸匹配**（"服务器正在运行"会误伤），必须锚定任务/小黑/后台上下文；"正在派给小黑"单独保留（进行中的派单声称本身就该拦）。
- **改动原则**：守卫收紧时，既有的"真漏派必须拦"测试一个都不能红——改模式后用正反例句集（真命中 10 句 + 不应命中 7 句）先做正则自检，再跑全量测试；守卫修复 = 模式收紧 + 补 3 类测试（真派单不拦 / 完成态声称拦截 / 计划闲聊不拦）。
- **后续结论（2026-08-23，本节代码已作废）**：守卫整体删除——`DISPATCH_CLAIM_PATTERN` / `DISPATCH_ENFORCE_PROMPT` / `tool_choice=required` 强制补调全部从 `conversation.ts` 移除，派单交回小夜自主判断（persona `behavior-rules.md` 规定"直接调工具、不自己声称已派单"）。**更大的教训**：靠正则猜模型意图的守卫，收紧到"不误报"就必然漏报，两头都不可靠；真正的约束点应该放在**有事实依据的地方**（工具调用驱动的 `onLongTaskStarted` 确认、工具结果），而不是回复文本。测试也反向锁定：现在校验"含派单表述但用户未下指令时 delegated === 0"。

---

## 十二、Claude Code（anthropics/claude-code）专项分析

> 调研人：小黑；调研日期：2026-08-23；调研方式：GitHub REST API（`/repos/{owner}/{repo}`、contents API）+ raw 文件抓取，无浏览器；官方文档站（code.claude.com/docs）在本沙箱网络不可达，正文依据仓库内一手文件（plugins/commands/examples/CHANGELOG）与 web_search 结果。调研全文：`xiaohei/claude-code-analysis.md`。

### 1. 项目概况

- **仓库**：[anthropics/claude-code](https://github.com/anthropics/claude-code)（Anthropic 官方，142,474 stars / 22,834 forks，2025-02 创建，最近推送 2026-08-22）。API 语言字段为 Python（仓库含 Python hooks），产品本体是 Node.js npm 包 `@anthropic-ai/claude-code`（闭源混淆分发）。
- **许可证**：**专有（非开源）**——LICENSE.md = "© Anthropic PBC… Commercial Terms of Service"，API license 为 null。只可吸收设计，不可复制代码。
- **定位**："agentic coding tool that lives in your terminal"——终端/IDE/GitHub 多形态的 AI 编码工具；扩展能力按 **Commands / Agents / Skills / Hooks / MCP** 五类载体分层，插件市场（marketplace.json）分发、团队共享。
- **仓库布局**：`plugins/`（13 个官方插件范例）· `.claude/commands/`（3 个自用命令）· `examples/settings|hooks|gateway|mdm` · `scripts/` + `.github/workflows/`（issue 自动化运维）· `CHANGELOG.md`（5,759 行，v2.1.x 能力演进旁证）。

### 2. 核心机制（对标小黑的分析维度）

- **扩展四件套（plugins 标准结构）**：`plugin.json`（元数据）+ `commands/` + `agents/` + `skills/` + `hooks/` + `.mcp.json`。命令/代理文件 = **YAML frontmatter（description/argument-hint/allowed-tools/tools/model/color）+ Markdown 正文**。
- **命令级工具白名单（allowed-tools）**：如 `Bash(gh issue view:*)`、`Bash(./scripts/gh.sh:*)`、`mcp__github_inline_comment__create_inline_comment`——命令只能使用白名单工具；正文支持 `!` shell 插值注入实时上下文（git status/diff）。
- **子代理（agents/*.md）**：frontmatter 声明 `tools` 白名单 + `model` 分层（code-review 用 haiku 预检 / sonnet 合规 / opus 抓 bug）+ `color`；feature-dev 提供 code-explorer（只读，返回 5-10 个关键文件）/ code-architect / code-reviewer 三类专业子代理。
- **hooks 事件面（security-guidance/hooks.json 实证）**：`SessionStart` / `UserPromptSubmit` / `PreToolUse` / `PostToolUse` / `Stop`；`matcher` 按工具、`if` 按命令模式（`Bash(git commit:*)`）；**`asyncRewake` + `rewakeMessage`** 后台异步评审完成后唤醒 agent 处理；hookify 把规则降为 **markdown + YAML frontmatter（name/enabled/event/pattern/action: warn|block）** 零代码定义。
- **权限与沙箱（examples/settings 实证）**：`permissions: allow/ask/deny` + `disableBypassPermissionsMode`；规则模式 `Bash(git commit:*)`；sandbox 网络白名单（allowedDomains / unix socket / 本地绑定 / 代理端口）；`allowManagedPermissionRulesOnly` / `allowManagedHooksOnly` 防供应链注入；strict / bash-sandbox / lax 三档预设。
- **质量保障（最有价值）**：code-review 插件**两段式评审**——4 个 agent 并行评审 → 独立验证 agent 复核每条 issue → 只保留 HIGH SIGNAL（"False positives erode trust"）；明确不 flag lint 能抓的/主观的/无法验证的；pr-review-toolkit 按 6 维度拆分评审（含 **silent-failure-hunter 静默失败猎手**）；feature-dev 7 阶段（Discovery → 并行探索 → **Clarifying Questions（DO NOT SKIP）** → 多方案设计 → 批准后实现 → 3 并行 reviewer → Summary）。
- **人机协作与上下文（CHANGELOG 旁证）**：`/goal` 长任务 check-in 退避（30min→1h→2h）+ 会话恢复时恢复 goal；`/cost` + `--max-budget-usd` 预算可见；compaction 提醒与 WebFetch 内容 15 分钟过期（上下文新鲜度）；ralph-wiggum 的 completion-promise（只有陈述完全为真才能输出完成承诺，禁止谎报逃循环）。

### 3. 值得小黑学习的亮点（3-5 条，具体到做法）

1. **澄清先行（feature-dev Phase 3）**：实现前显式列出所有歧义/未定义行为并等待回答，用户说"你决定"时给出推荐并要显式确认——落地为准则 1"待澄清问题 + 最小假设显式化"。
2. **高信号两段式评审（code-review）**：先并行收集再独立验证，只保留"编译/运行必失败、逻辑确定错误、明确违规"，列出"不 flag"清单——落地为准则 4"先验证问题真实性再修，高信号优先，不修假阳性"。
3. **结论分级（code-review + ralph-wiggum 诚实约束）**：断言标注依据等级，完成承诺只在完全为真时给出——落地为准则 6"区分'已确认（有工具结果依据）'与'疑似/推断（未验证假设）'，不夸大结论"。
4. **命令/子代理工具白名单（allowed-tools / agents tools）**：工作流约束在最小工具面，wrapper 脚本进一步收窄（gh.sh）——**harness 层候选**（dsh 派生子代理按角色注入工具面）。
5. **hooks 事件面 + asyncRewake 异步唤醒（security-guidance）**：关键事件挂检查器、后台评审完成再唤醒，不阻塞主流程也不丢问题——**harness 层候选**（同步"质量门前移"已有，异步唤醒需 harness 事件系统）。

### 4. 与小黑现状对照（已有 / 新增）

- **已有，无需重复落地**：Plan/Act 分离 + 批准门（= feature-dev Phase 5 语义）；质量门全绿才算完成（= Stop hook 语义）；错误自愈一次再停止（= 错误回喂模型）；权限 allow/ask/deny（= dsh 权限分层 L0-L3 + ask 审批 + workspace-write 沙箱）；破坏性操作防护（= 准则 7）；跨会话记忆（= 准则 8 learnings.md）；子代理工具面控制（= harness 层已有，白名单粒度可加强）。
- **本次落地 2 条**（见"自我进化记录 #3"）：① 澄清先行 + 假设显式化；② 高信号优先 + 结论分级。
- **harness 层建议（不塞进准则）**：命令/子代理工具白名单、hooks 事件面 + asyncRewake、CLAUDE.md 分层作用域（目录级规则）、sandbox 网络白名单。

### 5. 参考链接

- 仓库与 README：https://github.com/anthropics/claude-code
- 官方文档（沙箱内不可达）：https://code.claude.com/docs/en/overview
- 关键实证文件：`plugins/README.md`、`.claude-plugin/marketplace.json`、`plugins/code-review/commands/code-review.md`、`plugins/feature-dev/commands/feature-dev.md` + `agents/code-explorer.md`、`plugins/security-guidance/hooks/hooks.json`、`plugins/hookify/README.md`、`plugins/pr-review-toolkit`、`plugins/ralph-wiggum/commands/ralph-loop.md`、`.claude/commands/{commit-push-pr,triage-issue,dedupe}.md`、`examples/settings/settings-strict.json`、`CHANGELOG.md`

## 十三、ECC（affaan-m/ECC）专项分析

> 调研人：小黑；调研日期：2026-08-23；调研方式：GitHub REST API（`/repos/{owner}/{repo}`、`/contents/{path}`）+ raw 文件抓取，无浏览器。调研全文：`xiaohei/ecc-analysis.md`。

### 1. 项目概况

- **仓库**：[affaan-m/ECC](https://github.com/affaan-m/ECC)。API 描述："The agent harness performance optimization system. Skills, instincts, memory, security, and research-first development for Claude Code, Codex, Opencode, Cursor and beyond."；242,111 stars / 36,696 forks（2026-08-22 API 返回）；语言 JavaScript；许可证 MIT；主页 https://ecc.tools。
- **定位**：ECC 既不是 Educational Codeforces 也不是椭圆曲线密码学，而是 **Agent Harness 操作系统**——面向 Claude Code/Codex/OpenCode/Cursor/Gemini/Zed/Qwen/Kimi/Hermes/OpenClaw 等十余种 AI 编码代理的工程化系统，一次安装即成为 agent 工作方式的一部分。
- **核心循环**：`plan -> test -> implement -> review -> verify -> remember -> improve`；设计哲学 "**Optimize the context window. Persist everything else.**"。
- **构成**：68 agents（规划/评审/构建修复/安全/架构/领域）、286 skills（TDD/研究/安全/文档/前端/数据/ML/运维）、94 commands、hooks+memory 运行时（强制检查/会话摘要/连续学习/instincts/上下文控制）、rules（按语言选择性常驻）、AgentShield 安全扫描。

### 2. 核心机制（对标小黑的分析维度）

- **五类载体职责分离**（README "Skills keep the context focused"）：Skills 按需加载 / Agents 隔离上下文与工具权限 / Rules 常驻标准（因此要求选择性安装）/ Hooks 上下文外确定性执行 / Instincts 带置信度的会话学习——各管一摊，加能力不把整个仓库倒进每个会话。
- **根目录即唯一事实源**：平台适配器（.claude-plugin/.codex/.cursor/.opencode/…）打包或映射同一套工作流，不维护独立副本。
- **Fresh-context review**："The same context writes and reviews the code" vs "A fresh-context reviewer looks for regressions and blind spots"——写与审分开，评审用独立 reviewer agent（sonnet）从干净上下文看 diff。
- **评审置信度纪律（agents/code-reviewer.md）**：>80% 确信才报告；**Pre-Report Gate 四问**（①能引用确切行 ②能描述具体失败模式 ③已读周边上下文 ④严重性站得住）；HIGH/CRITICAL 必须带证明（片段+行号+失败场景+为何现有防护拦不住）；**零发现是有效结果**；附 Common False Positives 清单（"consider adding error handling"（上游已处理时）/魔法数/缺 JSDoc/N+1（固定基数循环）等）。
- **Instinct 式连续学习（skills/continuous-learning-v2）**：PreToolUse/PostToolUse 观测（100% 可靠）替代 Stop-hook 一次性提取；instinct = 一个触发 + 一个动作 + 置信度（0.3-0.9）+ 域标签 + 证据背书 + 项目作用域；v1 教训："skills are probabilistic—they fire ~50-80% of the time. v2 uses hooks for observation (100% reliable)"；/evolve 聚类升级为 skill/command/agent。
- **上下文预算审计（skills/context-budget）**：agents（>200 行 heavy、description >30 词膨胀）、skills（>400 行）、rules（>100 行）、MCP（每工具 ~500 token schema）、CLAUDE.md 链（>300 行）逐项量化，产出 Always/Sometimes/Rarely 分级与按 token 节省排序的优化建议。
- **AgentShield（security-scan）**：把 harness 配置当攻击面——CLAUDE.md 硬编码密钥/自动执行指令、settings.json 过度授权、mcp.json 供应链风险、hooks 命令注入、agents/*.md 工具暴露过宽；支持最低严重级过滤/多格式报告/auto-fix/CI 集成。
- **证据链交付（README TDD 一节）**："A result is not just code. It's a trail of evidence: the plan, the failing test, the passing test, the review findings, and the final verification."

### 3. 值得小黑学习的亮点（3-5 条，具体到做法）

1. **评审"四问门禁 + 零发现有效"（code-reviewer）**：上报发现前过四问（确切行/失败模式/周边上下文/严重性），HIGH/CRITICAL 必附三件套证据，明确接受零发现——落地为准则 4"四问门禁 + 零发现是有效结果，禁止制造发现"。
2. **学习沉淀"原子化+置信度"（continuous-learning-v2）**：一条经验 = 触发 + 动作 + 证据，区分高置信（跨任务验证）与低置信（单次观察标注待验证），记忆是"未审查上下文"须回溯验证——落地为准则 8。
3. **上下文预算审计（context-budget）**：对每个常驻组件做 token 量化再决定增删——**harness 层候选**（需统计注入成本）。
4. **AgentShield 配置安全扫描**：不信任 agent 配置本身，逐项扫密钥/授权/注入——**harness 层候选**（dsh 对注入的规则/技能/agent 文件做扫描）。
5. **五类载体职责分离 + 证据链**：按加载时机×上下文成本分工；交付物=证据链而非一段代码——证据链已有（准则 6），载体分层为 **harness 层候选**。

### 4. 与小黑现状对照（已有 / 新增）

- **已有，无需重复落地**：Plan/Act 分离 + 方案确认门（= ECC plan→confirm）；质量门全绿才算完成（= Stop hook 语义）；错误自愈一次再停止（= 错误回喂模型）；高信号优先、不修假阳性（= >80% 确信过滤）；结构化报告 + 结论分级（= 证据链 + 分级）；破坏性操作防护（= 准则 7）；跨会话记忆（= 准则 8）；权限分层（= dsh L0-L3）。
- **本次落地 2 条**（见"自我进化记录 #4"）：① 评审四问门禁 + 零发现有效 + HIGH 需证据；② 学习沉淀原子化 + 置信度分级 + 记忆信任边界。
- **harness 层建议（不塞进准则）**：上下文预算审计、AgentShield 式配置安全扫描、hooks 确定性质量门（dsh 已有部分）、五类载体分层注入。

### 5. 参考链接

- 仓库与 README：https://github.com/affaan-m/ECC
- 关键实证文件：`README.md`（Why Choose ECC / What's Inside / Key Concepts）、`agents/code-reviewer.md`、`agents/planner.md`、`skills/continuous-learning/SKILL.md`（v1 归档）、`skills/continuous-learning-v2/SKILL.md`、`skills/context-budget/SKILL.md`、`skills/security-scan/SKILL.md`、`hooks/hooks.json`、`research/ecc2-codebase-analysis.md`

---

## 十四、团队建设：招了小优（运维工程师子代理 ops.delegate）

> 记录人：小黑；记录日期：2026-08-22；依据：本次"招新"任务实施结果。

### 1. 团队现状

- **小夜（助理）**：服务器老大、监督者，负责派单与汇报闭环。
- **小黑（engineer.delegate）**：工程师子代理，专业严肃，负责开发/改代码（异步派单，`services/agent-server/src/services/engineer-tools.ts` + `engineer-task-runner.ts`）。
- **小优（ops.delegate）**：新招的运维工程师子代理（DevOps/SRE），女性，调皮可爱型（"皮归皮，活要漂亮"），负责管理整个服务器：监控、部署、巡检、故障处理、安全、自动化；权限为全权限（danger-full-access），与小夜同级，但小夜是她的上级。

### 2. 实现要点（复用与差异）

- **复用 dsh 底盘**：小优同样由 `runDshHeadless` 驱动（`coding-tool.ts` 导出），`XIAO_YOU_PROMPT` 注入运维人格与工作准则，`buildXiaoYouTask` 包装任务单——与小黑同构，成本极低。
- **关键差异 1：权限模式**。小黑走 `workspace-write`（工作区沙箱）；小优管整台服务器，走 `danger-full-access`（全权限）。`RunDshOptions.permissionMode` 类型就是 `'workspace-write' | 'danger-full-access'`，直接用字面量即可。
- **关键差异 2：同步 vs 异步**。engineer.delegate 用 `EngineerTaskRunner` 异步派单（立即返回 taskId，后台跑、事件推送）；ops.delegate 直接同步 `await runDshHeadless`（如 `createCodingTool` 模式），调用后阻塞到小优跑完返回结构化报告，`timeoutMs` 放宽到 1 小时。理由：运维任务通常是单发指令等结果（"巡检一下""看下磁盘"），同步语义简单直接；若后续需要并发/后台跑长任务，可仿 EngineerTaskRunner 演化。
- **路由与主页**：`/xiaoyou` 静态欢迎页（`routes/xiaoyou.ts`，ESM 用 `import.meta.url` 向上 4 级定位 `/app/xiaoyou`），与 `/xiaohei` 同一套懒加载+缓存写法；**静态欢迎页必须加进 `auth.ts` 的 `EXEMPT_PATHS` 免 token 名单**（精确匹配），否则浏览器直接打开会 401——这是本次踩到的一个坑（先跑测试 500/401 才意识到）。

### 3. 沉淀经验（高置信：本次已验证）

1. **新子代理落地五件套**：人格 Prompt（`buildXxxTask` 包装）→ Tool 注册（`index.ts`）→ 专属文件夹 + 欢迎主页 → 路由 + auth 免 token 名单 → 测试 + CHANGELOG + 记忆沉淀。按此清单可快速复制第三个子代理。
2. **runDshHeadless 两种用法**：同步（createCodingTool 模式，阻塞等结果）与异步（EngineerTaskRunner 模式，后台 + 事件）。选型看任务形态：单发指令等结果用同步，长任务/不阻塞对话用异步。
3. **测试不触达 dsh**：子代理工具测试只覆盖"缺参/空参/目录不存在"等前置校验与静态属性（name/permissionLevel/schema），有效任务执行不测（会真实 spawn dsh）——与 engineer-tools.test.ts 异步注入 runner 不同，ops 是同步工具无法注入，靠前置校验兜底。
4. **新静态路由的隐藏坑**：加路由只是第一步，`auth.ts` 的免 token 名单漏加会让页面在 token 模式下 401——测试用 `app.inject` 走 token 配置用例才能暴露。
