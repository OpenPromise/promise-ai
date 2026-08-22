# 团队官网技术方案（Phase 1 规划，Phase 3 落地后已同步）

> 记录人：小黑；日期：2026-08-22；本文件为 Phase 1 规划，Phase 3（2026-08-22）落地时按 CEO 决策同步更新：**后端由 SpringBoot 改为 Node.js + Express**（CEO 明确"后端用 Node，不装 Java"），拓扑与目录随之调整，页面/API 契约不变。

## 1. 架构方案：React + Node/Express + nginx 部署拓扑

```
                    ┌────────────────────────────────────────────┐
   浏览器 ──HTTPS──▶│  nginx（80/443）                            │
                    │  ├─ /            → frontend/dist 静态资源   │
                    │  └─ /api/*       → 反向代理 → Node:8080     │
                    └────────────────────────────────────────────┘
                                        │  http://127.0.0.1:8080
                                        ▼
                              ┌────────────────────┐
                              │ Node/Express 内容 API│
                              │  /api/news /api/roles│
                              │  /api/worlds /api/cities│
                              │  数据：DB(后续) / 内存静态数据(MVP) │
                              └────────────────────┘
```

- **前端**：React 18 + Vite（脚手架方案）+ TypeScript + React Router；构建产物 `frontend/dist` 由 nginx 直接托管。
- **后端**：Node.js + Express 5（CEO 2026-08-22 确认用 Node，不装 Java），提供只读内容 API（新闻/角色/世界/都市），MVP 阶段数据为内存静态数据（`backend/src/data.js`），后续可换 DB。
- **nginx**：静态托管 + 单一路由 `/api/*` 反代到 Node 后端；SPA 路由 fallback（`try_files ... /index.html`）。
- 部署拓扑与仓库内既有架构（promise-ai）解耦：team-site 是独立子项目，独立 git 目录可后续抽出（见 §6 待澄清）。

## 2. 目录结构建议

```
/app/team-site/
├── README.md                 # 项目总览 + 阶段边界 + 文档索引
├── docs/                     # 本阶段规划文档（Phase 1）
│   ├── reference-analysis.md # 参考网站分析
│   ├── architecture.md       # 本文件（技术方案）
│   ├── style-guide.md        # 设计规范（Design Tokens）
│   ├── content-model.md      # 页面模块细化 + 数据字段
│   └── assets-plan.md        # 视频/图片素材规划
├── characters/               # 角色定义（形象提示词 + 梦想）
│   ├── xiaohei.md            # 小黑（工程师）——本人自写 ✅
│   ├── xiaoyou.md            # 小优（运维）——本人自写（后续阶段）
│   └── xiaoye.md             # 小夜（助理）——本人自写（后续阶段）
├── frontend/                 # Phase 2：React + Vite + TS
│   ├── src/
│   │   ├── pages/            # Home / News / Roles / World / City
│   │   ├── components/       # NavBar / HeroVideo / NewsCard / RoleCard ...
│   │   ├── api/              # fetch 封装（/api/*）
│   │   ├── styles/           # tokens.css（由 style-guide.md 派生）
│   │   └── App.tsx / main.tsx / router.tsx
│   ├── public/assets/        # 视频/图片素材（生成物，见 assets-plan.md）
│   └── package.json / vite.config.ts / tsconfig.json
├── backend/                  # Phase 3：Node.js + Express 5（内容 API，端口 8080）
│   ├── src/
│   │   ├── data.js           # 内存静态数据（news/roles/worlds/cities）
│   │   ├── app.js            # Express app（/api/* 路由 + 400/404 兜底）
│   │   └── server.js         # listen 0.0.0.0:8080
│   └── test/api.test.js      # node:test 接口测试
└── nginx/                    # Phase 4
    └── nginx.conf            # 静态托管 + /api 反代 + SPA fallback（Phase 3 已写好配置）
```

## 3. 页面与板块规划（Phase 5 更新：路由翻页 → 单页全屏 scroll-snap 翻页）

参考站是"全屏 Swiper 单页翻页"；Phase 3 采用"React Router 路由 + 全屏滚动容器"落地。**Phase 5 因 CEO 反馈"与参考站完全不像"，已改为单页 + 全屏 section（CSS scroll-snap，零新依赖）**，对齐参考站 wrapSwiper 的整屏翻页体验：

