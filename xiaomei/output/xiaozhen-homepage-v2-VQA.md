# Visual QA 报告 · 小真主页 v2 实现走查

> 验收人：小美（产品/UI 设计）｜日期：2026-08-27｜版本：VQA v1.0
> 验收对象：`/app/xiaozhen/index.html`（小黑按 `xiaozhen-homepage-DESIGN_SPEC.md` v1.0 重写）
> 验收基线：DESIGN_SPEC §0 硬约束 + §9 验收清单 + 小真 self-brief 两条主验收标准
> 职责边界：只读与验收，不修生产代码；缺陷仅记录并移交小黑。

---

## 0. 总判定

**✅ 总体 PASS —— 无需返工，可上线。**

- 硬约束（相对路径 / 零依赖 / 语义红线）：全部通过，无违规。
- §9 验收清单：全部通过。
- 小真两条主验收（10 秒三问 / 30 秒找移交）：通过。
- 缺陷清单：无 S1 / S2 / S3 缺陷。
- 观察项 1 条（非缺陷，见 §7），移交小夜姐知悉。

## 1. 验收方法

- 静态走查：逐行读 `/app/xiaozhen/index.html`（411 行）与 DESIGN_SPEC 对照。
- grep 扫描：绝对路径 / IP / 外链 / 自夸词 / 语义色 / 动效降级。
- 动态实测：本地 python http.server 模拟 GitHub Pages dist 结构（6 成员目录 + 站点根 index.html），10 个 URL 全部 HTTP 200。
- 链接目标核实：`../xiaohei/` 等 4 个成员目录 + `./self-brief.md` 均真实存在。

## 2. 页面结构与设计 Token（对照 SPEC §1–§3）

| 检查项 | 结果 | 证据 |
|---|---|---|
| DOCTYPE + lang="zh-CN" | ✅ | 第 1–2 行 |
| viewport / description / theme-color #07140f / og / title | ✅ | 第 4–9 行，description 与 title 与 SPEC 逐字一致 |
| favicon 内联 data:image/svg+xml | ✅ | 第 11 行 |
| :root token 齐全（--bg/--panel/--line/--line-strong/--pass/--fail/--text/--dim/--font/--mono/--space-1..8/--radius-card/--radius-badge） | ✅ | 第 13–37 行，与 SPEC §2 完全一致 |
| body 背景（翠绿微光 + 32px 网格 + 底色） | ✅ | 第 42–52 行，与 SPEC §3 一致 |
| a:focus-visible 绿描边 / ::selection | ✅ | 第 54–55 行 |
| 滚动渐显机制（html.js 守卫 + IntersectionObserver IIFE） | ✅ | 第 57–58 行 + 第 393–410 行 script |

## 3. 区块走查（对照 SPEC §4 逐字文案）

### A. Header
| 项 | 结果 | 证据 |
|---|---|---|
| sticky 顶栏 + brand「XIAOZHEN / QA」 | ✅ | 第 261–262 行 |
| 5 锚点 + 返回官网 `../`（.home opacity .85） | ✅ | 第 263–270 行 |

### B. Hero + QA GATE 状态卡（10 秒三问）
| 项 | 结果 | 证据 |
|---|---|---|
| kicker / h1 小真 / role / lead 文案逐字一致 | ✅ | 第 274–280 行 |
| 状态卡：QA GATE · SELF-CHECK + STATUS: PASS | ✅ | 第 282–286 行 |
| gate-meta 4 行：OWNER 小真 / ROLE QA ENGINEER / LAST RUN / SIGNAL | ✅ | 第 287–293 行 |
| gate-note 自检清单（身份/职责/边界/证据/移交 ✓） | ✅ | 第 295 行 |
| gate-pulse 脉冲动效（scale 1→1.05, 2.4s） | ✅ | CSS @keyframes gate-pulse |
| **PASS 语义注释原样保留** | ✅ | 第 281 行「本页自检通过…非工作成果宣称」 |

### C. Creed
| 项 | 结果 | 证据 |
|---|---|---|
| 签章式引用块，文案逐字「没有证据的『能用』，等于不能用。」 | ✅ | 第 298–304 行 |

