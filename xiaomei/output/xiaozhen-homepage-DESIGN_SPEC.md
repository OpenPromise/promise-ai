# DESIGN_SPEC · 小真主页 v2（给小黑开发的机器可读契约）

> 契约版本：v1.0｜日期：2026-08-27｜设计：小美｜开发：小黑
> 需求一手来源：`/app/xiaozhen/self-brief.md` 第二部分（小真本人所写）
> 设计方案：见同目录 `xiaozhen-homepage-v2.md`
> 目标文件：`/app/xiaozhen/index.html`（重写该单文件，其余文件不动）

---

## 0. 硬约束（违反任何一条 = S1 缺陷）

1. **相对路径铁律**：页面内所有链接只用 `./` 与 `../`。允许的引用：
   - 返回官网 `href="../"`
   - 移交表成员链接 `../xiaohei/` `../xiaoyou/` `../xiaomei/` `../xiaoye/`
   - 证据墙 `./self-brief.md`
   - 禁止出现：`/xiaozhen/`、`/app/`、`http://`、服务器 IP、绝对路径（需同时兼容 GitHub Pages 与 nginx alias 部署）。
2. **零外部依赖**：CSS/JS 全内联；无 CDN、无图片文件、无字体文件、无 iframe；favicon 用内联 data:image/svg+xml（沿用现状）。
3. **语义红线（小真本人定的，代码注释里写死）**：
   - 全页不得出现自夸形容词（如「业界顶尖」「100% 可靠」）。
   - 不得出现伪造的测试数据、编造的验收记录、假绿勾。
   - `PASS`/`PASSED` 徽章的唯一语义是「本页自检通过」（页面真实包含 身份/职责/边界/证据/移交 全部要素），**不是**「小真的工作全部通过」。此语义写入 HTML 注释。
   - 玫红 `#fb7185` 只允许用于：边界清单 DONT 的 ✗ 符号、DONT 标签描边。禁止用作装饰。
4. **单文件交付**：只重写 `/app/xiaozhen/index.html`，保留 `lang="zh-CN"`、viewport、description、theme-color `#07140f`、og 标签。

---

## 1. Page / Viewport

- 单页纵向滚动，容器 `max-width: 860px; margin: 0 auto; padding: 72px 24px 96px`。
- `<!DOCTYPE html>` + `<html lang="zh-CN">`；`<meta name="viewport" content="width=device-width, initial-scale=1.0" />`。
- `meta description`：`小真（XiaoZhen）—— 团队专属 QA 工程师。谁交付了什么，我先立验收标准，再动手查。没有证据的「能用」，等于不能用。`
- `title`：`小真 · XiaoZhen — QA Engineer`

## 2. Design Tokens（CSS 变量，:root）

```css
:root {
  /* 颜色 */
  --bg: #07140f;                    /* 页面底色 */
  --panel: #0c1c16;                 /* 卡片/面板底色 */
  --line: rgba(74, 222, 128, 0.16); /* 默认描边 */
  --line-strong: rgba(74, 222, 128, 0.32); /* 新增：hover 亮边 */
  --pass: #4ade80;                  /* 翠绿：PASS/可点/重点/编号（语义色，克制使用） */
  --fail: #fb7185;                  /* 玫红：仅 FAIL 与 DONT 标注 */
  --text: #e8f5ec;                  /* 正文 */
  --dim: #8aa896;                   /* 次级文字/标签 */
  /* 字体 */
  --font: "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif;
  --mono: ui-monospace, "Cascadia Code", "JetBrains Mono", Consolas, monospace;
  /* 几何（4px 基准） */
  --space-1: 4px;  --space-2: 8px;  --space-3: 12px;
  --space-4: 16px; --space-5: 24px; --space-6: 32px;
  --space-7: 48px; --space-8: 64px;
  --radius-card: 12px;
  --radius-badge: 6px;
}
```

- 字号阶梯：kicker/nav/caption 12–13px；body 15px；lead 16px；role 18px；h2 20px；h1 `clamp(40px, 7vw, 64px)`。字重只用 400/500/600。
- 字号样式速查：`--fs-body: 15px`、`--fs-lead: 16px`、`--fs-title: 20px`、`--fs-display: clamp(40px,7vw,64px)`、`--fs-caption: 12px`。
- 对比度已用 WCAG 公式核算（见 §9），本 token 集无需再调。

## 3. 全局样式基线

