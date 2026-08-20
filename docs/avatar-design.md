# 可成长 Avatar 设计（多端统一）

> 来源：用户开发计划《AI私人助理：可成长固定底模3D Avatar系统》
> 核心理念：**同一个固定数字生命体，通过长期记忆与人格成长，参数化地
> 慢慢改变外观；不是反复生成新角色。**
> 多端要求：电脑 / 网页 / 手机 / 任何能访问的地方都能看到同一个 Avatar。

## 1. 多端方案：Avatar 是"服务端网页"，不是桌面组件

Avatar 渲染为一个**由服务器托管的网页**（`GET /avatar`），任何设备
（PC 浏览器、手机浏览器、平板、甚至桌面端用 iframe 内嵌）打开同一个
URL，看到的是**同一份服务端 Avatar 状态**：

```text
http://122.152.209.182:3000/avatar   ← 任意设备浏览器打开
```

- 渲染：Three.js + @pixiv/three-vrm，加载固定 `public/avatar/base-avatar.vrm`
- 状态：`GET /api/avatar/state`（基因组 + 当前表情/临时风格）
- 实时同步：`/api/avatar/events`（SSE）或复用 ws——所有打开的页面在
  表情/进化发生时同步更新
- 写入：`POST /api/avatar/emotion`（表情）、进化只走服务端 Evolution
  Engine，网页端**只能看不能改**（Avatar Controller 只渲染）
- 微信限制：微信内置浏览器 WebGL 支持有限，可在对话里给用户发链接，
  用系统浏览器打开；不影响"任何地方都能看"的目标

## 2. 与现有项目的能力映射

