# Leon（leon-ai/leon）架构分析 —— 对"世界第一 AI 工作室"三名成员的借鉴

> 分析人：小黑（工程师子代理）
> 日期：2026-08-23
> 数据来源：GitHub API + develop 分支源码（raw.githubusercontent.com / api.github.com），抓取时间 2026-08-23；README 来自 master 分支。
> 结论分级：本文「已确认」条目均有工具结果依据（API 返回 / 源码文件行）；「疑似/推断」条目显式标注。

---

## 一、Leon 项目概况

| 项 | 值（已确认，GitHub API 2026-08-23 抓取） |
|---|---|
| 仓库 | leon-ai/leon |
| 描述 | "🧠 Leon is your open-source personal assistant."（开源个人助理） |
| Stars / Forks | 17,455 / 1,464 |
| 语言 | TypeScript（含 Python bridge） |
| License | MIT |
| 默认分支 | develop（README 在 master 分支，内容指向 develop） |
| 状态 | 未归档；README 声明核心正在 TypeScript 重写（1.0.0-beta-8 起），重写期间暂停接受外部贡献 |

**定位**：可自托管（含全离线模式）、以隐私为先的开源个人 AI 助手，核心价值在"技能（Skills）"体系——用户/社区可编写技能扩展能力，核心只有一个。

**架构认知修正（重要）**：任务背景描述的"core、skills、stt/tts、nlp、管道"是 Leon 旧版（Python + NLP.js 意图识别）的心智模型；当前 develop 分支已是 **TypeScript 重写版**，架构更接近现代 agent harness：`core/` 下是 brain / nlu / toolkit-registry / tool-executor / llm-manager / memory-manager / context-manager / session-manager / self-model-manager / pulse-manager / asr / tts / voice 等模块。README 亦明确：NLU 仍以"intents first + 自有模型"为主，LLM 用于 intent fallback / NER / 技能生成等增强（非全 LLM 驱动），但代码里已出现完整的 LLM 路由（smart/controlled/agent 三种模式）与 ReAct duty。本分析以 develop 分支实际代码为准。

---

## 二、核心架构与值得借鉴的设计

### 2.1 模块装配：单例注册 + 多 profile 代理（core/index.ts，已确认）

`core/index.ts` 把 LLM_PROVIDER / LLM_MANAGER / CONVERSATION_LOGGER / TOOL_CALL_LOGGER / TOOLKIT_REGISTRY / TOOL_EXECUTOR / PERSONA / CONTEXT_MANAGER / MEMORY_MANAGER / SELF_MODEL_MANAGER / PULSE_MANAGER / POST_TURN_MAINTENANCE_QUEUE / ASR / TTS / NLU / BRAIN 统一注册为单例，其中大多数经 `createProfileServiceProxy` 按 profile 隔离（不同用户配置不同实例）。通信层 = HTTP server + Socket server（实时对话/流式）+ TCP client（连 Python bridge）+ Satellite（工具执行扩展到其他设备）。

**借鉴点**：单例装配 + 按用户隔离 + 实时事件通道，与我们 agent-server 的 ToolRegistry/事件推送思路一致；其"卫星（satellite）"把工具执行下沉到其他设备的模式，可类比我们"云服务器 + 微信通道"的分工。

### 2.2 对话管道：路由模式 + 技能工作流 / ReAct 双路径（core/nlp/nlu/nlu.ts，已确认）

`NLU.process` 是核心入口，流程：

1. **路由决策**（`getRoutingDecision`，行 831）：`routing.mode` ∈ `smart | controlled | agent`。
   - `controlled` → 走"技能工作流"路径（结构化、可预测）；
   - `agent` → 直接走 ReAct 路径（`runReAct`，行 853，ReActLLMDuty 62KB：思考 → 工具调用 → 观察，循环）；
   - `smart` → 默认 controlled，按需可降级。
