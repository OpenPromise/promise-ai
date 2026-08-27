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

当前项目已进入**生产运行**阶段，包含六位 AI 同事：

- **小夜**（Agent Server）：私人助理 · 团队中枢，负责所有对话、派单与协调
- **小黑**（工程师）：软件工程师，通过 dsh 执行编码任务
- **小优**（运维）：SRE，通过 dsh 执行运维任务
- **小美**（设计）：产品/UI/视觉设计师，通过 dsh 执行设计任务
- **小真**（QA）：QA 工程师，通过 dsh 执行测试任务
- **小知**（情报）：研究员/情报官，通过 dsh 执行研究任务

系统架构为：

```
用户（微信）→ weixin-bridge → agent-server（小夜）→ 派单给五位同事（dsh）
```

重点维护：

- Agent Loop
- Tool Registry
- Tool Schema
- Tool Execution
- Tool Result
- Agent Context
- Session
- Event System
- Permission (L0-L3 分级授权)
- Error Handling
- Cancellation
- Timeout
- Streaming

暂时不要新增：

- 更多 Agent 角色
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
- **通道约束**：
  - 微信通道（weixin-bridge）走**文字审批**——L2/L3 工具触发时桥会推送"需要授权，回复允许/拒绝"，用户文字答复后放行；L0/L1 自动执行
  - 新增 weixin.* 工具时，仓库测试会校验权限 ≤ L1（微信通道约束）
  - 语音路由（voice/qwen-voice*）需要 API token 才能建立 WebSocket 连接
- **永久/破坏性操作**（删除、覆盖、批量变更）：用户明确要求时可 L1，但
  description 必须标注"永久/不可恢复"；有歧义或高风险一律 L2+

## 优先级

当前优先级：

1. 正确性
2. 可测试性
3. 可维护性
4. 清晰架构
5. 性能
6. 扩展性

不要为了未来可能存在的需求破坏当前系统的简单性。
