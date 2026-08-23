# output · 设计产出目录

> 维护者：小美。本目录存放设计任务的产出物：DESIGN_SPEC、视觉方案、设计稿说明、
> Visual QA 记录等。当前为空——第一个任务产出将从这里开始。

## DESIGN_SPEC 格式（给小黑开发的机器可读契约）

每个 DESIGN_SPEC 必须包含以下章节，缺一不可（缺章节 = 未完成）：

1. **Page**：页面名称、目标、入口来源、在本产品信息架构中的位置。
2. **Viewport**：目标视口（桌面/移动/两者），断点约定（如 ≥1024 桌面、<768 移动），
   默认宽度（如 1280 / 390）。
3. **Components**：页面用到的所有组件清单；每个组件给出：
   - 名称 + 来源（Design System 已有 / 本次新增）
   - 结构（层级树，如 `Header > NavItem > Icon`）
   - 状态（default/hover/active/focus/disabled/loading/error）
   - 行为（点击/悬停/键盘可达性）
   - 取值（引用 tokens：`--color-accent`、`--space-4`、`--radius-md`）
4. **Design Tokens**：页面使用的 CSS 变量清单（`--color-primary` 等），
   全部来自 design-system/tokens.json，不许页面自造裸值。
5. **Interactions**：交互细节——动效（150–300ms、prefers-reduced-motion 降级）、
   空状态、错误状态、加载状态、表单校验时机。
6. **Responsive**：各断点下的布局变化（栅格列数、导航形态、字体/间距缩放）。
7. **Assets**：需要的素材清单（图标/插图/图片），尺寸、格式、命名；没有就不写。
8. **Accessibility**：对比度（正文 ≥4.5:1）、焦点态、语义化标签、触控目标 ≥44px、
   键盘导航路径。

## 产出命名约定

- 一个任务一个子目录：`output/<任务ID或日期>-<简短主题>/`
- 主契约固定名：`DESIGN_SPEC.md`（机器可读，给小黑）
- 视觉说明：`visual-notes.md`（给人类看：方向、取舍、备选方案）
- Visual QA 记录：`visual-qa.md`（问题列表 + 迭代记录，直到 PASS）

## 生命周期

设计任务 → 产出到本目录 → DESIGN_SPEC 交给小黑 → 小黑实现 → 小美 Visual QA →
PASS 归档 / FAIL 回炉（更新 DESIGN_SPEC 后重来）。归档即完成闭环。
