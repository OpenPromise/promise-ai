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
- Image/3D 生成只产出"可替换资产"（新发型/服装/配饰 preset），
  不重新生成 Avatar；生成后入库，Avatar 可在 preset 间参数化切换

## 9. 复用清单

- ProfileIngestor（抽取）→ 扩展喂偏好证据
- timeline（事件）→ avatar_evolution_events 独立，但可在时间线留成长记录
- 每日回顾任务（22:00）→ 同时评估进化
- events SSE + weixin 推送 → avatar 变化可推送通知（"我换了新发型"）
- persona → AI 审美种子与主动表达
- 数据库模式（Postgres/InMemory 双实现 + init 建表）→ 照搬 profile/timeline 模式
