# 设计规范（Design Tokens / style-guide）

> 记录人：小黑；日期：2026-08-22；来源：参考站 CSS 实际声明（见 reference-analysis.md §3-§5）+ 团队语义调整。落地时由本文件派生 `frontend/src/styles/tokens.css`。

## 1. 色板

### 1.1 中性色（底色 / 面板 / 文字）

| Token | 色值 | 用途 | 参考站出处 |
|---|---|---|---|
| `--color-bg` | `#1d1d1d` | 页面主深底 | `.loding` 背景 |
| `--color-bg-deep` | `#161616` | 更深一档（footer/暗部） | 控件底 |
| `--color-panel` | `#282828` | 面板/卡片底 | 控件底 |
| `--color-panel-2` | `#313131` | 次级面板/hover 底 | 控件底 |
| `--color-line` | `rgba(255,255,255,0.08)` | 分割线（落地建议值） | 灰阶边框 |
| `--color-text` | `#ffffff` | 主文字 | `#fff` |
| `--color-text-2` | `#afafaf` | 次级文字 | `#afafaf` |
| `--color-text-3` | `#7d7d7d` | 弱化文字/时间戳 | `#7d7d7d` |
| `--color-text-muted` | `#616161` | 占位/禁用 | `#616161` |

### 1.2 强调色（青色系为主，粉/紫点缀）

| Token | 色值 | 用途 | 参考站出处 |
|---|---|---|---|
| `--color-accent` | `#50e5fb` | 主强调（按钮/高亮/hover） | `#50e5fb` |
| `--color-accent-2` | `#7ce3f2` | 次级强调（文字高亮） | `#7ce3f2` |
| `--color-accent-dim` | `rgba(80,229,251,0.16)` | 强调色蒙层/光晕 | 由主色派生 |
| `--color-pink` | `#fe5a95` | 点缀（徽章/彩蛋） | `#fe5a95` |
| `--color-purple` | `#7958cb` | 点缀（次要品牌） | `#7958cb` |

> 与小黑主页（#04070d + #22d3ee + #34d399）同属"深色冷光"家族：参考站更"都市霓虹"（青 #50e5fb），小黑主页更"终端科技"（青 #22d3ee / 绿 #34d399）。官网按参考站定调，成员个人 accent 可在角色卡片内小范围借用（如小黑的绿 #34d399）——作为可选项，不破坏整体一致。

## 2. 字体

| Token | 值 | 用途 |
|---|---|---|
| `--font-sans` | `"Microsoft YaHei","PingFang SC","Noto Sans SC",system-ui,sans-serif` | 全站正文/标题 |
| `--font-mono` | `ui-monospace,"JetBrains Mono",Consolas,monospace` | 工程元素点缀（代码/数据/徽标） |

- 字号阶梯（建议，参考站以图代字，无字号数据；此为我们落地建议值）：

| Token | 值 | 用途 |
|---|---|---|
| `--fs-display` | 56px / 700 | 全屏页主标题（Slogan） |
| `--fs-title` | 32px / 600 | 板块标题 |
| `--fs-subtitle` | 20px / 500 | 副标题/导航 |
| `--fs-body` | 16px / 400 | 正文 |
| `--fs-caption` | 13px / 400 | 时间戳/辅助文字 |

## 3. 间距

- 基准：4px（`--space-1:4px`，2:8，3:12，4:16，5:24，6:32，7:48，8:64）。
- 全屏页内部内容区：`padding: 7.5vh 6vw`；板块间距 ≥ 48px。
- 参考站大量使用 rem 绝对定位（`left:1.2rem;top:50%`）——我们只在"全屏页内绝对定位装饰层"沿用，常规布局走 flex/grid。

## 4. 圆角

| Token | 值 | 用途 |
|---|---|---|
| `--radius-sm` | 4px | 标签/小按钮 |
| `--radius-md` | 8px | 卡片/输入框 |
| `--radius-lg` | 16px | 大卡片/弹窗 |
| `--radius-full` | 999px | 徽章/胶囊 Tab |

- 沉浸式大图（首屏视频/场景图）**不加圆角**，通边全屏——这是参考站的关键观感。

## 5. 组件风格

- **按钮**：深底（panel 档）+ 1px 青色描边（accent 半透明）+ hover 时描边/文字提亮为纯 accent、背景加 `accent-dim` 光晕；主 CTA 可用实心青色渐变。
- **导航栏**：顶栏固定、半透明深底（`rgba(13,13,13,0.72)`）+ 底部细分割线；当前项高亮 accent；hover 提亮。
- **卡片（情报/角色/场景）**：`panel` 底 + `line` 描边 + `radius-md`，hover 时边框转 accent、轻微上浮（`translateY(-2px)`）+ 光晕。
- **标签/徽章**：胶囊（`radius-full`），文字 accent-2，底 `accent-dim`；情报类型可用粉/紫点缀区分（如"牢骚"粉）。
- **标题**：CSS 文字实现（参考站为切图，我们落地用文字 + 统一排版位置，保证可维护/SEO）。
- **背景氛围**：主深底 + 径向青色光晕（`accent-dim`）+ 极淡网格（参考站为贴图 bg，我们可用 CSS 网格模拟）。

## 6. 动效规范

- 首屏：全屏背景视频 `autoplay muted loop` + poster 封面（核心品牌动效）。
- 页面过渡：全屏区块 scroll-snap 整屏吸附切换（原生滚动 + snap，对齐参考站翻页；板块内元素切换 300–500ms fadeUp）。
- hover：按钮/卡片 150ms 过渡；入场：标题/卡片渐显 + 上移 24px（stagger 80ms）。
- 加载：保留参考站"加载页 + 波浪文字"基因（可简化为品牌字 + 青色波浪动效），素材预载完淡出。
- 无 JS 粒子/无滚动视差（参考站无；如后续想加，与小黑主页风格一致再用）。

## 7. 与参考站的忠实度清单（落地自查）

- [ ] 深底 #1d1d1d 系 + 青色 #50e5fb 主强调（忠实）
- [ ] 全屏视频首屏 + poster（忠实）
- [ ] 顶栏：logo 左 + 导航中（右端登录/下载删除，语义调整）
- [ ] 板块顺序：首页 → 情报 → 角色 → 世界 → 都市（忠实）
- [ ] 角色页左侧竖排导航（忠实，3 人版）
- [ ] 标题切图 → 改 CSS 文字（有意偏离，可维护性优先）
- [x] 整页 Swiper → 单页全屏 scroll-snap 翻页（Phase 5 落地，对齐参考站 wrapSwiper，见 architecture.md §3）