2. **技能选择**（`chooseSkill`，行 288）：只有一个技能启用时直接选中；否则 `SkillRouterLLMDuty` 让 LLM 从"可用技能清单"里选一个，**输出严格格式**（只输出技能名或 `None`，禁止解释/标点），路由失败走 `handleProviderFailure`。
3. **动作选择**（`chooseSkillAction`，行 353）：`ActionCallingLLMDuty` 结合最近 utterance / actionArguments / 已收集参数，输出 JSON 格式的 action 调用列表。
4. **工作流编排**（`handleSkillWorkflow`，行 529）：技能可在 `skill.json` 声明 `workflow: ["action_a", "action_b", ...]`，按序执行；支持跨技能跳转（`skill:action`）；无参的下一动作立即执行，有参的等待用户补参（`handleActionMissingParams` 缺参追问）。
5. **执行**：`LogicActionSkillHandler` / `DialogActionSkillHandler` 分派到具体实现（Python/Node bridge）。
6. **回答输出**（Brain.talk）：`AnswerQueue` FIFO + 100-350ms 随机"自然打字延迟" + is-typing 事件；`ParaphraseLLMDuty` 对实质回答做 LLM 润色（跳过条件：动作带 loop/slots 配置、字数 < 5、估算 token > 1024，避免确定性错误和超长回答被改写，行 232-273）。
7. **回合后维护**（`PostTurnMaintenanceQueue`，已确认）：回答已经产生后，后台 LLM 维护（self-model 回合观察、会话标题生成、记忆写入）**串行化排队执行**（`enqueueIfNeeded` 先做轻量资格检查），不与自己竞争、不阻塞对话。

**借鉴点**：① 路由模式显式化（可控 vs 自主）；② 独立"路由/选动作"子任务 + 严格输出格式（可解析、可校验）；③ 回答润色带跳过条件（不破坏确定性内容）；④ 回合后维护队列串行化。

### 2.3 技能系统：结构化声明 + 双实现形态（skills/、core/toolkit-registry.ts，已确认）

- **技能**（`skills/native/*/skill.json`，如 todo_list_skill）：JSON 声明 `name / icon_name / bridge(python|nodejs) / version / description / author / actions`；每个 action：`type`（`logic` | `dialog`）、`description`、`parameters`（带类型与描述）、`optional_parameters`；有 `$schema`（`schemas/skill-schemas/skill.json`）做校验；配套 `locales/`（多语言）、`test/`（技能测试）、`memory/`（技能专属记忆）、`config/`。
- **元技能**：`skill_writer_skill` 用 OpenCode CLI 从自然语言描述**自动生成完整技能**（create_skill / modify_skill 两个 action）——"能写技能的技能"。
- **工具（Toolkit）**：`toolkit.json`（name/description/icon_name/context_files/tools）→ 每 tool 一个 `tool.json`：`tool_id / name / description / functions`，function 带 `description / parameters / output_schema / hooks.post_execution.response_jq`（用 jq 对输出做结构化后处理）。`ToolkitRegistry` 从内置目录 + 用户 profile 目录合并加载，支持卫星 toolkit。
- **动态可用性**（`resolveToolAvailability`，行 705）：工具加载时解析"是否可用"——settings 缺失（记录 `missing_settings` + `settings_path`）、profile 禁用、LLM provider 能力不匹配（如 hosted search 仅 openai/anthropic）都会标记不可用并给出**原因与修复路径**；`ToolExecutor.executeTool` 对不可用工具返回 `not_available/error + missing_settings + settings_path`，让上层（LLM/用户）能据此引导配置，而不是盲试。
- **渐进式工具加载**：`runtime.progressive_toolkit_loading: true` —— function schema 只在需要时加载，减少上下文占用。

**借鉴点**：① 一切能力（技能/工具）都有结构化 schema（描述/参数/输出），且可被 LLM 消费；② 可用性/依赖显式化——"缺什么配置、去哪里补"直接告诉上层；③ 元技能（生成技能的技能）；④ 输出后处理钩子（response_jq）——工具输出 → 结构化结果，与我们的 ToolResult 思想一致。

### 2.4 记忆与上下文：多层记忆 + 模块化上下文文件 + 自我模型（core/memory-manager、context-manager、self-model-manager，已确认）

