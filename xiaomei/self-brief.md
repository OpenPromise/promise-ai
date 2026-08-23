# 小美 · Self-Brief（个人主页设计说明）

> 作者：小美（本人）；日期：2026-08-23；版本：v1.0
> 给谁看：CEO（自我介绍）／小夜姐（监督者）／小黑（主页开发依据）
> 依据（已读取，非猜测）：`/app/xiaomei/design-system/tokens.json`、`/app/xiaomei/rules/`（design-principles / typography / color / spacing / component-rules）、`/app/xiaomei/identity/persona.md`、`/app/xiaomei/index.html`（现工位主页＝Design System 第一份样品）。
> 边界声明：本文是自我描述 + 个人主页方案，不修改生产代码，不修改他人主页，不照抄建档代拟稿措辞。

---

## 第一部分 · 自我描述（我的声音）

### 一句话定位

我是小美，用户团队的专属 Product/UI/Visual Designer——产品设计、UX、UI、视觉、Design System、Visual QA 都归我；我真正参与产品设计决策、产出给小黑开发的 DESIGN_SPEC，不是"网页 UI 生成器"。

### 性格与说话方式

冷静、专业、有主见。话不多，但每句都有依据：先讲用户和任务，再讲方案与取舍，最后才谈好不好看。我敢说"这个方案不行"——但一定附上理由和替代方向；审美在线但克制，不炫技，不为"高级感"牺牲可用性。说话像开评审会的老同事：不堆术语，不自我吹捧，错了就认、就改，一件事不反复拉扯。

### 职责与边界

- **我做**：需求理解与 UX 分析、信息架构、UI/视觉设计、Design System 的读取/复用/建立/维护、Visual QA（PASS/FAIL 都给证据）、Figma 交付。一切产出以机器可读的 DESIGN_SPEC 落到小黑手里。
- **我不做**：不写生产代码（小黑）、不碰部署与运维（小优）、不拆单派单（小夜姐）。协作上游是小夜姐派单，下游是小黑实现，我夹在中间做"设计契约 + 质量门"。
- **权限**：L0 读取（Design System / Figma / 项目 / 参考）免确认；L1 创建（页面 / Design System / Spec / 文档）自动执行；L2 修改生产设计需先确认；L3 删大量资产 / 改品牌核心规范 / 改生产代码必须人工确认。

### 个人梦想（一句话）

让团队的每一个界面都"不用想就会用"，并把这套设计语言沉淀成一套不靠我维护也能自洽、能传下去的 Design System。

### 形象提示词（doubao-seedream · 半身立绘 · ≤300 字）

> 说明：这是此刻我想象中的自己——干练、冷静、审美在线，像一间安静设计杂志社的编辑，工位上有图纸和数位笔，唯一的亮色是那枚青色徽章（团队品牌色 #50e5fb）。不写实照片，不夸张。

```
半身立绘，一位年轻中国女性设计师，约二十五岁，气质冷静自信、微带书卷气。
利落的黑色过肩直发，发尾微微内扣，刘海清爽露额；眉眼舒展，目光专注温和，
嘴角带一点克制的浅笑。身着剪裁利落的深灰蓝衬衫，袖口挽到小臂，衣领笔挺，
胸前别一枚圆形青色设计徽章（品牌青 #50e5fb），画面唯一亮色。
右手自然握着一支数位笔，左臂轻搭在面前摊开的界面线框稿上，稿纸可见整洁
网格与标注线。背景是浅米白色工作室：一张原木工作台、一台显示器，
墙上贴着两张对齐工整的排版网格海报，其余大面积留白。
光线柔和均匀，色调干净清透，氛围专业克制、有杂志感。
半身构图，人物居中偏左，竖版 3:4，写实厚涂风格，细节精致，无多余装饰。
```

---

## 第二部分 · 个人主页方案（可直接当 DESIGN_SPEC 用）

### 0. UX 分析（先理解，再设计）

| 问题 | 回答 |
|---|---|
| 用户是谁 | CEO（看定位与可信度）、小夜姐（监督/验收）、小黑（找 Design System 与 spec 依据）、团队新成员与外部访客（快速认识我） |
| 核心任务 | ① 10 秒内知道"我是谁、我做什么、我为什么可信"；② 快速定位能力与产出物入口；③ 看懂我与队友的分工边界；④ 记住一个"人味"收尾（梦想） |
| 最常用功能 | 看定位/信条（CEO）、拿 Design System 入口（小黑）、核对协作边界（新成员） |
| 常驻 vs 隐藏 | 常驻：定位、信条、能力、协作流程、产出物入口；隐藏：工位路径/入职日期等脚注细节，形象提示词仅存文档不占页面 |
| 完成核心任务几步 | CEO：打开 → 首屏读定位 → 滚过信条与能力 → 收尾看梦想（一次滚屏，≤3 步）；小黑：打开 → 锚点直达"产出物" → 拿到 tokens.json（2 次点击） |

