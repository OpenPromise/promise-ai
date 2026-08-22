# 页面模块细化与数据字段（content-model）

> 记录人：小黑；日期：2026-08-22；字段为 Phase 3 后端 API 与 Phase 2 前端数据模型的共同契约。

## 1. 首页（视频展示）

- 结构：全屏背景视频（autoplay muted loop）+ poster + 中心 Slogan + 主 CTA（进入首页/开始浏览）+ 底部滚动提示。
- 数据字段：本页内容基本静态，素材引用见 assets-plan.md。

```ts
interface HeroConfig {
  videoUrl: string;      // 首页视频（mp4, web 兼容 H.264）
  posterUrl: string;     // 封面图
  slogan: string;        // 主 Slogan："世界第一 AI 工作室"
  sloganSub: string;     // 副 Slogan（可选，一句愿景）
  ctaText: string;       // 入口按钮文字
}
```

## 2. 情报速递（团队做了什么 / 谁入职了 / 谁发牢骚了）

- 结构：标题区 + 类型 Tab（全部 / 做了什么 / 谁入职了 / 谁发牢骚了）+ 动态列表（参考站 newsNav Tab + newsCont 列表基因）+ 更多按钮。
- 类型语义（对应参考站 channel 体系）：

| type 值 | Tab 文案 | 语义 | 示例内容 |
|---|---|---|---|
| `work` | 做了什么 | 团队/成员产出 | 上线了新功能、发布了版本 |
| `join` | 谁入职了 | 新成员入职 | 小优入职（运维） |
| `complaint` | 谁发牢骚了 | 成员吐槽/日常 | 小夜："服务器又报警了" |

```ts
interface NewsItem {
  id: string;          // 唯一 ID
  type: 'work' | 'join' | 'complaint';  // 情报类型
  title: string;       // 标题（一句话）
  content: string;     // 正文（可选，可空）
  author: string;      // 作者（成员名）
  avatarUrl?: string;  // 作者形象图（可选）
  date: string;        // ISO 日期 YYYY-MM-DD
  pinned?: boolean;    // 置顶（可选）
}

// API：GET /api/news?type=work|join|complaint（缺省返回全部，按 date 倒序）
```

## 3. 角色介绍（名称 / 简介 / 2D 形象图 / 梦想）

- 结构：左侧竖排角色导航（3 人：小黑/小优/小夜）+ 主区每角色一屏：背景氛围 + 2D 形象图 + 名称 + 职务 + 简介 + 个人梦想（参考站 roleNav + roleSwiper 基因）。
- 数据字段：

```ts
interface Role {
  id: string;          // 'xiaohei' | 'xiaoyou' | 'xiaoye'
  name: string;        // 名称：小黑 / 小优 / 小夜
  title: string;       // 职务：工程师 / 运维 / 助理
  bio: string;         // 简介（1-3 句）
  avatarUrl: string;   // 2D 形象图（seedream 生成物，见 assets-plan.md）
  dream: string;       // 个人梦想（一句话，与团队梦想呼应）
  accent?: string;     // 个人强调色（可选，用于卡片点缀，不破坏整体）
}

// API：GET /api/roles
```

- 角色定义文档：`characters/*.md`（形象提示词 + 梦想，**每人自写自己的**）。

## 4. 世界全景（各自工作环境图）

- 结构：板块标题 + 缩略导航 + 场景大图 + 描述（参考站 pageView：plateChangeBtns + pageViewNav + brandSwiper + plateinfo 基因）。
- 数据字段：

```ts
interface World {
  id: string;          // 'xiaohei-desk' | ...
  name: string;        // 场景名：如"小黑的工作台"
  owner: string;       // 所属成员
  imageUrl: string;    // 全景图（seedream 生成物）
  description: string; // 场景描述（1-2 句）
}

// API：GET /api/worlds
```

## 5. 都市映像（梦想愿景图）

- 结构：全屏场景轮播 + 标题 + 分页（参考站 pageCity：citySwiper + citySlideTit + cityPagination 基因）。
- 数据字段：

```ts
interface City {
  id: string;
  title: string;       // 愿景标题：如"世界第一 AI 工作室"的未来都市
  imageUrl: string;    // 愿景图（seedream 生成物）
  description: string; // 愿景描述（1-2 句）
}

// API：GET /api/cities
```

## 6. 导航栏（文字调整结论）

参考站导航含"登录/充值/下载"类入口，任务明确**不要**。调整后：

| 序 | 导航文字 | 路由 |
|---|---|---|
| 1 | 首页 | `/` |
| 2 | 情报速递 | `/news` |
| 3 | 角色介绍 | `/roles` |
| 4 | 世界全景 | `/world` |
| 5 | 都市映像 | `/city` |

> 待澄清（见 architecture.md §6）：是否需要在导航加"关于我们/加入我们"等团队官网常见入口——最小假设：不加，保持与参考站板块一一对应。
