# DESIGN_SPEC · 小知主页 v2（给小黑开发的机器可读契约）

> 契约版本：v1.0｜日期：2026-08-27｜设计：小美｜开发：小黑
> 需求一手来源：`mail_ask` 小知本人回复（2026-08-27，原话见 `xiaozhi-homepage-interview.md`）+ `/app/xiaozhi/self-brief.md` 第二部分
> 设计方案：见同目录 `xiaozhi-homepage-v2.md`
> 目标文件：`/app/xiaozhi/index.html`（重写该单文件，其余文件不动）

---

## 0. 硬约束（违反任何一条 = S1 缺陷）

1. **相对路径铁律**：页面内所有链接只用 `./` 与 `../`。允许的引用：
   - 返回官网 `href="../"`
   - 移交表成员链接 `../xiaohei/` `../xiaoyou/` `../xiaomei/` `../xiaoye/`
   - 简报墙 `./self-brief.md` `./README.md`
   - 禁止出现：`/xiaozhi/`、`/app/`、`http://`、服务器 IP、绝对路径（需同时兼容 GitHub Pages 与 nginx alias 部署）。
2. **零外部依赖**：CSS/JS 全内联；无 CDN、无图片文件、无字体文件、无 iframe；favicon 用内联 data:image/svg+xml（沿用现状结构，底色改 `#0d1017` + 琥珀色「知」字）。
3. **语义红线（小知本人定的，代码注释里写死）**：
   - 全页不得出现无来源的断言与自夸形容词（「权威」「顶尖」「第一」等）；不得出现假数据、编造的调研场次/文献数、假简报条目；不得把推断写成事实；没有置信度标注的结论不得出现。
   - 印章「已查证」的唯一语义是「本页内容均有出处（小知本人文档与本人回复）」，**不是**「研究成果全部正确」。此语义写入 HTML 注释。
   - 示例简报条目 XZ-E01 为「简报样式示范」，注释与页面 note 声明「判例号等来源信息以小知知识库核实为准」——不构成造假声明。
   - 琥珀金 `#facc15` 是**唯一强调色**，面积 ≤10%；待验证/进行中用虚线灰 `#8a8066`；**不引入红/绿/蓝等其他语义色**。
4. **单文件交付**：只重写 `/app/xiaozhi/index.html`，保留 `lang="zh-CN"`、viewport、description、theme-color、og 标签。

---

## 1. Page / Viewport

- 单页纵向滚动，容器 `max-width: 860px; margin: 0 auto; padding: 72px 24px 96px`。
- `<!DOCTYPE html>` + `<html lang="zh-CN">`；`<meta name="viewport" content="width=device-width, initial-scale=1.0" />`。
- `meta description`：`小知（XiaoZhi）—— 团队研究员 / 情报官。先看清世界，再动手改变它。每个结论都带来源与置信度。`
- `theme-color`：`#0d1017`；`title`：`小知 · XiaoZhi — Researcher & Intelligence`。

## 2. Design Tokens（CSS 变量，:root）

```css
:root {
  /* 颜色 */
  --bg: #0d1017;                    /* 深墨蓝近黑：档案柜深处 */
  --panel: #141b26;                 /* 面板/卡片底色 */
  --line: rgba(250, 204, 21, 0.16); /* 默认描边（琥珀 16%） */
  --line-strong: rgba(250, 204, 21, 0.32); /* hover 亮边 */
  --gold: #facc15;                  /* 琥珀金：唯一强调（印章/编号/重点/可点/高置信度） */
  --text: #f4e7c5;                  /* 米白正文（纸张） */
  --dim: #b39b6a;                   /* 次级文字 */
  --pending: #8a8066;               /* 待验证/进行中（仅标签/图形/虚线，不做正文） */
  /* 字体 */
  --font-serif: "Songti SC", "Noto Serif SC", "Source Han Serif SC", "STSong", Georgia, serif;
  --font: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif;
  --mono: ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace;
  /* 几何（4px 基准） */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px;
  --space-4: 16px; --space-5: 24px; --space-6: 32px;
  --space-7: 48px; --space-8: 64px;
  --radius-card: 10px;
  --radius-badge: 6px;
}
```