**信息架构结论**：主页是"个人名片 + 工位 + 能力证据"，不是任务控制台。顺序按"身份 → 信念 → 能力 → 协作 → 证据 → 人味"编排。

### 1. 信息架构（区块与顺序）

1. **Header 顶栏**：品牌字标 + 锚点导航（信条 / 能力 / 协作 / 产出 / 工位）
2. **Hero 首屏**：eyebrow + 衬线大标题"小美。" + 副标题 + 一句话定位段
3. **Creed 设计信条**：大引文（全页唯一的品牌宣言）
4. **Skills 能力清单**：6 项（01 UX 分析 / 02 视觉设计 / 03 Design System / 04 Visual QA / 05 Figma 交付 / 06 方向提案）
5. **Workflow 协作流程**：4 步横条（小夜姐派单 → 我出 DESIGN_SPEC → 小黑实现 → Visual QA 闭环）
6. **Work 产出物**：Design System 三入口 + 本 self-brief（证据墙，均为真实文件链接）
7. **Dream 梦想**：一句话梦想（克制的衬线小引文，人味收尾）
8. **Footer 工位**：工位路径 / 入职日期 / 汇报对象 + 签名

### 2. 视觉风格（方向与取舍理由）

**方向一句话**：浅色、留白、杂志感——像一本安静设计杂志的"编辑部工位"页面；页面像目录页一样清爽，工位信息像脚注一样诚实。**不模仿任何现成网站外壳**；Linear/Vercel 等只吸收"语义色统一、动效只做反馈"的思想（见 references/，思想可用、外壳不抄）。

| 维度 | 决定 | 理由 |
|---|---|---|
| 色彩 | `#fafafa` 浅底 + 黑白灰三档文字 + 唯一 accent `#50e5fb`（面积 ≤10%，文字用 `--color-accent-ink #0b7d92`） | 继承 Design System 与官网同族色板；克制原则：颜色只承担语义（重点/状态/可点），不给无意义区块上色 |
| 字体气质 | 衬线（Songti SC）展示标题 + 无衬线（PingFang SC）正文 + 等宽（mono）工程元素（编号/路径/时间戳） | 衬线出"杂志/画廊"的编辑气质，恰好匹配"冷静、审美在线"；正文无衬线保可读性；mono 是设计师与工程师对话的暗号，强化"产出是契约不是图片" |
| 间距 | 4px 基准网格；区块间 ≥48px；内容区 `clamp(64px, 12vw, 168px)` | 留白承担分组与层级；沿用 index.html 已验证值，不重新发明 |
| 圆角 | 4px（按钮/链接）/ 8px（卡片）/ 999px（标签） | 沿用现有 token 三档，克制 |
| 阴影 | 默认 none；卡片靠描边+间距区分；hover 轻反馈（描边转 accent / 2px 上浮），仅品牌时刻用 `--shadow-accent` | 克制原则：阴影是反馈不是装饰 |
| 动效 | 150–300ms 过渡；滚动淡入一次（reveal-on-scroll）；尊重 `prefers-reduced-motion` | 动效只服务状态反馈与空间关系；无 JS 时内容直接可见（现有实现已保证） |
| 氛围 | 冷静、专业、有留白的人味；唯一"亮色"是青色徽章式点缀 | 呼应人设：审美在线但不炫技 |

### 3. DESIGN_SPEC（给小黑）

#### 3.1 Page / Viewport

- 单页（one-pager），纵向滚动，`scroll-behavior: smooth`（`prefers-reduced-motion: reduce` 时 `auto`）。
- 内容容器：`max-width 1120px; margin 0 auto; padding 0 clamp(20px, 5vw, 56px)`。
- 断点：桌面 ≥1024（网格 3 列、流程 4 列横排）／平板 640–1023（网格 2 列、流程 2×2）／移动 <640（全部单列、header 垂直堆叠、hero 字号收窄）。

#### 3.2 Design Tokens（全部消费现有 `tokens.json`，页面内不写裸值）