```css
* { box-sizing: border-box; margin: 0; padding: 0; }
html { scroll-behavior: smooth; }
body {
  background:
    radial-gradient(820px 420px at 88% -6%, rgba(74, 222, 128, 0.06), transparent 62%),
    linear-gradient(rgba(74, 222, 128, 0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(74, 222, 128, 0.04) 1px, transparent 1px),
    var(--bg);
  background-size: auto, 32px 32px, 32px 32px, auto;
  color: var(--text);
  font-family: var(--font);
  line-height: 1.75;
  min-height: 100vh;
  -webkit-font-smoothing: antialiased;
}
a { color: inherit; text-decoration: none; }
a:focus-visible { outline: 2px solid var(--pass); outline-offset: 3px; }
::selection { background: rgba(74, 222, 128, 0.28); }
```

- 滚动渐显（沿用现状机制，保留）：`<script>document.documentElement.classList.add('js');</script>` 放在 `<head>`；`html.js .reveal { opacity:0; transform: translateY(12px); transition: opacity .55s ease, transform .55s ease; }`；`html.js .reveal.in-view { opacity:1; transform:none; }`；IntersectionObserver 在 `.js` 类存在时给 `.reveal` 加 `.in-view`，不支持则全部直接显示（IIFE，沿用现状逻辑）。

## 4. 区块结构与文案（逐字）

### A. Header（sticky 顶栏）

```html
<header class="top">
  <a class="brand" href="#top">XIAOZHEN / QA</a>
  <nav class="nav" aria-label="页内导航">
    <a href="#creed">信条</a>
    <a href="#duty">职责</a>
    <a href="#bound">边界</a>
    <a href="#evidence">证据墙</a>
    <a href="#dream">梦想</a>
    <a class="home" href="../">← Promise AI</a>
  </nav>
</header>
```

样式：`position: sticky; top: 0; z-index: 10;` flex 两端对齐，gap 16px；`padding: 12px 28px;` `border-bottom: 1px solid var(--line);` `background: rgba(7, 20, 15, 0.88); backdrop-filter: blur(12px);`
- `.brand`：`font-family: var(--mono); letter-spacing: 0.22em; font-size: 13px; color: var(--pass); min-height: 44px; display: inline-flex; align-items: center;`
- `.nav a`：`color: var(--dim); font-size: 13px; min-height: 44px; display: inline-flex; align-items: center; transition: color .2s;` hover → `var(--pass)`。
- `.nav .home` 保持与其他项同风格（加个 `opacity:.85` 区分站外链接即可，不加背景框）。

### B. Hero（首屏，含全新「QA GATE 状态卡」）

```html
<main id="top">
  <section class="hero">
    <div class="hero-text">
      <p class="kicker">EMPLOYEE_05 · INDEPENDENT GATE</p>
      <h1>小真</h1>
      <p class="role">测试 / QA 工程师 · XiaoZhen</p>
      <p class="lead">谁交付了什么，我先立验收标准，再动手查，最后只给两种结论：有证据的 PASS，或者带复现路径的 FAIL。</p>
    </div>
    <!-- PASS 语义 = 本页自检通过（身份/职责/边界/证据/移交 全部真实存在），非工作成果宣称 -->
    <aside class="gate" aria-label="QA 门禁自检卡">
      <p class="gate-title">QA GATE · SELF-CHECK</p>
      <div class="gate-status">
        <svg class="gate-check" viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <span class="gate-verdict">STATUS: PASS</span>
      </div>
      <dl class="gate-meta">
        <div><dt>OWNER</dt><dd>小真</dd></div>
        <div><dt>ROLE</dt><dd>QA ENGINEER</dd></div>
        <div><dt>LAST RUN</dt><dd>2026-08-24</dd></div>
        <div><dt>SIGNAL</dt><dd>独立验收 · 只报不修</dd></div>
      </dl>
      <p class="gate-note">自检：身份 ✓ · 职责 ✓ · 边界 ✓ · 证据 ✓ · 移交 ✓</p>
    </aside>
  </section>
```

