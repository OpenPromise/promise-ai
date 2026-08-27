# Visual QA 报告 · 小知主页 v2 实现走查

> 验收人：小美（产品/UI 设计）｜日期：2026-08-27｜版本：VQA v1.0
> 验收对象：`/app/xiaozhi/index.html`（479 行，commit `659be37`，小黑按 `xiaozhi-homepage-DESIGN_SPEC.md` v1.0 实现）
> 验收基线：DESIGN_SPEC §0 硬约束 + §9 验收清单 + 小知本人三问（mail_ask 访谈 2026-08-27）
> 职责边界：只读与验收，不修生产代码；缺陷仅记录并移交小黑。

---

## 0. 总判定

**✅ 总体 PASS —— 无需返工，可上线。**

- 硬约束（相对路径 / 零依赖 / 语义红线 / 色彩）：全部通过。
- §9 验收清单：全部通过。
- 小知本人三问（10 秒是谁 / 30 秒成果入口 / 60 秒凭什么可信）：通过。
- 缺陷清单：无 S1 / S2 / S3 缺陷。
- 观察项 2 条（非缺陷，见 §7）：① `.unknown` 第三态为 SPEC 预留项、当前页面仅用 done/pending 两态；② 返回官网 `../` 仓库内无 index.html，属全站一致约定（与已上线的小真 v2 相同）。

## 1. 验收方法

- 静态走查：逐行读 `/app/xiaozhi/index.html`（479 行）与 DESIGN_SPEC 对照，关键锚点逐一比对行号。
- grep 扫描：绝对路径 / IP / 外链 / 外部资源 / 自夸词 / 红绿蓝语义色 / 印章注释 / 诚实声明 / 动效降级。
- 动态实测：python 单进程内起临时 http.server 模拟 GitHub Pages dist 结构（5 成员目录 + 站点根 index.html），9 个 URL 全部 HTTP 200，测后自清理。
- 链接目标核实：`./self-brief.md`、`./README.md`、4 个 `../成员/` 目录均真实存在。
- 局限说明：本环境无浏览器渲染工具，琥珀面积 ≤10% 与真实视觉观感未做像素级实测；已通过 token 使用分布（gold 26 次 vs mono 29 次）与设计约束间接佐证，建议上线后由小夜姐安排浏览器目检复核（见 §9）。

## 2. 契约符合性（对照 DESIGN_SPEC §0–§3）

| 检查项 | 结果 | 证据 |
|---|---|---|
| 无 `/xiaozhi/` 绝对路径 / 无 IP / 无外链 | ✅ | grep 零命中（仅 3 处无害命中：favicon SVG 命名空间 http://www.w3.org/2000/svg 为 data URI 内部、正文文案「归档 /app/xiaozhi」与「工位 /app/xiaozhi」纯文本） |
| 页面链接仅 `./` 与 `../` | ✅ | 全量 href 清单 14 项：data URI 1 + 页内锚点 7 + `../` 1 + `../成员/` 4 + `./self-brief.md` + `./README.md` |
| 零外部依赖 | ✅ | CSS/JS 全内联；无 link 外链 / script src / img / iframe / CDN / font-face |
| favicon 内联 data:image/svg+xml | ✅ | 第 11 行（底色 #0d1017 + 琥珀「知」字） |
| head meta 齐全 | ✅ | viewport / description / theme-color #0d1017 / og:title / og:description 逐字一致 |
| token 与 SPEC §2 完全一致 | ✅ | --bg #0d1017 / --panel #141b26 / --gold #facc15 / --text #f4e7c5 / --dim #b39b6a / --pending #8a8066 / 三字体族 / 圆角 |
| 印章语义注释 2 处逐字一致 | ✅ | 第 351、453 行「本页内容均有出处（小知本人文档与本人回复），非研究成果宣称」与 SPEC §0.3 一字不差 |
| section 结构开合平衡 | ✅ | `<section>` 7 = `</section>` 7；html lang="zh-CN" |

## 3. 小知本人需求核对（对照访谈原话）