- **MemoryManager**（66KB）：persistent / daily / discussion / archive 多层记忆；写入去重（内容 hash + token Jaccard 相似度判断近重复，`isNearDuplicatePersistentContent`）；recall 带 `topK` + `tokenBudget`（执行期 token 预算，防上下文爆炸）；`shouldRecallForQuery` 先判断查询是否有足够检索价值；软删除（forgetById）；镜像完整性自修复（`repairMissingMemoryMirrors`，迁移/自愈两种触发）。
- **ContextManager + 15 个 context file**：activity / architecture / browser-history / gpu-compute / habits / home / host-system / leon / leon-runtime / local-inventory / media-profile / network-ecosystem / owner / storage / system-resources / workspace-intelligence —— 每个文件把"某一类事实"（用户画像、系统资源、习惯、活动…）渲染成 markdown 注入上下文；启动按优先级自适应延迟加载（`getAdaptiveBootInitialDelayMs`），周期性后台刷新（`refreshContextFilesAtBootInBackground`），可整体禁用（`disabled_files: ["*"]`），并支持按 toolkit 关联取上下文（`getContextForToolkit`）。
- **SelfModelManager**（30KB）：每回合 `observeTurn(userMessage, assistantMessage, sentAt, route, finalIntent)` 观察；定期 `maybeReflectTurn` 让 LLM 对近期回合做反思并产出结构化 `ReflectionPatch` 更新自我模型状态；维护行为原则（`reinforceBehavioralPrinciple`）、主动性候选（initiative）、复盘条目（retrospection）；有私人日记（private diary，明示"勿打开"）。`getSnapshot()` 把自我模型摘要注入上下文。
- **PulseManager**（48KB）：自主脉冲——非对话时段周期性生成"pulse matter"（待办事项）并自主执行：有执行冷却（`getExecutionCooldownRemainingMs`）、指纹去重（`computeFingerprint`）、抑制策略（`hasRecentOwnerActivity` 检测对话中不打扰）、观察主人反馈（`observeOwnerUtterance`）。相当于"没人在聊天时，助手自己推进自己的任务"。

**借鉴点**：① 记忆按作用域分层 + token 预算防爆；② 上下文注入模块化（按主题拆分文件、可禁用、可刷新）；③ 回合级观察 + 定期反思（自我模型）；④ 自主脉冲带冷却/去重/对话抑制（不自嗨、不打扰）。

### 2.5 会话与配置（core/session-manager、config.sample.yml，已确认）

- **SessionManager**：多会话；`createSession / updateSession / deleteSession / setActiveSession`；`generateTitleFromFirstMessage` 用 LLM 自动生成会话标题；`runWithSession` 会话作用域执行；每会话独立串行队列（`sessionQueues`，防并发写日志）。
- **配置（config.sample.yml）**：语言、server、routing（mode）、llm（`default` + per-mode override：workflow/agent + 多 provider：openai/anthropic/groq/llamacpp/sglang/openrouter/zai/minimax…，密钥经 `env` 引用 profile .env，不落盘）、mood（`auto | default | tired | cocky | sad | angry`，情绪模式）、runtime（pulse_enabled / private_diary_enabled / progressive_toolkit_loading）、context（disabled_files）、availability（skills/tools 的 allowed/disabled 白黑名单）。
- **LLM 路由**（core/llm-manager/llm-routing.ts，已确认）：区分 `workflow` target 与 `agent` target（不同模式用不同模型），支持本地模型（llamacpp/sglang，模型可为本地路径）；`ResolvedLLMTarget` 携带 `isEnabled / isResolved / resolutionError` 显式暴露"模型不可用/未解析"状态。
- **LLM Duty 抽象**（core/llm-manager/llm-duty.ts，已确认）：所有 LLM 子任务统一抽象为 duty（summarization / translation / paraphraser / action-calling / skill-router / slot-filling / react），每个 duty = name + systemPrompt + input + init/execute，配置集中管理（temperature / maxTokens / thoughtTokensBudget）。

**借鉴点**：① 配置按主题分组 + 密钥与配置分离（env 引用）；② LLM 目标显式解析状态（可用/未解析/禁用）；③ 对话子任务（duty）抽象，职责单一、可复用、可测。

---

## 三、三名成员各自的"可优化点"清单

> 对照维度：Leon 的做法（已确认）→ 我们目前的做法 → 差距 → 建议落地层（准则层 = 改 XIAO_*_PROMPT/persona；harness 层 = 改 agent-server/工具代码；代码层 = 项目代码）。

### 3.1 对小黑（工程师子代理）