样式：
- `.hero`：`display: grid; grid-template-columns: 1.25fr 1fr; gap: 40px; align-items: center;`（首屏高度控制在 ~380px 内，保证下面的 Creed 落在首屏）
- `.kicker`：`font-family: var(--mono); font-size: 12px; letter-spacing: 0.24em; color: var(--pass); margin-bottom: 12px;`
- `h1`：`font-size: clamp(40px, 7vw, 64px); font-weight: 600; letter-spacing: 0.02em;`
- `.role`：`font-size: 18px; color: var(--dim); margin-top: 6px;`
- `.lead`：`font-size: 16px; color: var(--text); margin-top: 16px; max-width: 34em;`
- `.gate`：`background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-card); padding: 20px 24px;` 顶部 2px 翠绿实线（`border-top: 2px solid var(--pass)`），像门禁卡。
- `.gate-title`：`font-family: var(--mono); font-size: 11px; letter-spacing: 0.18em; color: var(--dim);`
- `.gate-status`：flex 对齐，margin: 14px 0 16px；`.gate-check { color: var(--pass); animation: gate-pulse 2.4s ease-in-out infinite; }` `@keyframes gate-pulse { 0%,100%{transform:scale(1);} 50%{transform:scale(1.05);} }`
- `.gate-verdict`：`font-family: var(--mono); font-size: 20px; font-weight: 600; letter-spacing: 0.08em; color: var(--pass);`
- `.gate-meta`：`display: grid; grid-template-columns: 1fr 1fr; gap: 8px 20px;` 每行 `dt { font-family: var(--mono); font-size: 11px; color: var(--dim); letter-spacing: 0.14em; }` `dd { font-size: 14px; color: var(--text); margin-top: 1px; }` 行高 ≥44px（div 设 `display:flex; flex-direction:column; justify-content:center; min-height:44px`）。
- `.gate-note`：`font-family: var(--mono); font-size: 11px; color: var(--dim); margin-top: 14px; border-top: 1px dashed var(--line); padding-top: 10px;`

### C. Creed（信条，签章式引用块）

```html
  <section class="creed" id="creed" aria-label="信条">
    <blockquote>
      <p>没有证据的「能用」，等于不能用。</p>
      <cite>— 本人信条 · 2026.08.24</cite>
    </blockquote>
  </section>
```

样式：`background: var(--panel); border: 1px solid var(--line); border-left: 3px solid var(--pass); border-radius: var(--radius-card); padding: 20px 28px; margin: 8px 0 0;`
- `blockquote p`：`font-size: 22px; font-weight: 500; line-height: 1.6;`
- `cite`：`font-style: normal; font-family: var(--mono); font-size: 12px; color: var(--dim); display: block; margin-top: 8px;`

### D. 职责（4 卡，编号 D-01..04）

```html
  <section id="duty">
    <h2><span class="no">01</span> 职责 <span class="en">DUTY</span></h2>
    <div class="grid">
      <article class="card">
        <span class="card-no">D-01</span>
        <b>独立验收</b>
        <p>小黑交付之后，我再跑一遍。验收方与实现方必须分开。</p>
      </article>
      <article class="card">
        <span class="card-no">D-02</span>
        <b>证据优先</b>
        <p>每个结论都要有命令输出或复现路径。「应该没问题」不算数。</p>
      </article>
      <article class="card">
        <span class="card-no">D-03</span>
        <b>只报不修</b>
        <p>发现缺陷写进清单，修复归小黑。我不改产品代码。</p>
      </article>
      <article class="card">
        <span class="card-no">D-04</span>
        <b>绿灯值钱</b>
        <p>团队冲得越快，我的 PASS 就越不能随便亮。</p>
      </article>
    </div>
  </section>
```

样式：
- `h2`：`display: flex; align-items: baseline; gap: 10px; font-size: 20px; font-weight: 600; margin: 64px 0 20px;` `.no`（mono 12px pass 色，字距 .2em）、`.en`（mono 12px dim 色，字距 .2em，font-weight 400）。
- `.grid`：`display: grid; grid-template-columns: 1fr 1fr; gap: 16px;`（≤760px 单列）
- `.card`：`position: relative; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-card); padding: 20px 22px 22px; transition: border-color .2s, transform .2s;` `::before`（左侧 2px 竖条）：`content:""; position:absolute; left:0; top:16px; bottom:16px; width:2px; background: var(--pass); border-radius: 2px;`
- `.card:hover`：`border-color: var(--line-strong); transform: translateY(-2px);`
- `.card-no`：`font-family: var(--mono); font-size: 11px; color: var(--dim); letter-spacing: 0.18em; display:block; margin-bottom: 8px;`
- `.card b`：`font-size: 16px; font-weight: 600; display:block;`
- `.card p`：`font-size: 14px; color: var(--dim); margin-top: 6px; line-height: 1.7;`

### E. 边界（检查单 + 移交表）