| 用户计划 | 我们已有 / 需要新增 |
|---|---|
| 记忆抽取 | ✅ ProfileIngestor（对话后自动抽取用户事实/偏好） |
| 长期记忆 | ✅ memories（向量+关键词）+ timeline（事件时间线） |
| 人格 | ✅ persona/*.md（身份/性格/行为/语气）+ 每日回顾 |
| 偏好引擎 | ◐ 画像有 key/value；**新增"置信度积累"**（一次=低置信，多次=稳定） |
| Avatar Genome | ❌ 新增 `avatar_genome` 表 + AvatarStore |
| Evolution Engine | ❌ 新增：证据→置信→评分→阈值→渐变→事件 |
| Avatar Controller | ❌ 新增（浏览器端，只渲染） |
| 工具 | ❌ 新增 avatar.state / avatar.history / avatar.propose_evolution / avatar.preferences |

## 3. 数据模型（4 张表）

### avatar_genome（数字基因，单行）

```ts
interface AvatarGenome {
  identity: { id: string; baseModel: string; version: number }; // 永远固定
  appearance: {
    hairColor: number; hairLength: number; hairStyle: number;
    eyeColor: number; eyeSize: number;
    clothingStyle: number; clothingColor: number;
    cyberStyle: number; cuteStyle: number; minimalStyle: number;
    accessoryLevel: number;
  }; // 0~1，只允许小步渐变
  personality: {
    calm: number; curiosity: number; playfulness: number;
    seriousness: number; confidence: number;
  };
  evolution: { generation: number; totalInteractions: number; lastEvolutionAt: string };
}
```

### avatar_preferences（候选偏好 + 置信度积累）

```ts
interface AvatarPreference {
  id: string;
  parameter: string;      // hairColor / minimalStyle ...
  direction: 1 | -1;      // 朝哪个方向
  source: 'user' | 'ai';  // 用户偏好 或 AI 自己的偏好
  confidence: number;     // 0~1，证据越多越高
  evidenceCount: number;
  consistency: number;    // 最近证据里同向比例
  firstSeenAt: string;
  lastSeenAt: string;
}
```

### avatar_evolution_events（成长史，可回答"你为什么变成这样"）

```text
id | timestamp | parameter | old_value | new_value
  | reason | confidence | evidence_ids
```

### avatar_state_history（每次状态快照，可选，用于回放）

## 4. Evolution 机制（严格渐进）

用户说一次"我喜欢蓝色" → 只产生：

```text
{ parameter: "hairColor", direction: +1, confidence: 0.3, evidenceCount: 1 }
```

几十次同向证据 → confidence 0.92 → 才触发 Evolution 提案。

**EvolutionScore = PreferenceStrength × EvidenceCount × Consistency × TimeFactor × AIConfidence**

- < 0.5 不变；0.5~0.75 小幅；0.75~0.9 稳定；> 0.9 形成长期特征
- 每次 delta 被钳制在 ±0.08 内（渐变，禁止 0.2→1.0）
- 阈值可配置（.env：AVATAR_EVOLVE_*）

**执行路径**：

```text
聊天 → ProfileIngestor 抽取
   ↓
AvatarPreference 记录证据（user/ai 双源）
   ↓
Evolution Engine 定时评估（每日回顾任务触发）
   ↓
超过阈值 → 程序验证 + 小步应用 → avatar_genome 更新
   ↓
写 avatar_evolution_events → /api/avatar/events 广播 → 所有端同步
```

LLM 只能 `propose_avatar_evolution`（提案带 changes/confidence/permanence/
evidenceIds），**应用与否由程序验证**；禁止直接改 3D。

## 5. AI 自己的审美（关键原则）

Avatar = **用户偏好 + AI 人格 + AI 自己的偏好**，不是用户喜欢什么就变成什么。

- AI 自己的偏好：从 persona 种子初始化（如默认 minimal/tech 倾向），
  通过成长与"自我表达"形成（对话里说"我最近好像越来越喜欢这种风格"）
- `avatar.preferences` 工具同时暴露 user 源与 ai 源，AI 可感知自己的审美

## 6. Agent 工具

- `avatar.state`（L0）：当前基因组 + 表情 + 临时风格
- `avatar.history`（L0）：成长史（"你为什么变成现在这样"）
- `avatar.preferences`（L0）：用户偏好 + AI 自身偏好
- `avatar.propose_evolution`（L1）：提案（程序校验阈值/渐变/永久性）

禁止提供：change_mesh / regenerate_avatar / generate_new_character。

## 7. 三态分离

| 状态 | 周期 | 影响 |
|---|---|---|
| Emotion（表情/眨眼/说话/动作） | 即时 | 只动 BlendShape/动画，不改基因组 |
| Temporary Style（近期话题配饰/服装小元素） | 短期可衰减 | 可随时间衰减 |
| Permanent Identity（长期稳定偏好） | 永久 | 才允许改 AvatarGenome |

## 8. 实现阶段（对齐用户 5 阶段，Web 化）

### Phase 1：固定 VRM 网页渲染
- 服务器新增 `public/avatar/base-avatar.vrm` + `/avatar` 页面
- Three.js + three-vrm + AvatarController：眨眼 / 说话动嘴 / 微笑 /
  表情切换 / 基础动画；手机浏览器可用（响应式 + 触摸旋转）

### Phase 2：Genome + 状态 + 历史（先不用 AI）
- avatar_genome / avatar_preferences / avatar_evolution_events 三表 + AvatarStore
- 页面上放测试按钮：+蓝色 / +科技感 / +可爱 / +极简（走服务端小步应用，
  证明"参数化变化"在多端稳定生效）

### Phase 3：接 LLM
- ProfileIngestor 抽取结果喂给 AvatarPreference（user 源）
- persona 种子生成 ai 源偏好
- avatar.* 工具 + Evolution Engine 评估

### Phase 4：自动成长
- 每日回顾任务里顺带跑 Evolution Engine
- 稳定变化自动小步应用 + 广播到所有端

### Phase 5：AI 设计新资产（最后才做）

**已实现（2026-08）**：可替换资产 preset 系统——AI 设计新发型/服装/
配饰/风格，Avatar 在 preset 间参数化切换，不重新生成底模。

- `avatar_assets` 表：type（hair/clothing/accessory/style）、名称、
  说明、外观参数覆盖（0~1）、程序生成的 SVG 预览（data URL）、来源、
  状态（active/archived）、使用次数
- `avatar_active_assets` 表：每类资产当前穿着的一件（type → asset_id）
- 有效外观 = 数字基因 + 资产覆盖（固定顺序 hair→clothing→accessory→
  style，同参数后者胜出）；资产不改数字基因，随时可换回
- 工具：`avatar.assets`（L0 查看衣橱）/ `avatar.design_asset`（L1 设计
  并入库，程序校验参数）/ `avatar.apply_asset`（L1 穿上）/
  `avatar.clear_asset`（L1 脱下恢复基因外观）
- 页面 `/avatar` 右侧新增「衣橱」面板：预览图 + 试穿/默认按钮，
  换装结果通过 SSE 广播到所有打开的页面
- 未来可选：接入真实 3D 资产生成时，只替换 preview 与网格层，
  参数化结构与工具无需改动

## 9. 复用清单

- ProfileIngestor（抽取）→ 扩展喂偏好证据
- timeline（事件）→ avatar_evolution_events 独立，但可在时间线留成长记录
- 每日回顾任务（22:00）→ 同时评估进化
- events SSE + weixin 推送 → avatar 变化可推送通知（"我换了新发型"）
- persona → AI 审美种子与主动表达
- 数据库模式（Postgres/InMemory 双实现 + init 建表）→ 照搬 profile/timeline 模式

## 10. 参考项目分析（用户推荐 5 项）

### NVatar（nskit-io/nvatar）—— 理念最接近，重点吸收

架构：avatar-chat（角色提示词）/ chat-like-human-memory（记忆+情绪+人格）/
customize-local-llm（本地人格+云端事实混合）/ vrm-studio（Three.js+WS 聊天房）/
nvatar-sdk（可插拔行为模式）。可吸收：

- **9D 情绪 + decay/commit**：情绪是连续维度，对话中变化、自然衰减；
  人格经过数周稳定后"提交"（commit）才固化——正是我们的
  Emotion(即时) / Temporary(可衰减) / Permanent(进化阈值) 三态机制
- **三层记忆**：原始消息 → 事件摘要 → 渐淡关键词，像人脑记忆——
  对应我们 sessions(原始) / timeline(摘要) / memories(语义)
- **活动密度分级 T1~T4**：T4 长闲置时 LLM-free 逻辑积累记忆；
  每天至少积累一条记忆事件（Daily narrative backbone）——
  我们已有"每日回顾"任务，直接对齐
- **Avatar OS 状态原则**：主命令/自我决策/UI 事件走同一条状态变更路径，
  只记录"为什么"不同——进化/表情/临时风格统一走 Avatar State 单一入口
- **Rest → compaction**：进入休息态时自动压缩长期记忆（我们的 profile.compact）

### ChatdollKit（uezo/ChatdollKit）—— LLM→角色行为状态机

- `AIAvatar.cs`：完整行为生命周期（Disabled/Sleep/Idle/Conversation）、
  唤醒词/打断词/barge-in、会话超时回到 Idle——Avatar 行为状态机参考
- VRM 扩展：`VRMBlink`（自动眨眼）、`VRMFaceExpressionProxy`（表情）、
  `VRMuLipSyncHelper`（口型）、`VRMLoader`
- `ChatMemoryTool`：function-calling 的记忆检索（我们已有 memory.search）
- `ActionHistoryRecorder`：动作历史记录（可回放）

### three-vrm（pixiv/three-vrm）—— 3D 底层核心

- VRM 表达式是 **preset 驱动**（happy/angry/relaxed/sad/surprised…）
  经 VRMExpressionManager → BlendShape —— 情绪状态直接映射 preset
- `three-vrm-animation`：Mixamo/VRM 动画 clip 加载（动画复用）
- 我们直接用：`@pixiv/three-vrm` + Three.js，Avatar Controller 包一层

### CharacterStudio（M3-org/CharacterStudio）—— 固定底模 + 参数化

- 材质颜色参数化（favouriteColors）+ animationManager + BlendShape——
  印证"固定底模 + 参数修改"路线；genome.appearance → material/BlendShape 映射参考

### VRoid AI Companion（anjaydo/vroid-ai-companion）—— 网页 VRM 最佳实践

- Next.js + R3F + @pixiv/three-vrm + Zustand：
  `Avatar.jsx` 加载 VRM、Mixamo 动画重定向、口型同步
- `useAdvanceLipSync.ts`：**FFT 频谱 → viseme → VRM 表情**（音频驱动口型）——
  Phase 1 "说话动嘴"可直接吸收
- `utils/remapMixamoAnimationToVrm.js`：Mixamo→VRM 骨骼重定向
- 前后端分离（FastAPI + Supabase）与我们服务端架构一致

## 11. 结论：我们优先吸收

1. **9D 情绪 + 自然衰减**（NVatar）——Emotion State 做成连续维度
2. **decay/commit 人格固化**（NVatar）——对应进化阈值的"提交"语义
3. **统一状态变更路径**（NVatar Avatar OS）——所有变化走 Avatar State
4. **preset 表情映射**（three-vrm）——emotion → VRM preset → BlendShape
5. **FFT 口型同步**（VRoid）——说话动嘴
6. **自动眨眼/呼吸/空闲动画**（ChatdollKit/vrm-studio）——基础生命力
