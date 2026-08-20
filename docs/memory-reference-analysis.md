# 记忆架构参考分析：Letta vs Mem0

> 检索日期：2026-08-20。对照目标：本项目「用户画像 + 长期记忆」模块
> （user_profiles / memories / sessions + profile.* / memory.* 工具）。
> 依据架构参考政策：只吸收架构与设计，不复制代码。

## 两个项目的核心架构

### Letta（MemGPT，lettai/letta-code）

记忆分三层，核心思想是「让模型自己维护自己的记忆」：

- **Core memory（核心记忆）**：永远在上下文里的结构化块（persona / human 等），
  由 agent 通过记忆工具（append/replace/remove）在对话中自编辑——相当于
  我们的 `user_profiles` + `profile.set`
- **Archival memory（归档记忆）**：外部存储，按需检索（向量/关键词）——
  相当于我们的 `memories` 表 + `memory.search`
- **Recall memory（回忆记忆）**：可查询的对话历史——相当于我们的 `sessions`
- **Memory pressure（记忆压力）**：core memory 太大时触发压缩/合并，
  防止上下文膨胀；配合对话 recap 整理

### Mem0（mem0ai/mem0）

记忆管道的核心是**两阶段 infer**（`add(messages, infer=true)`）：

1. **抽取阶段**（FACT_RETRIEVAL_PROMPT）：LLM 从**用户消息**里抽取事实/偏好，
   有严格质量门：只记用户说的话、忽略寒暄（"Hi" → 空）、按类别
   （偏好/个人细节/计划/职业/健康/杂项）、保持用户语言
2. **更新阶段**（DEFAULT_UPDATE_MEMORY_PROMPT）：把新事实与现有记忆对比，
   明确四选一——**ADD / UPDATE / DELETE / NONE**，同义不重复
   （"喜欢芝士披萨" vs "超爱芝士披萨" → 不更新）、矛盾则更新/删除、
   保留信息量最大的表述

配套：记忆按 `user_id / agent_id / run_id` 隔离；向量存储 + 嵌入 + 混合
检索（BM25 + 语义）+ 重排；每个记忆项有 id / event / old_memory 可审计。

## 对照：我们已有什么

| 层级 | Letta 概念 | 我们现状 |
|---|---|---|
| 对话历史 | Recall | sessions（Postgres）✅ |
| 长期记忆检索 | Archival | memories（向量 + 关键词 RRF）✅ |
| 结构化画像 | Core memory | user_profiles（key-value + category）✅ |
| 自编辑记忆 | 记忆工具 in-loop | profile.set / list / forget ✅ |
| 上下文注入 | core memory 进 system prompt | collectPersistentContext ✅ |
| **自动抽取** | —（Letta 靠模型自觉） | ❌ 依赖模型主动调 profile.set，不可靠 |
| **更新/冲突决策** | — | ❌ 按 key 覆盖，无语义对比 |
| **抽取质量门** | — | ❌ 无（会把闲聊/噪音记进去） |
| **记忆整理/压缩** | Memory pressure | ❌ 画像只增不减，注入上限 30 条但无人整理 |
| **变更审计** | — | ◐ 有 updatedAt，无事件（ADD/UPDATE）记录 |

## 可吸收点（按价值排序）

### P0：对话后自动抽取画像（Mem0 两阶段核心）

现状：模型记住用户信息靠「人设引导 + 自觉」，会漏记、记错、记噪音。
改进：每次对话结束后异步跑一次轻量抽取（deepseek-v4-flash）：

1. 取本轮的**用户消息**（最多最近几条）
2. 抽取 prompt 输出结构化画像增量 `[{key, value, category}]`
3. 与现有画像对比做 ADD/UPDATE/DELETE/NONE 决策（携带现有画像进 prompt）
4. 写回 user_profiles

关键设计：**异步 fire-and-forget**（不阻塞用户回复）、失败静默、
节流（每会话限频）。这正是 Mem0 `add(infer=true)` 的架构，落到我们
单用户场景可以很薄。

### P1：抽取质量门（Mem0 FACT_RETRIEVAL_PROMPT 准则）

- 只从用户消息抽取，忽略 assistant/system 内容
- 寒暄/一次性陈述不记（"今天天气不错" → 空）
- 按类别：事实 / 偏好 / 习惯 / 语气倾向（我们已有 category）
- 保持用户语言（中文进中文）

### P1：画像整理/压缩（Letta memory pressure）

- 画像条目设上限（如 60 条）；超限或定期触发 `profile.compact`：
  让模型合并重复项、归档陈旧项、精简表述，保持注入的画像精炼
- 避免"越记越多、上下文越塞越满"的慢性膨胀

### P2：变更审计（Mem0 event / old_memory）

- 每条画像记录最后事件（ADD/UPDATE）+ 旧值，profile.list 可回看变化

### P2：作用域（Mem0 user_id/agent_id/run_id）

- 当前单用户恒为 default；未来多用户/多设备再引入 scope，
  共享画像反而更好（同一主人跨设备），暂不做

## 实施路线

1. **先做 P0**：新增 `profile.ingest`（对话后异步抽取+决策），
   在 conversation chat.done 后触发；复用 deepseek-v4-flash 便宜 prompt；
   全链路可测（mock LLM）
2. 再补 P1 质量门 prompt 与 `profile.compact` 整理工具
3. 可选 P2 审计字段