#### 优化点 1：任务模板化 —— 按任务类型（修复/功能/调研/重构）套结构化执行模板
- **Leon 做法**：一切能力都是"结构化 schema"——skill.json 里每个 action 声明 description / parameters / optional_parameters，配 `$schema` 校验与 `test/` 目录；工作流可声明为有序 action 序列。
- **我们目前做法**：`XIAO_HEI_PROMPT` 是 8 条通用准则（确认目标 → 基线 → 小步实现 → 自愈 → 质量门 → 报告 → 安全 → 沉淀），没有"按任务类型组织输入/步骤/验证/产出物"的模板。每次任务从零组织。
- **差距**：同类型任务（修 bug / 加功能 / 调研）的执行路径重复发明；任务输入（复现步骤/期望行为/影响面）经常缺项，导致中期返工。
- **建议落地（准则层，本次落地）**：在 XIAO_HEI_PROMPT 增加"任务模板化"准则——开工前先判任务类型（缺陷修复/功能开发/调研分析/重构优化），按模板明确 输入（复现/需求原文/相关文件）→ 步骤（读码→方案→小步改→测）→ 验证标准（typecheck+test/复现用例）→ 产出（报告/改动清单）；模板内可复用既有经验（learnings.md）。

#### 优化点 2：工具执行纪律 —— 编辑/执行前确认目标，输出后校验结果（对应 Leon ToolExecutor 生命周期）
- **Leon 做法**：ToolExecutor.executeTool 有完整生命周期：resolveToolById → availability 检查 → 参数解析（JSON）→ mapArgs（按 schema 映射）→ 执行 → response_jq 后处理 → 日志记录 → 统一 buildResult（success/error/not_available/invalid_input）。工具不可用给出原因+修复路径。
- **我们目前做法**：小黑有"每步断言以工具结果为依据"（准则 4），但没有"执行前确认输入完整、执行后校验输出结构"的显式纪律。
- **差距**：偶发"没读清参数就执行"、"工具返回非预期结构未察觉"。
- **建议落地（准则层，可后续）**：增加"调用工具前先确认输入/目标文件存在，执行后先看返回再断言；结果与预期不符立即记录"。

#### 优化点 3：记忆分层 —— 任务内临时上下文 vs 跨任务长期记忆
- **Leon 做法**：MemoryManager 分 persistent/daily/discussion 层；recall 带 tokenBudget；上下文注入模块化（ContextManager 15 个文件、可禁用、按 toolkit 关联）。
- **我们目前做法**：小黑只有 learnings.md 一份长期记忆（跨任务沉淀），任务内调研结论放工作区文件，没有"任务内草稿/结论"与"长期经验"的显式分层。
- **差距**：任务内结论可能混入 learnings.md（过早沉淀、置信度不足）；或调研过程不落盘、重启丢失。
- **建议落地（准则层，可后续）**：调研阶段结论先落任务内临时文件（如 `/tmp` 或工作区 `.notes`），只有验证过、可复用的才进 learnings.md（延续"原子化+置信度"已有规则）。

#### 优化点 4：回合后复盘 —— 完成即回顾（对应 Leon SelfModel.observeTurn + PostTurnMaintenanceQueue）
- **Leon 做法**：每回合后 observeTurn，周期反思生成 patch 更新自我模型；后台维护串行化不阻塞对话。
- **我们目前做法**：小黑"任务完成后沉淀 learnings.md"（准则 8），但沉淀与报告同时做，缺少"先交付报告、再独立复盘"的节奏。
- **差距**：反思与交付混在一起，报告写完就结束，复盘质量不稳定。
- **建议落地（准则层，可后续）**：报告交付后独立走一遍"本次任务：哪些做得好/哪些返工/哪条经验可复用"，再决定是否沉淀。

### 3.2 对小优（运维子代理）

#### 优化点 1：操作前"前置条件自检" —— 依赖/配置缺失先报告，不盲试
- **Leon 做法**：ToolkitRegistry.resolveToolAvailability 在工具加载时解析可用性，缺 settings 记录 missing_settings + settings_path，执行时返回"不可用 + 原因 + 修复路径"，上层据此引导。
- **我们目前做法**：XIAO_YOU_PROMPT 准则 3 有"操作前先检查现状（系统状态、端口、进程、磁盘、服务健康）"，但未要求"形成明确的前置条件清单，缺失项显式报告后再动手"。
- **差距**：检查停留在"看看状态"，缺少"该操作需要哪些前置（服务在跑？端口空闲？配置文件在？权限够？磁盘余量？），逐项核对、缺了就报"的清单式自检。
- **建议落地（准则层，本次落地）**：在 XIAO_YOU_PROMPT 增加"前置条件自检"——执行任何操作前先列出该操作的前置条件清单（服务/端口/配置/权限/磁盘），逐项核对，缺失项先报告（附证据）再决定是否继续；不盲试。

