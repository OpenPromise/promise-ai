# 世界第一 AI 工作室 · 团队官网项目

> 目标：做一个正规专业的团队官网，参考 [完美世界《异环》官网](https://yh.wanmei.com/main.html)（要求风格/UI 一致），技术栈 React + SpringBoot + nginx。
> 团队梦想：**世界第一 AI 工作室**。成员：小黑（工程师）、小优（运维）、小夜（助理）。

## 阶段边界

- **Phase 1（当前）**：参考网站分析 + 技术方案 + 设计规范 + 素材规划 + 小黑自画像（**只做分析与文档，不写代码、不生成素材、不碰 API key**）。
- Phase 2：素材生成（MiniMax H3 视频 + Seedream 形象图/场景图，见 `docs/assets-plan.md`）+ 前端实现。
- Phase 3：SpringBoot 内容 API。
- Phase 4：nginx 部署。

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/reference-analysis.md](docs/reference-analysis.md) | 参考网站分析（配色/布局/字体/动效/板块，如实标注抓到与未抓到） |
| [docs/architecture.md](docs/architecture.md) | 技术方案（拓扑/目录结构/路由规划/API 草案/待澄清问题） |
| [docs/style-guide.md](docs/style-guide.md) | 设计规范 Design Tokens（色板/字体/间距/圆角/组件/动效） |
| [docs/content-model.md](docs/content-model.md) | 页面模块细化 + 数据字段（情报速递/角色/世界全景/都市映像） |
| [docs/assets-plan.md](docs/assets-plan.md) | 视频/图片素材规划（prompt 需求要点 + 调用参数） |
| [characters/xiaohei.md](characters/xiaohei.md) | 小黑角色定义（**本人自写**：形象提示词 + 个人梦想） |

## 关键约定

1. **角色形象提示词每人自写自己的**：小黑 ✅（本阶段完成）；小优、小夜由本人自写（后续阶段，任何人不得代写）。
2. **导航栏**：首页 / 情报速递 / 角色介绍 / 世界全景 / 都市映像（**无登录、无充值中心、无下载**）。
3. **设计基调**：深色（#1d1d1d 系）+ 青色主强调（#50e5fb）+ 首屏背景视频，忠实参考站风格；标题切图改 CSS 文字、整页 Swiper 改路由 + 全屏区块（可维护性优先，偏离点见 architecture.md §6）。
4. **素材**：首页视频 = MiniMax H3（模型 `MiniMax-H3`，参数依据 learnings §二十 实测经验）；形象图/场景图 = doubao-seedream-5-0-pro-260628（参数依据 learnings §十五 实测经验）。
