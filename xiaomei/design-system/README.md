# Design System · 扩展指南

> 维护者：小美；建档日期：2026-08-23。这里是团队设计语言的单一事实来源（Single
> Source of Truth）：设计原则在 `../rules/`，参考品牌分析在 `../references/`，
> 可复用令牌在本目录 `tokens.json`。

## 这是什么

本 Design System 定义"团队的产品界面长什么样、为什么长这样、如何保持一致"。
**原则（rules/）回答为什么，tokens.json 回答用什么值，组件规则（rules/component-rules.md）
回答怎么组装。** 三者缺一不可。

## 文件结构

```
xiaomei/
├── identity/persona.md          # 小美人格（先理解再设计的判据）
├── rules/                       # 设计原则：design-principles / typography / color / spacing / component-rules
├── references/                  # 品牌分析：apple / linear / stripe / vercel（为什么/解决什么/何时用何时不用）
└── design-system/
    ├── tokens.json              # 可复用令牌（颜色/字体/间距/圆角/阴影）
    └── README.md                # 本文件：如何扩展
```

## Token 命名规范

- 颜色：`--color-*`（`--color-primary` → 落地为 CSS 变量 `--color-accent` 语义化命名，
  见下）；状态色用语义（success/warning/danger），不用"红/绿"。
- 字体：`--font-*`（家族栈）、`--fs-*`（字号阶梯，语义名 display/title/body/caption）。
- 间距：`--space-1..8`（4px 基准的倍数）。
- 圆角：`--radius-sm/md/lg/full`。
- 阴影：`--shadow-none/sm/md/accent`（默认无阴影，克制原则）。

> 落地为 CSS 变量时，把 tokens.json 的 key 映射为 `--color-accent`、`--space-4`、
> `--radius-md`、`--shadow-md` 等；深色模式用 `*-dark` 后缀 token 覆盖。

## 如何扩展（流程）

1. **先查**：tokens.json / rules / references 有没有覆盖需求？没有才新增。
2. **写进 Design System 而不是页面**：新 token 先落 `tokens.json`（带 description
   说明用途），新组件规则先写进 `rules/component-rules.md`，页面只消费不改写。
3. **新增 token 四问**：解决什么问题？现有 token 为什么不行？有真实使用场景吗？
   能否用现有 token 组合实现？（回答不了就不加——避免 token 通胀）
4. **更新版本号**：`tokens.json` 的 `version` 语义化递增（0.x 为草稿，1.0 起为
   首个稳定基线），并在 CHANGELOG 里记一笔。
5. **视觉回归**：改动后对受影响页面做 Visual QA（层级/间距/对比度/一致性逐项过）。

## 与团队其他资产的关系

- **team-site/docs/style-guide.md + frontend/src/styles/tokens.css**：官网（面向用户
  的营销站）的设计规范，由小黑维护。本 Design System 的**颜色初始值**复用了它的
  色板（#1d1d1d 深底系 + #50e5fb 青色主强调），保证"产品界面"与"官网"同属一个
  视觉家族；本 Design System 面向的是产品功能界面，两者 token 名错开（官网用
  `--color-bg`，本系统用语义化的 `--color-bg` 也一致，冲突时以本 README 的命名
  规范优先并回写官网文档）。
- **/app/xiaomei/index.html**：小美工位主页，是本 Design System 的第一份"样品"
  （浅色界面：留白/黑白灰 + accent 点缀）。