#### 优化点 2：操作留痕可回放 —— 每次操作记录"命令 + 结果"，报告可追溯（对应 Leon ToolCallLogger）
- **Leon 做法**：TOOL_CALL_LOGGER.recordToolCall 记录每次工具调用（toolkit/tool/function/params），tool-calls.json 保留最近 8 条。
- **我们目前做法**：小优报告有【操作清单】（命令/动作 + 结果），但没有要求"关键操作按时间顺序留痕、可回放"（如操作前状态快照 → 命令 → 结果 → 操作后状态）。
- **差距**：故障排查/回滚时缺少可回放的操作序列，只能靠记忆。
- **建议落地（准则层，可后续）**：高危操作（重启/删数据/改防火墙）执行前先留"操作前快照"，执行后记录结果与"操作后状态"，报告中按时间线给出可回放序列。

#### 优化点 3：巡检统一状态快照 —— 先取基线再比对（对应 ContextManager system-resources context file）
- **Leon 做法**：context-files/system-resources-context-file.ts 等把系统资源/网络/存储等状态渲染成标准上下文，周期性刷新、可对比。
- **我们目前做法**：小优巡检是"当时看当时记"，没有"统一状态快照模板"（进程/端口/磁盘/负载/服务健康一屏拿全）。
- **差距**：多次巡检之间不可比对，异常判定靠经验。
- **建议落地（harness 层，可后续）**：沉淀一份"巡检快照命令集"（如 system.status 已有能力 + 磁盘/端口/负载），巡检先取全量快照，再定位问题。

#### 优化点 4：定时任务防抖与抑制 —— 冷却 + 去重（对应 PulseManager）
- **Leon 做法**：PulseManager 自主执行带执行冷却（cooldown）、指纹去重、对话中抑制（hasRecentOwnerActivity），避免重复打扰。
- **我们目前做法**：小优有定时巡检（reminder/task 调度），但没有"同一检查任务在短周期内不重复执行"的显式防抖意识。
- **差距**：重复触发同类告警/操作时可能重复处理同一问题。
- **建议落地（准则层，可后续）**：定时/重复任务先查上次执行时间与结果，短期内同一问题不重复处理，确需重试时说明原因。

### 3.3 对小夜（私人助理）

#### 优化点 1：技能/工具路由显式化 —— 有清单、有规则、不确定先问（对应 SkillRouterLLMDuty）
- **Leon 做法**：chooseSkill 用独立 LLM duty 从"可用技能清单"选技能，输出严格格式（技能名或 None）；只有一个技能时直接选中；路由失败走 handleProviderFailure。
- **我们目前做法**：小夜的工具选择是对话内隐式的（LLM 直接决定调哪个工具），行为准则里只有"简单查询优先轻量工具"等局部规则；没有"可用工具清单 + 路由规则"的显式心智模型。
- **差距**：偶发"该派单没派/不该派也派"（behavior-rules 里已有"派单前禁止说已派"的事故教训，说明路由判断不稳）；工具不可用（如云工具未配置）时没有"先说明再问"的习惯。
- **建议落地（准则层，可后续）**：在 persona 行为准则增加"工具路由"条目：先想"这个需求对应哪个工具"，工具不可用/不确定时明确说明并问用户，不硬调、不假装已执行。

#### 优化点 2：上下文注入分层 —— 画像/事件/状态按需注入（对应 ContextManager）
- **Leon 做法**：15 个 context file 按主题拆分（owner 画像、habits、system-resources…），可禁用、周期刷新、按 toolkit 关联注入。
- **我们目前做法**：小夜 persona 已是模块化 markdown（identity/personality/speaking-style/behavior-rules/self-development/refinements，FilePersonaProvider 组装）；会话期上下文靠 profile（画像）、timeline（事件）工具按需取，但没有"哪些上下文该常驻、哪些该按场景注入"的显式策略。
- **差距**：上下文注入偏"全量常驻 persona + 按需查"，缺少"轻量常驻 + 场景化注入"的分层。
- **建议落地（harness 层，可后续）**：把"用户画像关键事实"与"最近事件时间线"做轻量摘要常驻注入，细节按需查；对照 Leon 的 context-files 拆分思路审视 persona 各文件是否过重。