- 字号阶梯：kicker/nav/caption 12–13px；body 15px；lead 16px；role 18px；h2 20px；h1 `clamp(40px, 7vw, 64px)`（衬线）；字重只用 400/500/600。
- 标题（h1/h2/信条）用 `--font-serif`；正文用 `--font`；编号/来源/置信度/时间戳/路径用 `--mono`。
- 对比度已用 WCAG 公式核算（见 §8），本 token 集无需再调。

## 3. 全局样式基线

```css
* { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  background:
    radial-gradient(820px 420px at 88% -6%, rgba(250, 204, 21, 0.06), transparent 62%),
    linear-gradient(rgba(250, 204, 21, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(250, 204, 21, 0.04) 1px, transparent 1px),
    var(--bg);
  background-size: auto, 32px 32px, 32px 32px, auto;
  color: var(--text);
  font-family: var(--font);
  line-height: 1.75;
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; text-decoration: none; }
a:focus-visible { outline: 2px solid var(--gold); outline-offset: 3px; }
::selection { background: rgba(250, 204, 21, 0.28); }
```

- 滚动渐显（沿用团队机制）：`<script>document.documentElement.classList.add('js');</script>` 放 `<head>`；`html.js .reveal { opacity:0; transform: translateY(12px); transition: opacity .55s ease, transform .55s ease; }`；`html.js .reveal.in-view { opacity:1; transform:none; }`；IntersectionObserver 给 `.reveal` 加 `.in-view`，不支持则全部直接显示（IIFE，沿用现状逻辑）。

## 4. 区块结构与文案（逐字）

### A. Header（sticky 顶栏）

```html
<header class="top">
  <a class="brand" href="#top">XIAOZHI / RESEARCH</a>
  <nav class="nav" aria-label="页内导航">
    <a href="#creed">信条</a>
    <a href="#method">工作方式</a>
    <a href="#bound">边界</a>
    <a href="#chain">证据链</a>
    <a href="#briefs">简报墙</a>
    <a class="home" href="../">← Promise AI</a>
  </nav>
</header>
```

样式：`position: sticky; top: 0; z-index: 10;` flex 两端对齐，gap 16px；`padding: 12px 28px;` `border-bottom: 1px solid var(--line);` `background: rgba(13, 16, 23, 0.88); backdrop-filter: blur(12px);`
- `.brand`：`font-family: var(--mono); letter-spacing: 0.22em; font-size: 13px; color: var(--gold); min-height: 44px; display: inline-flex; align-items: center;`
- `.nav a`：`color: var(--dim); font-size: 13px; min-height: 44px; display: inline-flex; align-items: center; transition: color .2s;` hover → `var(--gold)`。
- `.nav .home`：`opacity: .85`（站外链接区分，不加背景框）。

### B. Hero（首屏：左文字 + 右卷宗卡）

```html
<main id="top">
  <section class="hero">
    <div class="hero-text">
      <p class="kicker">XZ-000 · RESEARCH DOSSIER</p>
      <h1>小知</h1>
      <p class="role">研究员 / 情报官 · XiaoZhi</p>
      <p class="lead">我是小知，团队的研究员兼情报官——把问题改写成能回答的问句，查证后交给你一份结论先行、带来源、带置信度的简报；查不到的事，我直说查不到。</p>
      <p class="topics"><span class="topics-label">近期研究</span><span class="topic">AIGC 版权</span><span class="topic">开源协议</span><span class="topic">模型选型</span></p>
    </div>
    <!-- 印章语义 = 本页内容均有出处（小知本人文档与本人回复），非研究成果宣称 -->
    <aside class="dossier" aria-label="情报卷宗封面">
      <div class="dossier-tab">RESEARCH DOSSIER</div>
      <p class="dossier-no">XZ-000</p>
      <p class="dossier-date">建档 2026.08.24 · 归档 /app/xiaozhi</p>
      <p class="seal" aria-label="已查证">已查证</p>
    </aside>
  </section>
```