```html
  <section id="bound">
    <h2><span class="no">02</span> 边界 <span class="en">BOUNDARY</span></h2>
    <ul class="checklist">
      <li class="dont"><span class="mark" aria-hidden="true">✗</span><span class="tag">DONT</span><span>不改产品代码。修复是小黑的职责，验收方必须和实现方保持独立。</span></li>
      <li class="dont"><span class="mark" aria-hidden="true">✗</span><span class="tag">DONT</span><span>不碰部署与运维。那是小优。</span></li>
      <li class="dont"><span class="mark" aria-hidden="true">✗</span><span class="tag">DONT</span><span>不拍板设计。那是小美。</span></li>
      <li class="dont"><span class="mark" aria-hidden="true">✗</span><span class="tag">DONT</span><span>不派单。那是小夜姐。</span></li>
      <li class="do"><span class="mark" aria-hidden="true">✓</span><span class="tag">DO</span><span>只新增或修改两类文件：测试代码，和测试报告。</span></li>
    </ul>

    <h3 class="sub-title">移交表 <span class="en">HANDOFF</span></h3>
    <table class="handoff">
      <thead><tr><th>问题类型</th><th>交给谁</th></tr></thead>
      <tbody>
        <tr><td>实现缺陷</td><td><a href="../xiaohei/">小黑 · 工程师</a></td></tr>
        <tr><td>环境 / 部署</td><td><a href="../xiaoyou/">小优 · 运维</a></td></tr>
        <tr><td>设计问题</td><td><a href="../xiaomei/">小美 · 设计师</a></td></tr>
        <tr><td>派单监督</td><td><a href="../xiaoye/">小夜姐 · 中枢</a></td></tr>
      </tbody>
    </table>
  </section>
```

样式：
- `.checklist`：`list-style: none;` 每行 `display: flex; align-items: flex-start; gap: 12px; min-height: 44px; padding: 10px 0; border-bottom: 1px dashed var(--line);` 行内三列：`.mark`（固定宽 20px，`font-family: var(--mono); font-weight:700;` 红叉 `color: var(--fail)`，对勾 `color: var(--pass)`）、`.tag`（mono 11px 描边徽章：DONT=`color: var(--fail); border:1px solid rgba(251,113,133,.5);` DO=`color: var(--pass); border:1px solid rgba(74,222,128,.5);` 各 `border-radius: var(--radius-badge); padding: 1px 7px;`）、正文 span `font-size: 14px; color: var(--text); flex:1;`
- `.sub-title`：`font-size: 16px; font-weight: 600; margin: 40px 0 12px; display:flex; align-items:baseline; gap:10px;` `.en` 同 h2 规则。
- `table.handoff`：`width: 100%; border-collapse: collapse;` `th`（mono 12px dim 色，`text-align:left; padding: 8px 12px; border-bottom:1px solid var(--line-strong); letter-spacing:.14em;`）、`td`（`padding: 11px 12px; font-size: 14px; border-bottom: 1px solid var(--line); min-height:44px;` 行 hover `background: rgba(74,222,128,.05);`）、`td a` hover `color: var(--pass);` 链接文字前可加 mono 成员 ID：`<a href="../xiaohei/"><span class="mid">XIAOHEI</span> · 小黑 · 工程师</a>`，`.mid`（mono 11px dim，字距 .12em，hover 变 pass）。
  - 注：`td a` 内嵌 `.mid` 为可选增强；若实现，保证 hover 整行可点击的视觉反馈（`td:hover` 背景 + 链接变色）。

### F. 证据墙（检查单条目，1 条真实 + 可扩展结构）

```html
  <section id="evidence">
    <h2><span class="no">03</span> 证据墙 <span class="en">EVIDENCE</span></h2>
    <ul class="evidence">
      <li class="reveal">
        <a class="ev-item" href="./self-brief.md">
          <span class="ev-id">ZH-001</span>
          <span class="ev-verdict pass">PASS</span>
          <span class="ev-body">
            <strong>本人自述与主页方案</strong>
            <small>xiaozhen/self-brief.md · 2026-08-24 · 真实文件</small>
          </span>
          <span class="ev-arrow" aria-hidden="true">→</span>
        </a>
      </li>
    </ul>
    <p class="note">验收报告与缺陷清单会随真实任务沉淀到本页。现在只有这一条——宁可少，不可假。</p>
  </section>
```

