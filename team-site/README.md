# 世界第一 AI 工作室 · 团队官网项目

> 目标：做一个正规专业的团队官网，参考 [完美世界《异环》官网](https://yh.wanmei.com/main.html)（要求风格/UI 一致），技术栈 React 18（前端）+ Node.js/Express（后端，CEO 2026-08-22 确认用 Node，不装 Java）+ nginx（部署）。
> 团队梦想：**世界第一 AI 工作室**。成员：小黑（工程师）、小优（运维）、小夜（助理）。

## 阶段边界

- **Phase 1（已完成）**：参考网站分析 + 技术方案 + 设计规范 + 素材规划 + 小黑自画像（只做分析与文档，不写代码、不生成素材、不碰 API key）。
- **Phase 2（已完成）**：素材生成——首页视频（MiniMax H3）+ 三成员形象图 + 世界全景图 + 都市映像图，产物在 `assets/`（参数依据 `docs/assets-plan.md` 与 learnings §十五/§二十）。
- **Phase 3（当前，已完成）**：**React 前端 + Node/Express 内容 API + nginx 配置**（本阶段只写代码与配置，**不部署、不占用 80 端口**）。
- Phase 4（待办）：部署上线（nginx 托管 dist + `/api/*` 反代，见 `nginx/nginx.conf`）。

## 目录结构

```
team-site/
├── README.md                  # 本文件
├── docs/                      # 规划与契约文档
│   ├── reference-analysis.md  # 参考网站分析
│   ├── architecture.md        # 技术方案（Phase 1 规划，Phase 3 落地后同步）
│   ├── style-guide.md         # 设计规范 Design Tokens
│   ├── content-model.md       # 页面模块 + 数据字段契约（前后端共同依据）
│   ├── assets-plan.md         # 素材规划
│   └── seedance-5.0-pro-api.md# Seedance 调研（已切 MiniMax H3）
├── characters/                # 角色定义（每人自写自己的）
├── assets/                    # 原始素材（生成物，已入库）
├── frontend/                  # Phase 3：React 18 + Vite + TS
│   ├── src/                   #   tokens.css / api / components / pages / router
│   ├── public/assets/         #   素材副本（roles/worlds/cities/videos）
│   └── dist/                  #   构建产物（nginx 托管，不入库）
├── backend/                   # Phase 3：Node.js + Express 5 内容 API（8080）
│   ├── src/                   #   data.js / app.js / server.js
│   └── test/                  #   api.test.js（node:test）
└── nginx/                     # Phase 3 已写配置 / Phase 4 部署
    └── nginx.conf             #   listen 80 + SPA fallback + /api 反代
```

## 本地运行

```bash
# 后端（端口 8080，监听 0.0.0.0）
cd backend && npm install && npm start
# 验证：curl http://127.0.0.1:8080/api/roles  curl http://127.0.0.1:8080/api/news?type=work

# 前端（开发：Vite dev server，/api 代理到 8080）
cd frontend && npm install && npm run dev
# 构建产物：frontend/dist
cd frontend && npm run build
```

## API 契约（见 docs/content-model.md 字段定义）

| 端点 | 说明 |
|---|---|
| `GET /api/news?type=all\|work\|join\|complaint` | 情报速递（默认 all，按 date 倒序；兼容中文别名：做了什么/入职/牢骚/谁入职了/谁发牢骚了/全部） |
| `GET /api/roles` | 角色列表（3 人） |
| `GET /api/worlds` | 世界全景（工作环境） |
| `GET /api/cities` | 都市映像（愿景） |
| `GET /health` | 健康检查 |

## 关键约定

1. **角色形象提示词每人自写自己的**：小黑 ✅；小优、小夜 ✅（本人自写，见 `characters/*.md`）。
2. **导航栏**：首页 / 情报速递 / 角色介绍 / 世界全景 / 都市映像（**无登录、无充值中心、无下载**）。
3. **设计基调**：深色（#1d1d1d 系）+ 青色主强调（#50e5fb）+ 首屏背景视频，忠实参考站风格；标题切图改 CSS 文字、整页 Swiper 改路由 + 全屏区块（可维护性优先，偏离点见 architecture.md §6）。
4. **素材**：首页视频 = MiniMax H3（模型 `MiniMax-H3`，参数依据 learnings §二十 实测经验）；形象图/场景图 = doubao-seedream-5-0-pro-260628（参数依据 learnings §十五 实测经验）。`frontend/public/assets/` 为副本（由 `assets/` 复制，sha256 校验一致）。