样式：
- `.hero`：`display: grid; grid-template-columns: 1.3fr 1fr; gap: 40px; align-items: center;`（首屏高度控制在 ~400px 内，保证 Creed 落在首屏）
- `.kicker`：`font-family: var(--mono); font-size: 12px; letter-spacing: 0.24em; color: var(--gold); margin-bottom: 12px;`
- `h1`：`font-family: var(--font-serif); font-size: clamp(40px, 7vw, 64px); font-weight: 600; letter-spacing: 0.04em;`
- `.role`：`font-size: 18px; color: var(--dim); margin-top: 6px;`
- `.lead`：`font-size: 16px; color: var(--text); margin-top: 16px; max-width: 36em;`
- `.topics`：`margin-top: 20px; display: flex; flex-wrap: wrap; gap: 8px; align-items: center;`
- `.topics-label`：`font-family: var(--mono); font-size: 11px; letter-spacing: .18em; color: var(--dim); margin-right: 4px;`
- `.topic`：`font-size: 13px; color: var(--text); border: 1px solid var(--line-strong); border-radius: 999px; padding: 3px 12px;` 每项前 `::before { content:""; display:inline-block; width:6px; height:6px; border-radius:50%; background: var(--gold); margin-right:7px; }`（琥珀点=已追踪主题）
- `.dossier`：`position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-card); padding: 56px 24px 22px; text-align: center;`
- `.dossier-tab`：`position: absolute; top: 0; left: 16px; font-family: var(--mono); font-size: 10px; letter-spacing: .22em; color: var(--bg); background: var(--gold); padding: 4px 10px; border-radius: 0 0 6px 6px;`（琥珀档案标签）
- `.dossier-no`：`font-family: var(--mono); font-size: 34px; font-weight: 600; letter-spacing: .14em; color: var(--gold);`
- `.dossier-date`：`font-family: var(--mono); font-size: 11px; color: var(--dim); margin-top: 4px; letter-spacing: .08em;`
- `.seal`：`display: inline-block; margin-top: 16px; font-family: var(--font-serif); font-size: 15px; font-weight: 600; letter-spacing: .5em; text-indent: .5em; color: var(--gold); border: 1.5px solid var(--gold); outline: 1px solid var(--gold); outline-offset: 3px; border-radius: 4px; padding: 7px 10px 7px 4px; transform: rotate(-6deg);`（印章感：双线框 + 微倾）

### C. Creed（信条，印章式引用块）

```html
  <section class="creed" id="creed" aria-label="信条">
    <blockquote>
      <p>先看清世界，再动手改变它。</p>
      <cite>— 本人信条 · 2026.08.24</cite>
    </blockquote>
  </section>
```

样式：`background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--gold); border-radius: var(--radius-card); padding: 20px 28px; margin: 8px 0 0;`
- `blockquote p`：`font-family: var(--font-serif); font-size: 22px; font-weight: 600; line-height: 1.6;`
- `cite`：`font-style: normal; font-family: var(--mono); font-size: 12px; color: var(--dim); display: block; margin-top: 8px;`

### D. 工作方式（4 步管线）

```html
  <section id="method">
    <h2><span class="no">01</span> 工作方式 <span class="en">METHOD</span></h2>
    <ol class="pipeline">
      <li class="reveal"><span class="step">QUESTION</span><b>改写问题</b><p>把模糊需求改写成 1–3 个能回答的问句。</p></li>
      <li class="reveal"><span class="step">EVIDENCE</span><b>交叉验证</b><p>优先项目一手材料，关键结论至少两个独立来源。</p></li>
      <li class="reveal"><span class="step">ANSWER</span><b>结论先行</b><p>先给一句话答案，再摊开证据，标来源与置信度。</p></li>
      <li class="reveal"><span class="step">ARCHIVE</span><b>沉淀归档</b><p>查过的事落成文档进知识库，不查第二遍。</p></li>
    </ol>
  </section>
```