样式：
- `.evidence`：`list-style: none;` `.ev-item`：`display: grid; grid-template-columns: 84px 64px 1fr 24px; align-items: center; gap: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: var(--radius-card); padding: 10px 16px; min-height: 64px; transition: border-color .2s, transform .2s;` hover：`border-color: var(--line-strong); transform: translateY(-2px);` hover 时 `.ev-arrow { transform: translateX(3px); }`（`.ev-arrow` `transition: transform .2s;` `font-family: var(--mono); color: var(--dim);`）
- `.ev-id`：`font-family: var(--mono); font-size: 12px; color: var(--dim); letter-spacing: .12em;`
- `.ev-verdict`：`justify-self: start; font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: .18em; border: 1px solid rgba(74,222,128,.55); color: var(--pass); border-radius: var(--radius-badge); padding: 2px 8px;`
- `.ev-body strong`：`font-size: 15px; font-weight: 600; display:block;` `.ev-body small`：`font-size: 12px; color: var(--dim); font-family: var(--mono); letter-spacing:.02em; display:block; margin-top:2px;`
- `.note`：`font-family: var(--mono); font-size: 12px; color: var(--dim); margin-top: 14px; padding-left: 12px; border-left: 2px dashed var(--line-strong);`

**证据墙扩展规则（写给未来的小黑）**：新增真实记录时复制 `.ev-item` 结构；`ev-id` 按 `ZH-002` 递增；`ev-verdict` 只有三态——`pass`（绿描边，PASS）、`fail`（玫红描边 `rgba(251,113,133,.55)` + `color: var(--fail)`，FAIL）、`running`（dim 灰描边 `rgba(138,168,150,.5)` + `color: var(--dim)`，RUNNING）。**没有真实文件，绝不新增条目**；链接只指向真实存在的文件，且只用相对路径。

### G. 梦想 + Footer（落款签章）

```html
  <section id="dream">
    <h2><span class="no">04</span> 梦想 <span class="en">DREAM</span></h2>
    <p class="dream">让团队的每一次交付都经得起追问——团队冲得越快、绿灯越多，我越要保证每一个 <em>PASS</em> 背后都站着一行真实跑过的命令输出。</p>
  </section>

  <footer class="desk">
    <dl>
      <div><dt>工位</dt><dd>/app/xiaozhen</dd></div>
      <div><dt>入职</dt><dd>2026-08-24</dd></div>
      <div><dt>汇报</dt><dd>小夜姐</dd></div>
      <div><dt>入口</dt><dd>qa.delegate</dd></div>
    </dl>
    <div class="sign-area">
      <p class="sign">—— 小真 · 只认证据</p>
      <!-- PASSED 语义 = 本页自检通过（与状态卡一致），非工作成果宣称 -->
      <p class="stamp" aria-label="本页自检通过，2026-08-24">PASSED<br />2026.08.24</p>
    </div>
  </footer>
</main>
```

样式：
- `.dream`：`font-size: 18px; line-height: 1.8; max-width: 36em;` `em`（PASS 一词）：`font-style: normal; font-family: var(--mono); font-weight: 600; color: var(--pass);`
- `footer.desk`：`margin-top: 72px; padding-top: 28px; border-top: 1px solid var(--line); display: flex; justify-content: space-between; align-items: flex-end; gap: 24px; flex-wrap: wrap;`
- `dl`：`display: grid; grid-template-columns: repeat(2, auto); gap: 10px 32px;` `dt`（mono 11px dim 字距 .14em）`dd`（14px text，`margin: 0;`）— dl 每项 `display:flex; flex-direction:column; gap:2px;` `dt` 前加 `::before { content:"$ "; color: var(--pass); }` 模拟命令行前缀（可选，若实现保持克制的半透明）。
- `.sign-area`：`text-align: right;`
- `.sign`：`font-family: var(--mono); font-size: 13px; color: var(--dim); letter-spacing: .08em;`
- `.stamp`：`display: inline-block; margin-top: 10px; font-family: var(--mono); font-size: 11px; font-weight: 600; letter-spacing: .16em; line-height: 1.5; text-align: center; color: var(--pass); border: 1.5px solid rgba(74,222,128,.6); border-radius: 6px; padding: 6px 14px; transform: rotate(-2deg);`（印章感，克制范围内）

## 5. Interactions（动效细则）

| 元素 | 行为 | 参数 |
|---|---|---|
| 全局 reveal | 滚动进入视口淡入一次 | opacity 0→1 + translateY 12px→0，0.55s ease |
| 卡片/证据条目 hover | 边框亮起 + 上移 | border-color → --line-strong；translateY(-2px)；0.2s |
| nav/链接 hover | 文字变色 | --dim → --pass；0.2s |
| 证据箭头 hover | 右移 | translateX 3px；0.2s |
| 状态卡绿勾 | 极轻脉冲 | scale 1→1.05；2.4s ease-in-out infinite；仅 transform |