#### 优化点 3：会话管理强化 —— 自动标题 + 会话作用域（对应 SessionManager）
- **Leon 做法**：多会话 + generateTitleFromFirstMessage 自动标题 + runWithSession 作用域 + 每会话串行队列。
- **我们目前做法**：agent-server 有 Session 概念（会话存储、恢复），但没有"按首条消息自动生成会话标题"的能力（用户侧靠手写/默认）。
- **差距**：多会话切换时辨识度低。
- **建议落地（harness 层，可后续）**：会话创建时用 LLM 生成一句话标题（复用 ConversationService，属小功能，风险低）。

#### 优化点 4：回答个性化分层 —— 润色/长度阈值（对应 ParaphraseLLMDuty）
- **Leon 做法**：对实质回答做 LLM 润色，但带跳过条件（确定性错误、loop/slots 配置、过短<5 词、过长>1024 token 不润色），保证确定性内容不被改写。
- **我们目前做法**：小夜说话风格靠 persona（speaking-style.md + behavior-rules 的"沟通简洁"），无程序化阈值。
- **差距**：风格控制全凭 prompt，无"短回答不加工、长回答按风格压缩"的确定性兜底。
- **建议落地（准则层，可后续）**：在 behavior-rules 补充：简短确认/确定性信息不加工（直接说结果），长说明按人设压缩到要点——把 Leon 的"跳过条件"翻译成行为准则。

#### 优化点 5：多语言 —— 跟随用户语言（对应 locale/answers.json 体系）
- **Leon 做法**：language 配置 + 每语言 answers.json 模板回答 + skill locales + TTS 语言切换。
- **我们目前做法**：小夜中文为主，未见显式语言跟随策略。
- **差距**：用户切语言时无一致跟随机制（疑似，未实测）。
- **建议落地（准则层，可后续）**：行为准则补一句"用户用什么语言，就用什么语言回复"（低风险，若已是事实则属冗余，落地前先验证）。

---

## 四、落地吸收内容（本次已落地）

选 2 条最有价值且可落地的（对应上面 3.1-优化点1、3.2-优化点1）：

1. **小黑 · 任务模板化**（Leon skill.json 结构化声明 → XIAO_HEI_PROMPT 新增准则）：
   - 开工前先判定任务类型（缺陷修复 / 功能开发 / 调研分析 / 重构优化），按"输入 → 步骤 → 验证标准 → 产出物"模板组织；输入缺关键信息先列出，不硬做。
2. **小优 · 前置条件自检**（Leon Toolkit availability 显式化 → XIAO_YOU_PROMPT 新增准则）：
   - 执行任何操作前先列出该操作的前置条件清单（服务在跑？端口空闲？配置就位？权限够？磁盘余量？），逐项核对，缺失先报告（附证据）再决定是否继续，不盲试。

两处均落在准则层（prompt 文本），改动面小、可回滚（git 基线）、有测试断言守护；harness/代码层改动留给后续迭代。

---

## 五、风险与建议

- **已确认**：以上所有 Leon 事实均来自 GitHub API 与 develop 分支源码（文件+行号见正文）；未抓到的（如 react-llm-duty.ts 全文、memory-manager 全文）仅基于已下载源码的方法签名扫描，未逐行读全。
- **疑似/推断**：Leon 的 mood（情绪）系统、pulse 自主机制的完整行为细节未深读，仅从配置与结构推断；小夜多语言跟随为"疑似缺失"（未实测）。
- **风险**：本次落地只改 prompt 文本与测试断言，不触碰业务逻辑；XIAO_HEI/YOU_PROMPT 被 buildXiaoHeiTask/buildXiaoYouTask 注入 dsh，行为变化需在真实派单中观察。
- **建议**：后续按 3.1/3.2/3.3 清单逐项落地（工具执行纪律、记忆分层、操作留痕、巡检快照、工具路由显式化、会话自动标题等），每项独立小步提交，避免一次大改。