| 板块（section id / 深链 hash） | 导航文字 | 对应模块 | 内容 |
|---|---|---|---|
| `#home`（旧 `/`） | 首页 | 首页（视频展示） | 全屏背景视频 + 团队 Slogan + 入口按钮 + 滚动提示 |
| `#news`（旧 `/news`） | 情报速递 | 团队动态 | Tab：做了什么 / 谁入职了 / 谁发牢骚了 + 斜切徽章行列表 |
| `#roles`（旧 `/roles`） | 角色介绍 | 角色 | 3 成员：竖图导航 + 大图立绘 + 底部信息条 + 背景氛围图 |
| `#world`（旧 `/world`） | 世界全景 | 工作环境 | 各成员工作环境全景图 + 缩略导航 |
| `#city`（旧 `/city`） | 都市映像 | 梦想愿景 | 愿景大图 + 居中标题 + 分页点 + 悬浮 footer |

- 实现：`frontend/src/lib/sections.ts` 维护板块注册表；导航点击 `scrollIntoView`；旧路由路径（`/news` 等）、hash（`#news`）、`?nav=N` 均映射到对应板块（旧链接兼容）；`IntersectionObserver` 驱动顶栏高亮与 hash 同步。
- 导航栏：**首页 / 情报速递 / 角色介绍 / 世界全景 / 都市映像**（去掉参考站的登录、充值中心、下载按钮，文字按团队语义调整）。
- 非本阶段/明确不做：充值中心、登录、下载、适龄标识、客服、平台入口。

## 4. API 草案（Phase 3 落地，本阶段仅定字段语义）

| 端点 | 方法 | 说明 | 返回 |
|---|---|---|---|
| `/api/news?type=work|join|complaint` | GET | 情报速递（可按类型过滤） | `News[]` |
| `/api/roles` | GET | 角色列表 | `Role[]` |
| `/api/worlds` | GET | 世界全景（工作环境） | `World[]` |
| `/api/cities` | GET | 都市映像（愿景） | `City[]` |

字段定义见 `content-model.md`；MVP 可静态数据，前端先 mock 后接真接口。

## 5. 关键决策与理由

1. **Vite 而非 CRA**：Vite 是当前 React 官方推荐脚手架，dev 快、产物小、TS 一等公民。
2. **Node/Express 只做内容 API**（2026-08-22 更新）：CEO 确认后端用 Node（不装 Java）；官网无复杂业务，后端保持"薄 API 层 + 内存数据"，不引安全框架（无登录）、不引数据库（MVP）。
3. **nginx 托管静态 + 反代**：nginx 托管 `frontend/dist` + `/api` 反代到 Node 后端；Node 常驻进程由部署阶段（Phase 4）用进程管理（pm2/systemd）守护，符合既有服务器运维习惯（小优管）。
4. **全屏翻页基因保留（Phase 5 落地）**：风格"一模一样"主要落在视觉（配色/版式/视频氛围）；Phase 5 起交互对齐参考站"整页 Swiper 翻页"，以 **CSS scroll-snap 单页五板块**实现（零新依赖），比 Swiper 库更轻。
5. **标题从"图片"改 CSS 文字**：参考站标题均为切图，我们改用 CSS 排版模拟（可维护/SEO），仅 Slogan 等品牌字可出图。

## 6. 待澄清问题（监督者未答复时按最小假设推进）

1. **"一模一样风格"的边界（Phase 5 已决）**：CEO 明确要求"一模一样风格、一致的 UI"→ 加载动画、整页翻页均 1:1 对齐（scroll-snap 单页 + 字母波浪加载页），无登录/充值/下载。
2. **素材生成时机**：任务明确本阶段不生成素材；生成脚本与 key 管理放 Phase 2 执行（沿用 learnings.md 的 Seedream 接入经验）。
3. **后端数据源**：MVP 用内存静态数据还是直接上 DB？→ 假设：MVP 静态数据，接口字段先定型。**（Phase 3 落地：`backend/src/data.js` 内存静态数据已实现）**
4. **team-site 是否独立 git 仓库**：当前在 promise-ai 仓库内建目录；若 CEO 要求独立部署仓库，Phase 2 再拆（本阶段提交在现有仓库 main 分支）。