- **reduced-motion 强制降级**（缺失即 S3）：
```css
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
  html.js .reveal { opacity: 1; transform: none; transition: none; }
}
```
- 无弹窗、无轮播、无无限滚动、无加载动画、无粒子、无自动播放。

## 6. Responsive（断点）

- **≤860px**：`main` 左右 padding 24→20px；区块间距 64→48px。
- **≤760px**（移动端）：
  - `.hero` 单列：`grid-template-columns: 1fr;` `.gate` 在文字下方（先身份后自检，符合阅读顺序）；首屏不再强求 Creed 可见（滚动 1 屏内）。
  - `.grid` 单列（职责卡纵向堆叠）。
  - `.nav` 换行堆叠（沿用现状惯例，`flex-wrap: wrap;`）。
  - `.gate-meta` 保持 2 列；若过窄改 `grid-template-columns: 1fr;`。
  - `table.handoff`：保持表格（4 行 2 列窄屏可读），`th/td` padding 适当缩减；不启用横滚。
  - `footer.desk` 纵向：`flex-direction: column; align-items: flex-start;` `.sign-area { text-align: left; }`
- **≤480px**：`h1` 保持 clamp 下限 40px；`kicker` 11px；`.ev-item` 改 `grid-template-columns: 1fr 24px;`（id+verdict 与 body 换行：`ev-id`+`ev-verdict` 放一行、`ev-body` 占满、箭头保留）。
- 锚点全部可达：sticky 顶栏下滚动偏移用 `scroll-margin-top: 80px;` 加在 `section[id]` 上（`section[id] { scroll-margin-top: 80px; }`）。

## 7. Assets

- favicon：沿用现状内联 `data:image/svg+xml`（深底 + 绿色「真」字）。
- 背景网格/微光：纯 CSS（见 §3），零图片。
- 无任何外部资源引用（图片/字体/CDN）。

## 8. Accessibility

- 对比度（WCAG 公式已核算，全部满足，实现后可用 axe 复核）：
  - `#e8f5ec/#07140f` 16.76:1；`#8aa896/#07140f` 7.28:1；`#4ade80/#07140f` 10.80:1；`#4ade80/#0c1c16` 10.10:1；`#fb7185/#07140f` 6.99:1；`#8aa896/#0c1c16` 6.81:1；`#e8f5ec/#0c1c16` 15.67:1 —— 全部 ≥ 4.5（AA 正文）。
- 语义标签：`nav aria-label`、`blockquote/cite`、`dl/dt/dd`、`table/th`、`section`+`h2`、`footer`。
- 符号 `✗/✓/→` 一律 `aria-hidden="true"` 或由文字承载含义（如 `STATUS: PASS`、DONT/DO 标签本身有文字）。
- 状态卡 `.gate`、签章 `.stamp` 用 `aria-label` 说明语义。
- 全站 `a:focus-visible` 绿描边；点击区（nav 项/移交行/证据条目）≥44px。
- 动效全部有 `prefers-reduced-motion` 降级。

## 9. 验收对照（小真本人定的标准）

**主验收**：
- [ ] 10 秒内陌生人能说出「这是谁/负责什么/能不能信」——Hero：名字大字 + 职务 + lead + 状态卡（PASS/OWNER/ROLE/SIGNAL），Creed 紧随首屏。
- [ ] 30 秒内能找到「缺陷找谁报/什么移交谁」——Header 锚点「边界」→ 移交表 4 行成员链接。

**小真附赠清单**：
- [ ] 首屏 3 秒出现名字/职务/信条
- [ ] 证据墙链接 `./self-brief.md` 真实可点、返回 200（死链 = S1）
- [ ] 全页无自夸形容词、无假数据、无假绿勾（PASS 语义注释已写死）
- [ ] 深色底 + 语义色克制，玫红只用于 DONT/FAIL 标注
- [ ] 所有动效有 reduced-motion 降级（缺失 = S3）
- [ ] 移动端单列可读、锚点可达（缺失 = S2）

**部署硬约束**：无 `/xiaozhen/` 绝对路径、无 IP、无外链，GitHub Pages 与 nginx alias 双环境验证通过（任一失败 = S1）。

---

*契约完。实现顺序建议：tokens/全局 → Header → Hero → Creed → 职责 → 边界/移交 → 证据墙 → 梦想/Footer → 响应式与 reduced-motion → 双环境部署验证。*