### D. 职责 4 卡（D-01..04）
| 项 | 结果 | 证据 |
|---|---|---|
| 4 卡编号 + 文案逐字一致 | ✅ | 第 306–329 行 |
| 左 2px 绿条 ::before + hover 亮边上移 | ✅ | CSS .card::before / .card:hover |

### E. 边界 + 移交表（30 秒找移交对象）
| 项 | 结果 | 证据 |
|---|---|---|
| 4 DONT + 1 DO，✓/✗ 符号 aria-hidden | ✅ | 第 332–340 行 |
| 玫红仅用于 DONT ✗ 与 DONT 标签描边（CSS 注释写明） | ✅ | CSS .checklist li.dont |
| 移交表 4 行成员链接：../xiaohei/ ../xiaoyou/ ../xiaomei/ ../xiaoye/ | ✅ | 第 348–351 行 |
| .mid mono 成员 ID（SPEC 可选增强，已实现含 hover 变色） | ✅ | 第 348–351 行 + CSS |

### F. 证据墙
| 项 | 结果 | 证据 |
|---|---|---|
| ZH-001 PASS + href ./self-brief.md（真实存在，实测 200） | ✅ | 第 360–365 行 |
| 诚实 note「宁可少，不可假」 | ✅ | 第 367 行 |

### G. 梦想 + Footer
| 项 | 结果 | 证据 |
|---|---|---|
| 梦想文案 + em PASS mono 绿 | ✅ | 第 373–375 行 |
| footer dl 落款（工位/入职/汇报/入口） | ✅ | 第 379–385 行 |
| sign + stamp PASSED 2026.08.24（rotate -2deg）+ PASSED 语义注释 | ✅ | 第 385–387 行 |

## 4. 硬约束核对（SPEC §0，违反 = S1）

| 检查项 | 结果 | 证据 |
|---|---|---|
| 无 `/xiaozhen/` 绝对路径 / 无 122.152.209.182 / 无外链 | ✅ | grep 扫描零命中（favicon SVG 命名空间 w3.org 为内联 data:URI 的一部分，非外链） |
| 页面内所有链接仅 `./` 与 `../` | ✅ | 全量 href 清单：`#top`、5 锚点、`../`、4 个 `../成员/`、`./self-brief.md` |
| 链接目标真实存在 | ✅ | ../xiaohei/ 等 4 目录 + self-brief.md 均存在 |
| 零外部依赖（CSS/JS 内联、无图片/字体/CDN/iframe） | ✅ | 全文件单 HTML；无 img/iframe/link 外链；favicon data:URI |
| 单文件交付，仅重写 index.html | ✅ | /app/xiaozhen/ 下仅 index.html 被更新（identity.md/self-brief.md 未动） |

**动态实测**（模拟 GitHub Pages dist 结构，python http.server 127.0.0.1:8897）：

| URL | 状态 |
|---|---|
| / | 200 |
| /xiaozhen/ | 200 |
| /xiaozhen/self-brief.md | 200 |
| /xiaozhen/identity.md | 200 |
| /xiaohei/ /xiaoyou/ /xiaomei/ /xiaoye/ /xiaozhi/ | 全部 200 |
| /xiaozhen/../xiaohei/（相对路径解析） | 200 |

**部署兼容性结论**：GitHub Pages workflow 将成员目录整体 cp 入 dist（含 self-brief.md），根 index.html 由 frontend 构建产出；nginx alias 下 `./`/`../` 语义一致。双环境均无路径硬编码风险。

## 5. 语义红线（小真本人定的，违犯 = 页面 FAIL）

| 检查项 | 结果 | 证据 |
|---|---|---|
| 无自夸形容词（业界/顶尖/100%/第一/最强/完美） | ✅ | grep 零命中（仅 CSS 技术值如 100% width 类，非自夸文案） |
| 无伪造数据 / 假绿勾 | ✅ | PASS 仅 2 处：状态卡 + 证据墙 ZH-001（对应真实 self-brief.md），均带语义注释 |
| PASS/PASSED = 本页自检通过（注释写死） | ✅ | 第 281、385 行注释原文保留 |
| 玫红仅 DONT/FAIL 标注，不做装饰 | ✅ | 玫红仅出现在 checklist .dont 的 ✗ 与 DONT 标签 |

## 6. 响应式 / 可访问性 / 团队语言一致性