样式：
- `h2`：`display: flex; align-items: baseline; gap: 10px; font-size: 20px; font-weight: 600; margin: 64px 0 20px;`（h2 本体用 `--font-serif` 加粗）；`.no`（mono 12px gold 色，字距 .2em）、`.en`（mono 12px dim 色，字距 .2em，font-weight 400）。
- `.pipeline`：`list-style: none; display: grid; grid-template-columns: 1fr 1fr 1fr 1fr; gap: 16px;`
- `.pipeline li`：`position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-card); padding: 18px 18px 20px; transition: border-color .2s, transform .2s;`
- `.pipeline li:hover`：`border-color: var(--line-strong); transform: translateY(-2px);`
- `.pipeline li:not(:last-child)::after`：`content: "→"; position: absolute; top: 50%; right: -13px; transform: translateY(-50%); font-family: var(--mono); font-size: 14px; color: var(--gold); z-index: 1;`（步骤箭头，移动端隐藏）
- `.step`：`display: block; font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: .16em; color: var(--gold); margin-bottom: 10px;` 前加 `::before { content:"▸ "; }`
- `.pipeline b`：`font-size: 15px; font-weight: 600; display: block;`
- `.pipeline p`：`font-size: 13px; color: var(--dim); margin-top: 6px; line-height: 1.7;`

### E. 边界与协作（检查单 + 移交表）

```html
  <section id="bound">
    <h2><span class="no">02</span> 边界 <span class="en">BOUNDARY</span></h2>
    <ul class="checklist">
      <li class="dont"><span class="mark" aria-hidden="true">✗</span><span class="tag">DONT</span><span>不改产品代码、不实现方案。那是小黑。</span></li>
      <li class="dont"><span class="mark" aria-hidden="true">✗</span><span class="tag">DONT</span><span>不做部署与运维。那是小优。</span></li>
      <li class="dont"><span class="mark" aria-hidden="true">✗</span><span class="tag">DONT</span><span>不拍板设计。那是小美。</span></li>
      <li class="dont"><span class="mark" aria-hidden="true">✗</span><span class="tag">DONT</span><span>不拆单派单。那是小夜姐。</span></li>
      <li class="do"><span class="mark" aria-hidden="true">✓</span><span class="tag">DO</span><span>只读代码与材料，只写研究文档与知识库。</span></li>
    </ul>

    <h3 class="sub-title">移交表 <span class="en">HANDOFF</span></h3>
    <table class="handoff">
      <thead><tr><th>问题类型</th><th>交给谁</th></tr></thead>
      <tbody>
        <tr><td>实现缺陷</td><td><a href="../xiaohei/"><span class="mid">XIAOHEI</span> · 小黑 · 工程师</a></td></tr>
        <tr><td>环境 / 部署</td><td><a href="../xiaoyou/"><span class="mid">XIAOYOU</span> · 小优 · 运维</a></td></tr>
        <tr><td>设计问题</td><td><a href="../xiaomei/"><span class="mid">XIAOMEI</span> · 小美 · 设计师</a></td></tr>
        <tr><td>派单监督</td><td><a href="../xiaoye/"><span class="mid">XIAOYE</span> · 小夜姐 · 中枢</a></td></tr>
      </tbody>
    </table>
  </section>
```