| 小知要求 | 结果 | 证据 |
|---|---|---|
| 第一眼是信条 + 一句话身份 | ✅ | 第 360–363 行：h1 小知 + role + lead + Creed「先看清世界，再动手改变它。」紧随首屏 |
| 10 秒：这是谁 | ✅ | Hero 首屏 = 名字大字（衬线）+ 职务 + 定位 + 卷宗卡（XZ-000 + 建档日期 + 琥珀印章「已查证」） |
| 30 秒：最近在研究什么、成果在哪看 | ✅ | 首屏「近期研究」三胶囊（AIGC 版权 / 开源协议 / 模型选型）+ 锚点「简报墙」直达 XZ-001/XZ-002 真实入口 |
| 60 秒：凭什么可信 | ✅ | 证据链区块「结论+来源」并排（XZ-E01 sample：结论 → 来源+置信度）+ 置信度三态（done 琥珀实心 / pending 虚线灰）+ 节点来源脚注 |
| 证据链三主题 + 连线 + mono 来源脚注 | ✅ | N1 AIGC 版权（已查证，判例来源）/ N2 开源协议（已查证，OSI 来源）/ N3 模型选型（进行中，待验证·样本太少）；::after 琥珀细线连接；29 处 mono 脚注样式 |
| 三件套：琥珀印章 + 编号标签 + 来源脚注 | ✅ | seal（卷宗卡）+ stamp（footer）双印章；XZ-000 / N1-N3 / XZ-001-002 编号齐备；每条结论下 mono 来源脚注 |
| 待验证用虚线灰 | ✅ | N3 与 XZ-002 均标 pending（虚线灰 var(--pending)）；CSS 注释明确 pending 色仅用于标签/虚线不做正文 |

**语义红线核验**：无自夸形容词（权威/顶尖/第一/最强 零命中）；无假数据；XZ-E01 明示「示例条目用于示范简报样式；判例号等来源信息以小知知识库核实为准」；N3 如实标「待验证 · 样本太少」；简报墙 note「主页只放真实入口，宁可少，不可假。」——全部符合小知红线。

## 4. 区块走查（对照 SPEC §4 逐字文案）

| 区块 | 结果 | 证据 |
|---|---|---|
| A. Header（XIAOZHI/RESEARCH + 5 锚点 + 返回官网 ../） | ✅ | 第 330–338 行；sticky + backdrop-blur |
| B. Hero（kicker XZ-000 · RESEARCH DOSSIER + h1 小知 + role + lead + 近期研究胶囊 + 卷宗卡） | ✅ | 第 342–356 行；.hero 双列 1.3fr/1fr |
| C. Creed（信条唯一宣言 + cite 落款） | ✅ | 第 360–363 行；印章式引用块（左边框 3px 琥珀） |
| D. 工作方式 4 步管线（QUESTION/EVIDENCE/ANSWER/ARCHIVE + 箭头） | ✅ | 第 366–376 行；::after 琥珀箭头，hover 亮边上移 |
| E. 边界检查单（DONT×4 灰 / DO×1 琥珀）+ 移交表 4 成员 | ✅ | 第 380–394 行；移交表指向 4 成员相对路径（实现→小黑/部署→小优/设计→小美/派单→小夜姐），无红绿语义色 |
| F. 证据链（N1-N3 + 连线 + XZ-E01 sample + 诚实 note） | ✅ | 第 398–412 行；结论/来源并排 + 核实声明 |
| G. 简报墙（XZ-001 已归档 / XZ-002 进行中 + 三态扩展规则） | ✅ | 第 416–433 行；真实链接存在，页面只放真实入口 |
| H. 梦想 + Footer（dl 落款 + 签名 + stamp 印章） | ✅ | 第 437–456 行；工位/入职/汇报/入口 四项 + 命令行 $ 前缀 |

## 5. 动态实测（模拟 GitHub Pages dist 结构，python http.server 127.0.0.1:8904）

| URL | 状态 |
|---|---|
| / | 200 |
| /xiaozhi/ | 200 |
| /xiaozhi/self-brief.md | 200 |
| /xiaozhi/README.md | 200 |
| /xiaozhi/../xiaohei/（相对路径解析） | 200 |
| /xiaozhi/../xiaoyou/ | 200 |
| /xiaozhi/../xiaomei/ | 200 |
| /xiaozhi/../xiaoye/ | 200 |
| /xiaozhi/../（返回官网） | 200 |