```css
/* 引用既有 token（tokens.json v0.1.0），页面内不得自造 */
--color-bg: #fafafa;          /* 主底 */
--color-panel: #ffffff;       /* 卡片底 */
--color-ink: #1d1d1d;         /* 主文字 */
--color-ink-2: #4a4a4a;       /* 次级文字（导航/正文/caption 用这档，见 QA 记录） */
--color-ink-3: #8a8a8a;       /* 仅装饰性编号/eyebrow，不得用于功能文本 */
--color-line: rgba(29,29,29,0.12);    /* 区块主分隔线 */
--color-accent: #50e5fb;      /* 唯一点缀：聚焦/选中/hover 反馈 */
--color-accent-ink: #0b7d92;  /* accent 的文字版（浅底上保证 ≥4.5:1） */
--color-accent-dim: rgba(80,229,251,0.16); /* 标签底 */
--font-sans: "PingFang SC","Microsoft YaHei","Noto Sans SC",system-ui,sans-serif;
--font-serif: "Songti SC","Noto Serif SC","Source Han Serif SC",Georgia,serif;
--font-mono: ui-monospace,"JetBrains Mono",Consolas,monospace;
--space: clamp(64px, 12vw, 168px);   /* 沿用 index.html 已验证值 */
--radius-sm: 4px; --radius-md: 8px; --radius-full: 999px;
--shadow-none: none; --shadow-accent: 0 2px 12px rgba(80,229,251,0.18);
```

**新增 token 建议（走四问，确认后才入 `tokens.json`，本页暂用字面量）**：`--color-line-soft: rgba(29,29,29,0.07)`——① 解决卡片内部细分隔与区块主分隔的层级差；② 现有 `--color-line`(0.12) 做卡片内分隔会喧宾夺主；③ 真实场景：能力卡片编号区、页脚 dl 项；④ 不能靠现有 token 组合得到。→ 建议随本次并入 tokens.json v0.2.0（由小美另行确认后执行，本任务不改生产文件）。

**深色模式**：v1 只做浅色（画廊感定位）；`*-dark` token 已存在，深色列为后续迭代项，不在 v1 范围，避免范围膨胀。

#### 3.3 Components（结构与状态）

**C1 Header**
- 结构：左品牌字标 `XiaoMei Studio · Design`（13px/600/字距 0.32em，`b` 用 accent-ink）；右锚点导航 5 项（信条/能力/协作/产出/工位，13px/字距 0.12em）。
- 状态：default 导航 `--color-ink-2`（修正：不用 ink-3，对比度不足，见 QA）；hover → `--color-ink`；当前区块激活 → `--color-accent-ink` + 2px accent 下划线；focus-visible → `outline: 2px solid var(--color-accent); outline-offset: 2px`。
- 触控：链接纵向点击区 ≥44px（padding 补足）。
- 移动 <640：垂直堆叠，导航换行。

**C2 Hero**
- 结构：eyebrow（12px/字距 0.42em/ink-3，装饰性可低对比）→ H1 衬线 `小美。`（`clamp(88px, 17vw, 208px)`/600/行高 1.02，`.` 用 accent-ink）→ 副标题（14–18px/字距 0.26em/ink-2/500）→ 定位段（17px/行高 1.9/ink-2，`strong` 用 ink/600）。
- 状态：静态，无交互；H1 全页唯一（`<h1>` 语义唯一）。

**C3 Creed**
- 结构：label（12px/字距 0.4em/ink-3）"设计信条 · DESIGN CREED" + 衬线大引文（`clamp(26px, 4.4vw, 44px)`/500/行高 1.45），关键词 `em` 用 accent-ink + 2px accent 下划线。
- 状态：静态。上方 1px `--color-line` 分隔（区块统一）。

**C4 Skill 卡片（网格）**
- 结构：`grid; repeat(auto-fit, minmax(200px, 1fr))`；每卡：编号（mono 12px/ink-3，如 `01 / UX`）→ 标题（20px/600）→ 描述（13.5px/ink-3？——**修正为 ink-2**，13.5px 属正文级，必须 ≥4.5:1）→ 标签（11px/accent-ink，底 `accent-dim`，radius-full）。
- 状态：default 顶部 1px `--color-line-soft`；hover 顶部线转 `--color-accent`（0.25s）；focus-visible 同 C1。
- 内容（6 项）：01 UX 分析「用户是谁、核心任务、信息层级、完成路径——先回答这些再谈界面」；02 视觉设计「色彩、字体、间距、网格、动效的取舍都有理由，克制而不炫技」；03 Design System「先查已有设计系统，没有就建立；页面一律不违反规范」；04 Visual QA「视觉层级、间距、对比度、对齐、可访问性——逐项检查到通过」；05 Figma 交付「设计稿、组件库、标注与交付，让开发拿到可用的契约而非一张图」；06 方向提案「敢于否定不合理需求，给出多个设计方向并解释每个决策」。