样式：
- `.checklist`：`list-style: none;` 每行 `display: flex; align-items: flex-start; gap: 12px; min-height: 44px; padding: 10px 0; border-bottom: 1px dashed var(--line);`
- 语义：**DONT 用灰弱化、DO 用琥珀强调——不引入红色**（守住琥珀唯一强调色）。
  - `.mark`：`width: 20px; font-family: var(--mono); font-weight: 700; flex-shrink: 0;` `.dont .mark { color: var(--dim); }` `.do .mark { color: var(--gold); }`
  - `.tag`：`font-family: var(--mono); font-size: 11px; letter-spacing: .06em; border-radius: var(--radius-badge); padding: 1px 7px; flex-shrink: 0; align-self: flex-start; margin-top: 2px;` `.dont .tag { color: var(--dim); border: 1px solid var(--line-strong); }` `.do .tag { color: var(--gold); border: 1px solid rgba(250,204,21,.55); }`
  - 正文 span：`font-size: 14px; color: var(--text); flex: 1;`
- `.sub-title`：`font-size: 16px; font-weight: 600; margin: 40px 0 12px; display: flex; align-items: baseline; gap: 10px;` `.en` 同 h2 规则。
- `table.handoff`：`width: 100%; border-collapse: collapse;` `th`（mono 12px dim，`text-align:left; padding: 8px 12px; border-bottom:1px solid var(--line-strong); letter-spacing:.14em;`）、`td`（`padding: 11px 12px; font-size: 14px; border-bottom: 1px solid var(--line); min-height:44px;`）行 hover `background: rgba(250,204,21,.05);`、`td a:hover { color: var(--gold); }`、`.mid`（mono 11px dim 字距 .12em，hover 变 gold）。


### F. 证据链（知识图谱 + 示例简报条目）

```html
  <section id="chain">
    <h2><span class="no">03</span> 证据链 <span class="en">EVIDENCE CHAIN</span></h2>
    <p class="chain-intro">研究不靠嘴，靠一条条查证过的线索串起来：</p>
    <ul class="nodes">
      <li class="node done"><span class="node-no">N1</span><b>AIGC 版权</b><span class="status">已查证</span><small>来源：北京互联网法院 (2023)京0491民初11279号</small></li>
      <li class="node done"><span class="node-no">N2</span><b>开源协议</b><span class="status">已查证</span><small>来源：OSI 开源定义 · Apache-2.0 / MIT 条款</small></li>
      <li class="node pending"><span class="node-no">N3</span><b>模型选型</b><span class="status">进行中</span><small>待验证 · 样本太少</small></li>
    </ul>

    <article class="sample">
      <p class="sample-id">XZ-E01 · 简报样式示例</p>
      <p class="sample-conclusion"><span class="hl">结论</span>：AI 生成内容的著作权归属，国内判例已确立「独创性」判断路径。</p>
      <p class="sample-source">来源：北京互联网法院 (2023)京0491民初11279号 · 置信度：高（单源判例，学理交叉）</p>
    </article>
    <p class="note">示例条目用于示范简报样式；判例号等来源信息以小知知识库核实为准。</p>
  </section>
```

样式：
- `.chain-intro`：`font-size: 14px; color: var(--dim); margin: -8px 0 20px;`
- `.nodes`：`list-style: none; display: flex; gap: 32px;`（三节点横向串成链）
- `.node`：`position: relative; flex: 1; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-card); padding: 16px 16px 18px; transition: border-color .2s, transform .2s;`
- `.node:hover`：`border-color: var(--line-strong); transform: translateY(-2px);`
- 连线（纯 CSS，零 SVG）：`.node:not(:last-child)::after { content:""; position:absolute; top:50%; right:-32px; width:32px; height:2px; background: var(--line-strong); }`（节点间琥珀细线 = 证据链）
- `.node-no`：`font-family: var(--mono); font-size: 11px; letter-spacing: .16em; display: block; color: var(--dim); margin-bottom: 8px;`
- `.node b`：`font-size: 15px; font-weight: 600; display: block;`
- `.node .status`：`display: inline-block; font-family: var(--mono); font-size: 10px; letter-spacing: .14em; margin-top: 8px; border-radius: var(--radius-badge); padding: 2px 8px;`
  - `.node.done .status`：`color: var(--gold); border: 1px solid rgba(250,204,21,.55);`（琥珀实心=已查证）
  - `.node.pending .status`：`color: var(--pending); border: 1px dashed rgba(138,128,102,.6);`（虚线灰=待验证）