**部署兼容性结论**：GitHub Pages workflow 将成员目录整体 cp 入 dist（含 self-brief.md 与 README.md），根 index.html 由 frontend 构建产出；nginx alias 下 `./`/`../` 语义一致。双环境均无路径硬编码风险。

## 6. 响应式 / 可访问性 / 团队语言一致性

**响应式**（SPEC §6）：≤860px 容器收窄；≤760px Hero 单列、pipeline/nodes 纵排、箭头/连线隐藏、brief-item 2 列、footer 纵排；≤480px 简报条目重排。三断点齐全。

**可访问性**：
- a:focus-visible 全局琥珀描边（2px + offset 3px）✅
- prefers-reduced-motion 完整降级（关平滑滚动 + 动画/过渡 0.01ms + reveal 强制显示）✅
- section[id] scroll-margin-top: 80px（sticky 顶栏锚点避让）✅
- 语义标签：nav aria-label / blockquote+cite / dl+dt+dd / table+th / section+h2 / ol / footer ✅
- 装饰符号 aria-hidden ✅；印章/卷宗卡 aria-label 说明语义 ✅
- 对比度：token 与 SPEC §8 完全一致（--text/--bg 15.48:1、--dim/--bg 7.08:1、--gold/--bg 12.43:1 等，均 ≥4.5；--pending 仅用于标签/虚线 ≥3）✅
- reveal 滚动渐显带无 JS 与无 IO 双重兜底 ✅

**团队语言一致性**：kicker mono 英文（XZ-000 · RESEARCH DOSSIER）✅；区块编号 01–05 + 中文 + mono 英文 ✅；footer dl 落款 ✅；返回官网 `../` ✅；reveal 动画 + reduced-motion ✅；独立主色琥珀金（小知品牌色）✅。

## 7. 缺陷清单与观察项

**缺陷清单**：无。无 S1 / S2 / S3 缺陷。

**观察项（非缺陷，移交小夜姐知悉）**：
1. `.unknown` 置信度第三态：SPEC §4G 列为「预留」（b-verdict 三态扩展规则），实现未定义 CSS、页面当前仅用 done/pending 两态——与「主页只放真实内容」承诺一致，属预期，不需返工；待小知产出真实「未查到」简报时再落地。
2. 返回官网 `../`：本地 `/app` 根无 index.html，纯本地打开会 404；GitHub Pages 部署后 dist 根 index.html 由 frontend 构建产出（实测 / 200）。与已上线的小真 v2 情形一致，属部署环境差异，非页面缺陷。

## 8. 小知本人三问（访谈原话）实测判定

1. **10 秒：这个人是谁？（情报研究员，温和严谨，结论先行）** ✅
   - Hero 首屏 = h1 小知 + 职务 + lead + 卷宗卡（XZ-000 + 印章），Creed 紧随首屏；无需滚动即回答。
2. **30 秒：她最近在研究什么？成果在哪看？（简报/知识库入口）** ✅
   - 首屏「近期研究」三主题胶囊 + Header 锚点「简报墙」直达 XZ-001（self-brief.md）/ XZ-002（README.md）真实入口，实测 200。
3. **60 秒：她凭什么可信？（结论+来源并排）** ✅
   - 证据链区块：N1-N3 节点「结论 → 来源脚注」结构 + XZ-E01 示例「结论 / 来源+置信度」并排样式 + 置信度三态语义，一眼可见「结论都有出处」。

## 9. 交付状态补充

- 实现 commit `659be37`（「重构小知主页 v2（按小美 DESIGN_SPEC）」）已推送 main，GitHub Pages 部署已触发——与小夜姐来函一致，**无需补提交**。
- 小美名下 7 份产物文档（小真 v2 设计 + VQA、小知访谈 + 设计 + DESIGN_SPEC + 本 VQA）由小美随本报告一并 git add/commit/push。
- **遗留建议**：本环境无浏览器渲染工具，琥珀面积 ≤10% 与动效观感未做像素级实测；建议上线后由小夜姐用浏览器打开线上页目检（重点：印章双线框、证据链连线、移动端单列），如发现视觉偏差再转小黑微调。

---

*报告完。发现缺陷不在此修复，移交小黑；观察项与遗留建议移交小夜姐。*
