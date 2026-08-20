# 「她的世界」设计（AI 活在游戏世界 —— 路线 A）

> 目标：让 Promise AI 不只存在于聊天窗口，而是"活"在一个有位置、有
> 时间、有日常活动的世界网页里；多端可看、可互动，世界状态与对话
> 互通（她知道自己在哪、在做什么）。
>
> 参考：AI Town（a16z）的世界模型 + Agent tick 行动循环、Project AIRI
> 的多端数字生命体形态、Generative Agents 的记忆/计划架构思想。

## 1. 范围（刻意裁剪）

- **单角色世界**：世界里只有她（+ 用户作为访客），不做多 Agent 小镇
  （AGENTS.md：暂时不要实现多 Agent）
- **程序驱动活动循环**：默认活动按时间段自动推进，零 LLM 成本；
  需要个性表达时由她在对话里通过 world.act 主动切换
- **不引入新技术栈**：延续 Postgres/InMemory 双存储 + Fastify + three-vrm

## 2. 数据模型（1 张表）

### avatar_world（单行 jsonb）

```ts
interface AvatarWorldState {
  id: string;          // 'default'
  location: string;    // 卧室/客厅/书房/厨房/阳台
  activity: {
    kind: 'sleeping'|'working'|'reading'|'eating'|'walking'
         |'resting'|'chatting'|'custom';
    label: string;     // 在做什么（人类可读）
    emoji: string;
    location: string;
    startedAt: string;
    until: string;     // 到期后回到时段默认
  } | null;
  daysLived: number;
  totalActions: number;
  lastTickAt: string;
  updatedAt: string;
}
```

## 3. 活动循环（WorldService）

- 活动表 WORLD_SCHEDULE：24 小时分 8 个时段（深夜睡觉 🌙 → 晨光咖啡 ☕
  → 上午工作 💻 → 午饭 🍜 → 下午看书 📖 → 晚霞 🌆 → 沙发聊天 🛋️
  → 睡前日记 🕯️）
- 心跳：服务启动立即 tick 一次，之后每 15 分钟一次
- 规则：
  1. 手动活动（world.act）未到期 → 保持
  2. 到期或没有手动活动 → 按时段切换（不同才写事件）
  3. 每次切换：更新 avatar_world + 写 timeline（type: 'world'）
     + SSE 广播到所有 /world 页面
- 手动 act 支持位置关键词识别（「去阳台吹风」→ location=阳台），
  保留 durationMin 分钟（默认 30，最大 240）后回到时段默认

## 4. Agent 工具与权限

- `world.state`（L0）：她当前在哪个房间、在做什么、活了几天
- `world.act`（L1）：让她做一件事（可逆、非破坏，只改世界状态；
  微信通道可用）

## 5. 对话互通

- collectPersistentContext 注入世界状态：「以下是你在『她的世界』里的
  实时状态……她在阳台看晚霞（持续到 18:00）」
- 回答"你在哪/你在干嘛"直接引用；用户说"去床上躺着"她会调 world.act

## 6. 多端网页 /world

- Three.js 房间：地板/地毯/窗户/床/书桌/书架/绿植/挂画（暖色调）
- 加载 base-avatar.vrm，她站在房间中央，眨眼/呼吸/轻微转头
- 左上：实时状态卡（emoji + 活动 + 时间 + 天数 + 行动数 + 持续到几点）
- 右上：她的今天（world 时间线）
- 底部：输入框"让她做点什么"（POST /api/avatar/world/act）
- SSE `/api/avatar/world/stream` 实时同步所有打开页面

## 7. API

```text
GET  /world                          ← 她的房间网页
GET  /api/avatar/world               ← 世界状态
GET  /api/avatar/world/events        ← 今日活动流（timeline type=world）
POST /api/avatar/world/act           ← 让她做一件事
GET  /api/avatar/world/stream        ← SSE 广播
```

## 8. 后续（不做，仅记录）

- 多 Agent 小镇（AI Town 全量 world model + 社交状态机）
- 世界里的物品/天气/季节变化
- 让她在"世界时间"里主动给你发消息（结合常驻意图监听）