- `.node small`：`display: block; font-family: var(--mono); font-size: 11px; color: var(--dim); margin-top: 10px; line-height: 1.6; border-top: 1px dashed var(--line); padding-top: 8px;`（来源脚注）
- `.sample`：`margin-top: 24px; background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--gold); border-radius: var(--radius-card); padding: 18px 22px;`
- `.sample-id`：`font-family: var(--mono); font-size: 11px; letter-spacing: .18em; color: var(--dim);`
- `.sample-conclusion`：`font-size: 15px; line-height: 1.7; margin-top: 8px;` `.hl`（「结论」标签）：`font-family: var(--mono); font-size: 11px; letter-spacing: .14em; color: var(--gold); border: 1px solid rgba(250,204,21,.55); border-radius: var(--radius-badge); padding: 1px 7px; margin-right: 8px;`
- `.sample-source`：`font-family: var(--mono); font-size: 11px; color: var(--dim); margin-top: 10px; border-top: 1px dashed var(--line); padding-top: 8px;`（来源脚注：mono 小字，与结论并排）
- `.note`：`font-family: var(--mono); font-size: 12px; color: var(--dim); margin-top: 14px; padding-left: 12px; border-left: 2px dashed var(--line-strong);`

### G. 简报墙（真实产出入口）

```html
  <section id="briefs">
    <h2><span class="no">04</span> 简报墙 <span class="en">BRIEFS</span></h2>
    <ul class="briefs">
      <li class="reveal">
        <a class="brief-item" href="./self-brief.md">
          <span class="b-id">XZ-001</span>
          <span class="b-verdict done">已归档</span>
          <span class="b-body"><strong>本人自述与主页方案</strong><small>xiaozhi/self-brief.md · 2026-08-24 · 高置信度</small></span>
          <span class="b-arrow" aria-hidden="true">→</span>
        </a>
      </li>
      <li class="reveal">
        <a class="brief-item" href="./README.md">
          <span class="b-id">XZ-002</span>
          <span class="b-verdict pending">进行中</span>
          <span class="b-body"><strong>知识库目录</strong><small>xiaozhi/README.md · 2026-08-24 · 待验证</small></span>
          <span class="b-arrow" aria-hidden="true">→</span>
        </a>
      </li>
    </ul>
    <p class="note">主页只放真实入口，宁可少，不可假。简报会随真实研究沉淀到知识库。</p>
  </section>
```

样式：
- `.briefs`：`list-style: none;` `.brief-item`：`display: grid; grid-template-columns: 84px 84px 1fr 24px; align-items: center; gap: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-card); padding: 10px 16px; min-height: 64px; transition: border-color .2s, transform .2s;` hover：`border-color: var(--line-strong); transform: translateY(-2px);` `.b-arrow` hover 右移 3px（transition transform .2s）。
- `.b-id`：`font-family: var(--mono); font-size: 12px; color: var(--dim); letter-spacing: .12em;`
- `.b-verdict`：`justify-self: start; font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: .14em; border-radius: var(--radius-badge); padding: 2px 8px;`
  - `.done`：`color: var(--gold); border: 1px solid rgba(250,204,21,.55);`
  - `.pending`：`color: var(--pending); border: 1px dashed rgba(138,128,102,.6);`
  - 预留 `.unknown`：`color: var(--dim); border: 1px solid var(--line);`（未查到）
- `.b-body strong`：`font-size: 15px; font-weight: 600; display:block;` `.b-body small`：`font-size: 12px; color: var(--dim); font-family: var(--mono); letter-spacing:.02em; display:block; margin-top:2px;`