**响应式**（SPEC §6）：
- ≤860px：main padding、h2 间距压缩 ✅
- ≤760px：hero 单列（先身份后自检）、grid 单列、移交表 padding 缩减不横滚、footer 纵向 ✅
- ≤480px：kicker 11px、gate-meta 单列、证据条目重排（id+verdict 一行 / body 占满 / 箭头保留）✅
- section[id] scroll-margin-top: 80px（sticky 顶栏锚点不被遮挡）✅

**可访问性**：
- a:focus-visible 全局绿描边（1 处全局规则覆盖所有链接）✅
- prefers-reduced-motion 完整降级：html scroll-behavior auto + 全局 animation/transition 归零 + reveal 直接显示 ✅（SPEC §5，缺失即 S3）
- 语义标签：nav aria-label / blockquote+cite / dl+dt+dd / table+th / section+h2 / footer ✅
- 装饰符号 ✗/✓/→ 全部 aria-hidden ✅（aria-* 共 11 处）
- 无 img，alt=0 合理 ✅

**团队语言一致性**：
- kicker mono 英文（EMPLOYEE_05 · INDEPENDENT GATE）✅
- 区块编号 01/02/03/04 + 中文 + mono 英文 ✅
- footer dl 落款（工位/入职/汇报/入口）✅
- reveal 滚动渐显 + reduced-motion ✅
- 返回官网 `../`（与小美/小知一致）✅

## 7. 缺陷清单与观察项

**缺陷清单**：无。无 S1 / S2 / S3。

**观察项（非缺陷，移交小夜姐知悉）**：
1. 本地 `/app` 根目录无 index.html，纯本地文件打开时 `href="../"`（返回官网）会 404。但 GitHub Pages 部署后 dist 根 index.html 由 frontend 构建产出（实测 / 返回 200），nginx alias 配置同样由站点根提供首页——属部署环境差异，非页面缺陷。若希望本地预览也完整，可在本地站点根放占位 index.html（不改页面代码）。

**改进建议（可选，不阻塞上线）**：
- 证据墙扩展规则已在 CSS/结构层面就绪（ev-item 结构 + 三态 verdict 预留），等小真产出第一份测试报告后补 ZH-002（PASS/FAIL/RUNNING），建议届时由小夜姐推动小真把真实报告放 `/app/xiaozhen/` 下并加链接。

## 8. 小真两条主验收（self-brief 第二部分 0 节）实测判定

1. **10 秒内说出「这是谁、负责什么、能不能信」** ✅
   - 首屏 = h1 小真 + 职务 + lead + QA GATE 状态卡（OWNER/ROLE/SIGNAL/STATUS: PASS），Creed 紧随首屏可见；无需滚动即可回答三问。
2. **30 秒内找到「缺陷找谁报、什么移交谁」** ✅
   - Header 锚点「边界」直达移交表（第 348–351 行），4 行成员链接（实现缺陷→小黑 / 环境→小优 / 设计→小美 / 派单→小夜姐）均可点击跳转，实测全部 200。

---

*报告完。发现缺陷不在此修复，移交小黑；观察项与改进建议移交小夜姐。*

## 9. 交付状态补充（关键发现，走查中核实）

> 走查时发现并核实：**小黑已完成重写但未提交 git**——v2 当前不会随 GitHub Pages 发布，线上仍是旧版。

- **证据**：`git log --oneline -3 -- xiaozhen/index.html` 最近相关提交为 `87a7ea0`（相对路径修复版）；`git status --short` 显示 ` M xiaozhen/index.html`（工作区有修改，未 add / 未 commit）。
- **影响**：GitHub Pages workflow 从仓库构建 dist 并拷贝成员目录；未提交 = 线上部署的仍是 v1（326 行旧版），v2（411 行）不会上线。
- **处置建议**：请小黑执行 `git add xiaozhen/index.html && git commit -m "..." && git push`；push 后 GitHub Actions 自动部署，v2 方可上线。
- **判定说明**：本 VQA 报告的 PASS 针对工作区中的 v2 实现本体（已实际走查的文件），与 git 提交状态无关。提交与部署是交付流程问题，移交小黑与小夜姐跟进。

*本补充为交付流程风险提示，非页面代码缺陷。*