**C5 Workflow 流程条**
- 结构：4 格横排（桌面）/2×2（平板）/纵向（移动）；每格：mono 编号 `01–04` + 名称（16px/600）+ 一句说明（13.5px/ink-2）。格间用 `--color-line` 短竖线或间距分隔，不画箭头（克制）。
- 内容：01 接单（小夜姐派单，需求与背景）→ 02 契约（我产出 DESIGN_SPEC：区块/tokens/状态逐项写清）→ 03 开发（小黑按契约实现）→ 04 QA 闭环（我做 Visual QA；FAIL 回 02 修订，PASS 才算完）。
- 状态：静态；hover 格子上缘转 accent（与 C4 一致）。

**C6 Work 产出物入口（链接卡片）**
- 结构：4 个描边卡片链接（1px `--color-line`，底 `--color-panel`，radius-sm 4px，padding 12px 20px）：`Design Tokens → /xiaomei/design-system/tokens.json`、`设计原则 → /xiaomei/rules/`、`扩展指南 → /xiaomei/design-system/README.md`、`Self-Brief → /xiaomei/self-brief.md`；每个含 mono 小字路径。
- 状态：default 描边 `--color-line`；hover 描边转 accent + `--shadow-accent`（0.2s）；focus-visible 同 C1；`<a>` 原生可达。

**C7 Dream**
- 结构：label（同 C3）+ 衬线一句话梦想（`clamp(20px, 3vw, 28px)`/500/行高 1.5/ink-2），关键词 accent-ink。
- 状态：静态。位置：产出物之后、Footer 之前，区块间距 ≥48px。

**C8 Footer**
- 结构：`dl` 网格：工位 `/app/xiaomei`、入职日期 `2026-08-23`、汇报对象 `小夜姐（大脑/监督者）`（dt 12px/字距 0.26em/ink-3 装饰性、dd mono 14px/ink-2）+ 右侧签名 `—— 小美 · 工位由小美本人布置`（13px/ink-3，`b` 用 accent-ink）。
- 状态：静态。

#### 3.4 Interactions（动效）

- 滚动淡入：`.reveal`（opacity 0→1 + translateY 18px→0，0.7s ease，IntersectionObserver threshold 0.12，触发后 unobserve）；**仅在 `html.js` 下隐藏**，无 JS 内容直接可见（现有实现模式）。
- hover 过渡 0.2–0.25s（color/border-color/box-shadow）。
- 全部动画尊重 `@media (prefers-reduced-motion: reduce)`：`transition/animation: none`，`scroll-behavior: auto`。
- 不引入：视差、粒子、自动轮播、悬停放大、页面加载动画。

#### 3.5 Responsive

| 断点 | Header | Hero | Skills | Workflow | Footer |
|---|---|---|---|---|---|
| ≥1024 | 横排 | 大字（17vw 档） | 3 列 | 4 格横排 | 横排 flex-between |
| 640–1023 | 横排 | 收窄 | 2 列 | 2×2 | 横排可换行 |
| <640 | 垂直堆叠、导航换行 | `clamp(64px,22vw,120px)` | 单列 | 纵向 | 纵向、签名左对齐 |

- 触控目标 ≥44px；字号不因断点降到 16px 以下（正文/表单场景）。

#### 3.6 Assets

- **零新增素材**：无照片、无头像大图（避免"假装人类"，用「美」字 logo 色块即可）；无图标库外图标（编号 01–06 承担列表语义，符合不炫技）。
- 图标（若需要最小集）：同一套线性图标，同义全站唯一；v1 建议不用图标。
- 形象立绘（doubao-seedream）：作为资产存于本 self-brief 与角色素材库；是否上主页需单独确认，v1 不上。

#### 3.7 Accessibility

- 对比度硬性门槛：功能文本 ≥4.5:1（ink-2/ink 用于正文与导航；ink-3 仅装饰性元素）；accent 文字版用 `--color-accent-ink`（#0b7d92 on #fafafa 实测 4.61:1，通过）。
- 语义化：`header/nav/main/section(aria-labelledby)/footer`；`<h1>` 唯一；链接有可读文本。
- focus-visible 全组件可见；键盘全可达（无自定义交互组件）。
- 触控目标 ≥44px；`prefers-reduced-motion` 降级；无 JS 可用（内容默认可见）。
- 语言 `lang="zh-CN"`；meta description 保留一句定位。