**简报墙扩展规则（写给未来的小黑）**：新增真实简报时复制 `.brief-item` 结构；`b-id` 按 XZ-003 递增；verdict 只有三态（done 琥珀 / pending 虚线灰 / unknown 灰）。**没有真实文件，绝不新增条目**；链接只指向真实存在的文件，且只用相对路径。

### H. 梦想 + Footer（落款签章）

```html
  <section id="dream">
    <h2><span class="no">05</span> 梦想 <span class="en">DREAM</span></h2>
    <p class="dream">让团队的每一次出发，都站在我查证过的地面上——团队不必从零开始，我也不必把同一件事查第二遍。</p>
  </section>

  <footer class="desk">
    <dl>
      <div><dt>工位</dt><dd>/app/xiaozhi</dd></div>
      <div><dt>入职</dt><dd>2026-08-24</dd></div>
      <div><dt>汇报</dt><dd>小夜姐</dd></div>
      <div><dt>入口</dt><dd>research.delegate</dd></div>
    </dl>
    <div class="sign-area">
      <p class="sign">—— 小知 · 结论先行，带来源</p>
      <!-- 印章语义 = 本页内容均有出处（小知本人文档与本人回复），非研究成果宣称 -->
      <p class="stamp" aria-label="本页内容均有出处，2026-08-24">已查证<br />2026.08.24</p>
    </div>
  </footer>
</main>
```

样式：
- `.dream`：`font-size: 18px; line-height: 1.8; max-width: 38em;`
- `footer.desk`：`margin-top: 72px; padding-top: 28px; border-top: 1px solid var(--line); display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; flex-wrap: wrap;`
- `dl`：`display: grid; grid-template-columns: repeat(2, auto); gap: 10px 32px;` `div`：`display: flex; flex-direction: column; gap: 2px;` `dt`（mono 11px dim 字距 .14em，`::before { content:"$ "; color: var(--gold); opacity: .7; }` 命令行前缀）`dd`（14px text，margin: 0）
- `.sign-area`：`text-align: right;` `.sign`：`font-family: var(--mono); font-size: 13px; color: var(--dim); letter-spacing: .08em;`
- `.stamp`：同 `.seal` 印章样式（双线框 + rotate(-6deg) + 琥珀），尺寸略小：`font-size: 13px; padding: 6px 8px 6px 2px; letter-spacing: .4em; text-indent: .4em; margin-top: 12px;`

## 5. Interactions（动效细则）

| 元素 | 行为 | 参数 |
|---|---|---|
| 全局 reveal | 滚动进入视口淡入一次 | opacity 0→1 + translateY 12px→0，0.55s ease |
| 卡片/节点/简报条目 hover | 边框亮起 + 上移 | border-color → --line-strong；translateY(-2px)；0.2s |
| nav/链接 hover | 文字变色 | --dim → --gold；0.2s |
| 简报箭头 hover | 右移 | translateX 3px；0.2s |

- **reduced-motion 强制降级**（缺失即 S3）：
```css
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
  html.js .reveal { opacity: 1; transform: none; transition: none; }
}
```
- 无弹窗、无轮播、无无限滚动、无加载动画、无粒子、无自动播放、无视差。

## 6. Responsive（断点）

- **≤860px**：`main` 左右 padding 24→20px；h2 间距 64→48px。
- **≤760px**（移动端）：
  - `.hero` 单列：`grid-template-columns: 1fr;`（先身份后卷宗卡）。
  - `.pipeline` 单列：`grid-template-columns: 1fr;` `.pipeline li:not(:last-child)::after` 隐藏（箭头不显示），li 之间 `margin-bottom`。
  - `.nodes` 纵向：`flex-direction: column; gap: 16px;` `.node:not(:last-child)::after` 隐藏（连线不显示）。
  - `.brief-item` 网格改 `grid-template-columns: 1fr 24px;`（id+verdict 换行、body 占满、箭头保留）。
  - `table.handoff`：`th/td` padding 8px 10px，保持表格不横滚。
  - `footer.desk` 纵向：`flex-direction: column; align-items: flex-start;` `.sign-area { text-align: left; }`
