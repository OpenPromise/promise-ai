# Promise AI · 一个人，六位 AI 同事

> **我们不演示未来，我们运行现在。**

这是一个**真实运行中**的 AI 工作室 Monorepo：一位人类创始人（CEO），与六位各司其职的 AI 同事。

它不是概念演示，也不是开源玩具——这里的每一行代码都在生产环境运行，每一位成员都有真实的工作职责、工作区、文档与产出。你看到的官网、成员主页、自动化巡检、微信对话，都是这套系统自己跑出来的。

---

## 团队成员

| 成员 | 角色 | 一句话 |
| --- | --- | --- |
| 👤 创始人 | 唯一的人类 · CEO | 提出方向、做出决定、承担后果 |
| 🌙 小夜 | 私人助理 · 团队中枢 | 所有对话从她开始，也由她收束 |
| ⚙️ 小黑 | 软件工程师 | 只对工程质量负责，不闲聊、不卖萌 |
| 🛠️ 小优 | 运维 / SRE | 皮归皮，活要漂亮 |
| 🎨 小美 | 产品 / UI / 视觉设计师 | 好设计不是漂亮，而是让用户自然地完成任务 |
| ✅ 小真 | QA 工程师 | 没有证据的「能用」，等于不能用 |
| 📚 小知 | 研究员 / 情报官 | 先看清世界，再动手改变它 |

每位成员都有自己的工作区目录与个人主页：

```
xiaoye/   小夜 · 私人助理（团队中枢）
xiaohei/  小黑 · 工程师
xiaoyou/  小优 · 运维
xiaomei/  小美 · 设计
xiaozhen/ 小真 · QA
xiaozhi/  小知 · 情报
```

成员定义与自述见 [`team-site/characters/`](./team-site/characters/)。

---

## 系统架构

```
┌─────────────────────────────────────────────────┐
│  用户（微信）                                    │
└──────────────┬──────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────┐
│  services/weixin-bridge   微信桥（唯一客户端通道）│
└──────────────┬──────────────────────────────────┘
               │
┌──────────────▼──────────────────────────────────┐
│  services/agent-server    Agent Server（小夜）   │
│  会话 · 流式聊天 · 工具调用 · 权限分级            │
└──────────────┬──────────────────────────────────┘
               │ 派单
   ┌───────────┼───────────┬───────────┬─────────┐
   ▼           ▼           ▼           ▼         ▼
 小黑工程师   小优运维    小美设计    小真 QA    小知情报
 (dsh)       (dsh)      (dsh)      (dsh)      (dsh)
```

- **小夜**（Agent Server）是大脑：理解需求、检索记忆、拆解任务、派单给最合适的同事。
- **五位同事**（工程师 / 运维 / 设计 / QA / 情报）通过 dsh（DeepSeek Harness）执行具体工作，各自拥有专属工作区。
- **权限分级 L0–L3**：只读操作自动放行，高危操作必须确认，密钥只通过 `.env` 注入。

---

## Monorepo 结构

```text
├── services/
│   ├── agent-server/        # Agent Server：会话 + 流式聊天 + 工具调用（小夜）
│   └── weixin-bridge/       # 微信 ClawBot 桥（唯一客户端通道）
├── packages/
│   ├── core/                # Agent Context / Persona 抽象
│   ├── protocol/            # 统一消息协议
│   ├── types/               # 共享领域类型
│   ├── config/              # 环境变量统一管理
│   ├── llm/                 # LLM Provider 抽象（OpenAI 兼容流式）
│   ├── openrouter/          # OpenRouterProvider（LLM 聚合网关）
│   ├── elevenlabs/          # STT/TTS 语音抽象
│   ├── qwen-realtime/       # 实时语音 Agent
│   ├── memory/              # 记忆系统（长期记忆 / 画像 / 目标 / 时间线）
│   └── tools/               # 工具抽象与注册表
├── persona/                 # 小夜的人格系统（修改即时生效）
├── team-site/               # 团队官网（React 18 + Vite + TS）
│   ├── frontend/            #   官网前端（纯静态，可独立构建）
│   ├── backend/             #   内容 API（Express）
│   ├── characters/          #   成员定义与自述
│   ├── assets/              #   素材（形象 / 场景 / 视频）
│   └── nginx/               #   部署配置
├── xiaoye/ xiaohei/ xiaoyou/ xiaomei/ xiaozhen/ xiaozhi/
│                            # 各成员工作区与个人主页
├── infrastructure/          # Docker Compose / PostgreSQL / systemd
├── docs/                    # 架构与运维文档
└── scripts/                 # 运维与调试脚本
```

---

## 技术栈

- **语言 / 工程**：TypeScript Monorepo（npm workspaces）、Node.js ≥ 20
- **LLM**：Qwen（DashScope）/ DeepSeek / OpenRouter，可切换
- **语音**：ElevenLabs STT / TTS
- **通道**：微信（桌面端已下线）
- **记忆**：长期记忆 / 用户画像 / 长期目标 / 事件时间线
- **官网**：React 18 + Vite + TypeScript
- **部署**：Docker + nginx + systemd（腾讯云轻量服务器）

---

## 快速开始

```bash
npm install
cp .env.example .env    # 填入你自己的 API Key
npm run infra:up        # 启动 PostgreSQL
npm run dev             # 启动 Agent Server（默认 :3000）
```

> ⚠️ 所有密钥通过 `.env` 注入，已被 `.gitignore` 排除，**永不入库**。
> 请勿提交任何 `.env` 文件或真实密钥。

---

## 官网

`team-site/` 是团队官网，由小美设计、小黑构建——包括这句话。

- 前端为纯静态站点（数据内联），可独立构建后托管到任意静态平台（GitHub Pages / nginx）。
- 成员个人主页由各成员自己维护（`xiaoye/` 等目录）。

---

## 文档

- [`AGENTS.md`](./AGENTS.md) — 架构参考策略与阶段规划
- [`docs/architecture.md`](./docs/architecture.md) — 系统架构说明
- [`CHANGELOG.md`](./CHANGELOG.md) — 变更记录
- [`team-site/README.md`](./team-site/README.md) — 官网项目说明

---

## 许可与说明

- 本项目为私人 AI 助理系统，公开仓库用于展示团队与工程实践。
- 任何第三方服务（LLM / 语音 / 云）均为按需接入，可通过抽象层替换。
- 复制一份数据很容易，但**真正运行的团队在服务器上**——而它属于创始人与每一位成员。

---

© 2026 Promise AI · 本站由 AI 设计、生成并构建 —— 包括这句话。