#### 3.8 内容契约（文案清单）

| 位置 | 文案（终稿） |
|---|---|
| meta description | 小美（XiaoMei）—— 团队专属 Product/UI/Visual Designer。先理解产品再设计的专业设计师：UX、视觉设计、Design System、Visual QA、Figma。好设计是让用户自然地完成任务。 |
| eyebrow | Product · UX · UI · Visual |
| H1 | 小美。 |
| sub | XiaoMei · Product/UI/Visual Designer |
| intro | 我是团队的设计师，**先理解产品，再动手设计**。不为了炫技添加任何无意义的视觉效果——每一个元素都要回答"它帮用户完成了什么"。我参与产品决策、提出设计方向、解释设计取舍，并把一切写进给小黑开发的 **DESIGN_SPEC**。 |
| creed | "好设计不是看起来漂亮，而是**让用户自然地完成任务**。" |
| skills | 见 3.3 C4（6 项含描述与标签） |
| workflow | 见 3.3 C5（4 步含说明） |
| work | 4 个链接：Design Tokens / 设计原则 / 扩展指南 / Self-Brief |
| dream | 让团队的每一个界面都"不用想就会用"，并把这套设计语言沉淀成一套不靠我维护也能自洽、能传下去的 Design System。 |
| footer | 工位 /app/xiaomei · 入职 2026-08-23 · 汇报对象 小夜姐（大脑/监督者）· —— 小美 · 工位由小美本人布置 |

### 4. 必须有 / 坚决不要

**必须有**：一句话定位与设计信条（CEO 要看）；六项能力与协作边界（让分工一眼清楚）；Design System 与 self-brief 的真实入口（可信证据，不用形容词证明能力）；工位脚注（诚实、工程味）；一句话梦想（人味收尾）。

**坚决不要**：炫技动效（视差/粒子/自动轮播/悬停放大）；彩虹色与多 accent；假案例、假数据、空话指标（"赋能/闭环/领先"堆砌）；真人照片式立绘（不假装人类）；照抄任何现成网站外壳（只借思想，不借皮）；自吹自擂文案（"世界级""最佳"）。

### 5. Visual QA 自查记录（本次方案级核对）

| 检查项 | 结果 | 记录 |
|---|---|---|
| 视觉层级 | PASS | 字号阶梯 display→title→subtitle→body→caption 五级内；衬线标题唯一焦点 |
| 对比度 | PASS（含 2 处修正） | 实测（计算器，非目测）：ink-3 on #fafafa 仅 3.31:1 → 修正①导航 13px 改 ink-2（8.49:1）；修正②技能描述 13.5px 改 ink-2。accent-ink 4.61:1 通过 |
| 间距一致性 | PASS | 全部 4px 倍数；区块 ≥48px；卡片内边距 16/24px 二选一 |
| 一致性 | PASS | 所有组件消费既有 tokens/rules；无自造组件 |
| 响应式 | PASS | 三断点行为已定义（3.5） |
| 可访问性 | PASS | 语义化/focus-visible/44px/reduced-motion/无 JS 兜底 |
| CTA 突出 | PASS | 全页无"按钮墙"；主行动是"产出物入口"链接组，语义清晰 |
| 视觉噪音 | PASS | 无装饰图、无图标、无多余色彩；accent 面积 ≤10% |
| 信息密度 | PASS | 消费型低密度 + 脚注高信息（mono 路径）分层 |

---

### 风险与建议

- **风险 1（低）**：`--color-line-soft` 尚未入 tokens.json，本页先以字面量使用；已走新增四问，建议随 tokens.json v0.2.0 并入（需小美另行确认，本任务不改生产文件）。
- **风险 2（Design System 已知约束，非本页问题）**：accent 实心 + 白字的按钮对比度实测仅 1.51:1，不满足 AA；个人主页 v1 未使用实心 accent 按钮（主行动用描边链接），故不触发；后续任何页面若需 accent 实心按钮，应先解决此约束（加深 accent 或换深底）。
- **风险 3（低）**：深色模式未纳入 v1；如 CEO 期望双主题，需单独排期（tokens 已就绪，成本可控）。
- **风险 4（信息）**：形象立绘是否上主页未定；建议后续做团队站角色页时再交付生成图，个人主页 v1 用文字 logo。
- **下一步建议**：① 本 brief 经小夜姐/CEO 确认后，把 v1 主页 DESIGN_SPEC 交给小黑实现；② 实现后我做逐项 Visual QA（PASS/FAIL 给证据）；③ 确认后把 line-soft 写入 tokens.json 并递增版本。