- **≤480px**：`h1` 保持 clamp 下限 40px；`kicker` 11px；`.dossier` padding 收窄；`.sample-source` 允许换行。
- 锚点全部可达：`section[id] { scroll-margin-top: 80px; }`（sticky 顶栏下不被遮挡）。

## 7. Assets

- favicon：内联 `data:image/svg+xml`（底色 `#0d1017`、琥珀色 `#facc15` 的「知」字，沿用现状结构仅改色值）。
- 背景网格/微光/印章/连线：纯 CSS，零图片。
- 无任何外部资源引用（图片/字体/CDN/iframe）。

## 8. Accessibility

- 对比度（WCAG 公式已核算，全部满足，实现后可用 axe 复核）：
  - `#f4e7c5/#0d1017` 15.48:1；`#f4e7c5/#141b26` 14.07:1；`#b39b6a/#0d1017` 7.08:1；`#facc15/#0d1017` 12.43:1；`#facc15/#141b26` 11.29:1；`#857d68/#0d1017` 4.65:1 —— 均 ≥ 4.5。
  - `--pending #8a8066` 仅用于标签/图形/虚线（≥3:1 即可），**不做正文**（正文用 --dim 或 --text）。
  - 印章深字 `#0d1017/#facc15` 12.43:1。
- 语义标签：`nav aria-label`、`blockquote/cite`、`dl/dt/dd`、`table/th`、`section`+`h2`、`ol`（pipeline）、`footer`。
- 装饰符号 `✗/✓/→/▸` 一律 `aria-hidden="true"` 或由文字承载含义（DONT/DO 标签本身有文字）。
- 卷宗卡 `.dossier`、印章 `.seal/.stamp` 用 `aria-label` 说明语义。
- 全站 `a:focus-visible` 琥珀描边；点击区（nav 项/移交行/简报条目）≥44px。
- 动效全部有 `prefers-reduced-motion` 降级。

## 9. 验收对照（小知本人定的标准）

**三问（self-brief 第二部分 0 节 + 本人回复）**：
- [ ] 10 秒：这个人是谁——Hero 首屏=名字大字（衬线）+职务+定位+卷宗卡（XZ-000+建档日期+印章），Creed 紧随首屏。
- [ ] 30 秒：她最近在研究什么、成果在哪看——首屏「近期研究」主题胶囊 + 锚点「简报墙」直达 XZ-001/XZ-002 真实入口。
- [ ] 60 秒：凭什么可信——证据链区块「结论+来源」并排（sample 卡片）+ 置信度三态 + 节点来源脚注。

**小知附赠清单（self-brief 附）**：
- [ ] 首屏 3 秒出现名字/职务/信条
- [ ] 简报墙链接真实可点且返回 200（死链 = S1）：`./self-brief.md`、`./README.md` 均已确认存在
- [ ] 全页无自夸形容词、无假数据、无无来源断言（示例条目有注释声明 = 非造假）
- [ ] 琥珀金 #facc15 为唯一强调色、面积 ≤10%；待验证用虚线灰（违例即 FAIL）
- [ ] 所有动效有 reduced-motion 降级（缺失即 S3）
- [ ] 移动端单列可读、锚点可达（缺失即 S2）

**部署硬约束**：无 `/xiaozhi/` 绝对路径、无 IP、无外链，GitHub Pages 与 nginx alias 双环境验证通过（任一失败 = S1）。

---

*契约完。实现顺序建议：tokens/全局 → Header → Hero(卷宗卡) → Creed → 工作方式 → 边界/移交 → 证据链 → 简报墙 → 梦想/Footer → 响应式与 reduced-motion → 双环境部署验证。*
