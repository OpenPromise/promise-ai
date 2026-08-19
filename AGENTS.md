# Architecture Reference Policy

本项目允许参考以下开源项目：

1. OpenClaw
2. Mastra
3. LiveKit Agents
4. LiveKit Agents JS
5. ElevenLabs Agents SDK
6. OpenDex（语音优先桌面代理，仅借鉴 computer-use 循环工程、任务级权限
   授权、Realtime 委托与音频响应主题等设计，不复制其 Electron/React 外壳）

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

## 优先级

当前优先级：

1. 正确性
2. 可测试性
3. 可维护性
4. 清晰架构
5. 性能
6. 扩展性

不要为了未来可能存在的需求破坏当前系统的简单性。
