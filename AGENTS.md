# Architecture Reference Policy

本项目允许参考以下开源项目：

1. OpenClaw
2. Mastra
3. LiveKit Agents
4. LiveKit Agents JS
5. ElevenLabs Agents SDK
6. OpenDex（语音优先桌面代理，仅借鉴 computer-use 循环工程、任务级权限
   授权、Realtime 委托与音频响应主题等设计，不复制其 Electron/React 外壳）
7. OpenCrabs（Rust 终端 Agent，仅借鉴 LLM 多后端故障转移、记忆混合检索
   RRF、重启恢复上报、反馈台账与启动摘要等设计，不复制其 Rust 代码）
8. Prime Agent（RLM/Continual Harness，仅借鉴持久目标、预算化自主模式、
   证据驱动的 /refine 持续改进与回滚快照等设计，不复制其代码）
9. AI Town（a16z-infra/ai-town，仅借鉴世界模型 + Agent tick 行动循环、
   Operation 异步队列/超时、对话状态机、记忆摘要/反思/加权检索设计，
   不复制其 Convex/PixiJS 外壳）
10. Project AIRI（moeru-ai/airi，仅借鉴数字生命体形态：多端 Stage、
    VRM 呈现、游戏世界代理（Minecraft/Factorio）与记忆插件设计，
    不复制其代码）
11. Generative Agents（joonspk-research/generative_agents，仅借鉴
    memory stream / recency-importance-relevance 检索 / reflection /
    每日计划架构思想，不复制其 Python 代码）

## 参考原则

这些项目只能作为架构参考，不允许直接复制大量代码。

在实现功能之前：

1. 阅读对应项目的相关模块。
2. 分析其架构和设计目的。
3. 比较它与当前项目架构的差异。
4. 只吸收对当前阶段有价值的设计。
5. 保持当前项目已有架构的一致性。

## 当前阶段

当前项目处于 Phase 5：Agent Core。

重点研究：

- Agent Loop
- Tool Registry
- Tool Schema
- Tool Execution
- Tool Result
- Agent Context
- Session
- Event System
- Permission
- Error Handling
- Cancellation
- Timeout
- Streaming

暂时不要实现：

- 多 Agent
- 电话
- SIP
- 车机
- Home Assistant
- 大规模 Workflow
- 复杂 RAG
- 复杂 UI

## 禁止过度工程化

不要因为参考项目存在某个抽象，就复制该抽象。

如果一个功能可以通过：

Agent → ToolRouter → Tool → Result

完成，就不要额外创建多层 Manager / Factory / Orchestrator。

新增抽象必须回答：

1. 解决什么问题？
2. 为什么当前代码无法解决？
3. 是否有真实使用场景？
4. 是否可以用更简单的方式实现？

如果不能回答，禁止新增抽象。

## 新增工具权限准则

- 每个新工具必须显式选择 `permissionLevel` 并在方案/提交说明理由
- **通道约束**：微信通道（weixin-bridge）对 L2/L3 自动拒绝——供微信会话
  使用的工具只能是 L0/L1；桌面通道按既有权限表（L0 读取 / L1 常规文件 /
  L2 敏感 / L3 系统级）
- **永久/破坏性操作**（删除、覆盖、批量变更）：用户明确要求时可 L1，但
  description 必须标注"永久/不可恢复"；有歧义或高风险一律 L2+
- 新增 weixin.* 工具时，仓库测试会校验权限 ≤ L1（微信通道约束）

## 优先级

当前优先级：

1. 正确性
2. 可测试性
3. 可维护性
4. 清晰架构
5. 性能
6. 扩展性

不要为了未来可能存在的需求破坏当前系统的简单性。
