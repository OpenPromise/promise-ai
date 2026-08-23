# 导航栏 + 情报速递 1:1 复刻逆向文档（异环官网 → 世界第一 AI 工作室）

> 记录人：小黑（工程师）；日期：2026-08-23（第二次复扒修正，覆盖上一轮 f615049 的错误结论）；
> 方式：curl 抓取桌面版 + CSS/JS 逆向 + sprite 纯 Node(pngjs) 像素分析 + 无头浏览器 DOM 几何/计算样式实测。
> 目标页：`https://yh.wanmei.com/main.html` 的 `header`（顶栏）与 `pageNews`（情报速递）板块。
> **本轮重点：按 CEO 三条反馈修正——①导航发光真实实现（上轮看反了）；②顶栏一体化结构；③情报速递左右双列。**

---

## 0. 一句话结论（2026-08-23 修正版）

参考站顶栏 = **#1d1d1d 实底固定条（高 118px 设计稿/4.6vw，右侧贴品牌字标图 header.png 664×144）+ 居中紧贴的透明背景按钮组（每按钮 241×40px，三态 sprite 切图换色）**；
情报速递 = **左右双列（左：926×196 标题图 + 内嵌 Tab 组 + 固定 5 行列表；右：926×468 带边框图片轮播 + 下方标题条 + 分页点）**。
全站 2560×1440 设计稿按 rem 等比缩放（1rem=100px@2560），移动端 `/m/` 为独立页面。

### 0.1 ⚠️ 上轮结论勘误（CEO 反馈 1 根因）

上一轮把 sprite 三态**方向看反了**（写"普通白、hover/active 灰"）。本轮纯 Python/Node 像素逐段分析 + ASCII 渲染证实：

| 状态 | sprite 段（241×120，每段 40px） | 实测文字色 | 上轮（错误） |
|---|---|---|---|
| normal（`background-position:0 0`） | y 0-40 | **灰 rgb(170,170,170)** | 纯白 249 |
| hover（`0 -40px`） | y 40-80 | **白 rgb(255,255,255)** | 灰 188 |
| active（`0 -80px`） | y 80-120 | **青 rgb(81,229,251)**（首页 #7CECFC=124,236,252） | 灰 188，且称"无青色" |

- **青色像素检测：active 段 100% 像素为青色**（headerNav2-6 主色 81,229,251；headerNav1/首页 124,236,252）；
- **零光晕**：三态 alpha 直方图无扩散半透明（仅文字本体 255 + 少量边缘抗锯齿 64-191），CSS 无 box-shadow/text-shadow，JS 无额外 glow 处理 → **发光 = 纯切图换色，无任何 shadow/blur**；
- **按钮背景透明**：sprite 92% 像素为透明（transparent=7890~8976/9640），按钮无底色，"黑底"即顶栏 #1d1d1d 本身 → 视觉与顶栏一体。

> 复刻修正：normal 灰字 → hover 白字 → active 青字；**去掉上一轮的青色 text-shadow 光晕**；按钮背景透明（不再 #0a0a0a 黑底）。

## 1. 抓取清单（如实记录）

| 资源 | 状态 | 说明 |
|---|---|---|
| `main.html`（34.8KB） | ✅ | 与上一轮缓存 md5 一致；header/pageNews 完整 DOM |
| `style/main260813.css`（26.7KB） | ✅ | 页面主体样式（news 全部规则） |
| `style/public260423.css`（5.4KB） | ✅ | **header 样式在此**（.header/.logo/.headerNav/.n0-n5） |
| `js/main260702.js`（11KB） | ✅ | 导航联动（slideTo + active 切换）、新闻渲染逻辑 |
| `include/newsData20260112.js`（8.5KB） | ✅ | 新闻数据真实结构（4 频道，每频道 5 条） |
| 导航/新闻素材：headerNav1-6.png、news/gamenews/gamebroad/gameevent tab sprite、newsHead.png、newsMore.png、pageViewLineRight.png、header.png、NTE_logo.png | ✅ | 纯 Python 像素级分析（尺寸/状态/颜色） |
| `m/main.html` + `m/style/main260813.css` | ✅ | 移动端情报速递 DOM/CSS |
| 实际渲染截图像素 | ⚠️ 部分 | headless-shell 合成器不画背景色（连纯色 div 截图都是黑）——**像素验证降级为 DOM 几何 + 计算样式实测**（与上一轮角色板块同法），CSS 色值以源码声明为准 |

> 诚实声明：所有尺寸/颜色/交互均有 HTML/CSS/JS/sprite 像素证据；截图像素因环境限制仅作几何验证。

## 2. 设计稿缩放（沿用上轮结论）

```js
// main.html 内联脚本
var _w = 2560, _h = 1440, _p = _w/_h;
function recalc(){ … docEl.style.fontSize = 100*(clientWidth/2560)+'px'; }  // 1rem=100px@2560
```
→ 1920 屏 scale=0.75；1440 屏 scale=0.5625。下文"设计稿 px"均指 2560 基准值。

## 3. 导航栏（header）逆向

### 3.1 DOM 结构（精确）

```html
<div class="header">                          ← 固定顶栏
  <a href="index.html"><img class="abs logo" src=".../NTE_logo.png"></a>   ← 左 logo（字标图）
  <div class="abs headerNav">                 ← 居中导航组
    <button index="1" class="n0 active"></button>   ← 首页
    <button index="3" class="n2"></button>          ← 情报速递
    <button index="4" class="n3"></button>          ← 角色介绍
    <button index="5" class="n4"></button>          ← 世界全景
    <button index="6" class="n5"></button>          ← 都市映像
    <a class="menu-full" href=".../pay/index.html" target="_blank"></a>  ← 充值（我们去）
  </div>
  <div class="abs headerLogin">…</div>        ← 登录（我们去）
  <button class="abs bgMusic"></button>       ← 背景音乐开关（我们去）
</div>
```

> 注意：按钮 `index` 为 1,3,4,5,6（跳过 2，疑似历史删过一页）；按钮**无文字内容**，纯背景图。class n0..n5 与 index 无关（n1 未被使用）。

### 3.2 CSS 值（public260423.css，全部换算设计稿 px）

| 元素 | 值（设计稿 px） | 说明 |
|---|---|---|
| `.header` | 高 118；bg #1d1d1d + `header.png`（664×144 品牌字标）no-repeat 100% 0，bg-size 664×144；fixed top0 left0 全宽；z-index 4；min-width 1920 | **实底**，无半透明/模糊/边框；品牌字标贴右缘（100% 0） |
| `.logo` | 高 85；left 170；top 50% translateY(-50%) | 字标图（NTE_logo.png） |
| `.headerNav` | left 50% top 50% translate(-50%,-50%)；flex | 绝对居中 |
| `.headerNav::before` | #1d1d1d 条带：高 118、宽 103%、z-index 1 | 垫在按钮后遮挡滚动内容，**与顶栏同色** |
| `.headerNav button` | 241×40；相对；z-index 3 | 按钮紧贴无间距；**背景透明**（sprite 仅文字像素） |
| `.headerNav .n0~.n5` | 背景三态 sprite（241×120 = 3 段 ×40）：`0 0`=普通(灰) / `0 -40`=hover(白) / `0 -80`=active(青) | background-size:100% auto |
| `.headerLogin` | right 42；top 50% | 我们删除 |
| `.bgMusic` | right 300；69×69 | 我们删除 |

### 3.3 sprite 像素证据（headerNav1-6.png，241×120，Node pngjs 逐段分析）

- 三态各 40px 高；**normal=灰(170,170,170)、hover=白(255,255,255)、active=青(81,229,251)**（headerNav1/首页 active=124,236,252 #7CECFC）；文字居中，字高 ≈26px 设计稿；
- **active 段青色像素占比 100%**（全部不透明像素均为青色）——上轮"无青色"结论错误；
- **alpha 直方图零光晕**：每态仅"文字本体不透明(255) + 边缘抗锯齿(64~191 少量)"，无扩散半透明；CSS 无 shadow、JS 无 glow → **"发光"= 三态切图换色，无光晕**；
- 按钮背景透明（transparent 占比 82%~93%）：黑底即顶栏 #1d1d1d → 按钮与顶栏一体。

### 3.4 实测几何（无头浏览器 1920×1080，2026-08-23 复测）

- header 高 88.5px（118×0.75）、bg rgb(29,29,29)、背景图 header.png bg-size 498×108（664×144×0.75）**贴 100% 0（右缘顶部）**；
- logo 位于 x=127.5、90×63.75（170/85 ×0.75）；
- 导航组 x=417.75 起，5 按钮各 180.75×30 **紧贴**（含 menu-full 时总宽 1084.5 = 居中于 960）；
- active 按钮 `background-position:0 -60px`（-80×0.75），普通按钮 `0 0`；hover 类加在 active 上时 CSS 特异性相同、后声明者胜（hover 优先于 active，边缘态）。

### 3.5 交互联动（JS 证据）

```js
new Swiper(".wrapSwiper",{effect:"fade",fadeEffect:{crossFade:!0},mousewheel:!0,allowTouchMove:!1,on:{slideChange:function(){…$(".headerNav button").eq(activeIndex).addClass("active").siblings().removeClass("active");…}}});
$(".headerNav button").on("click",function(){…wrapSwiper.slideTo($(this).index(),1000,!1);…});
nav&&…$(".headerNav button[index='"+nav+"']").click();   // ?nav=N 深链，N=index 属性
```
→ **点击导航 = 1s 切换对应板块并置 active；滚动切板块时对应按钮置 active**（与当前实现语义一致：click→scrollIntoView + IntersectionObserver 高亮）。
**JS 无任何 glow/box-shadow/text-shadow 处理**——导航状态纯靠 CSS `background-position` 切图换色。

### 3.6 移动端（/m/，独立页面）

- header 同结构（更矮），导航按钮仍为 sprite 图；`.page_menu` 汉堡菜单（public260421.js）；
- 我们不做 /m/ 独立页，沿用现有响应式（导航横滑），形态能对齐多少对齐多少。

## 4. 情报速递（pageNews）逆向

### 4.1 DOM 结构（精确，2026-08-23 复抓确认）

```html
<div class="swiper-slide pageNews">
  <div class="abs newsList">                                    ← 左列
    <div class="rel newsHead">                                  ← 926×196 标题图（艺术字"情报速递"+上下装饰）
      <div class="abs newsNav">                                 ← Tab 组：在标题图内，left 33 / top 128
        <span class="active"><button class="news"></button></span>      ← 全部
        <span><button class="gamenews"></button></span>                ← 新闻
        <span><button class="gamebroad"></button></span>               ← 公告
        <span><button class="gameevent"></button></span>               ← 活动
      </div>
      <div class="abs newsMore">…4 个"更多"链接…</div>           ← right 22 / top 134，192×50
    </div>
    <div class="abs newsCont" type="news" style="display:block"></div>  ← 每频道一个列表容器
    <div class="abs newsCont" type="gamenews"></div>
    <div class="abs newsCont" type="gamebroad"></div>
    <div class="abs newsCont" type="gameevent"></div>
  </div>
  <div class="abs newsSwiper">                                  ← 右列：图片轮播
    <div class="abs swiper"><div class="swiper-wrapper"></div></div>
    <div class="abs newsSwiperTit"></div>                       ← 当前轮播图标题（图片**下方**）
    <div class="abs pagination"></div>                          ← 轮播分页点（右下）
  </div>
</div>
```

### 4.1.1 右列 newsSwiper 精确结构（2026-08-23 复扒，上轮"无素材不实现"已解决）

- `.newsSwiper`：926×468（9.26rem）、border 6px **#363636**、radius 6px、left 50% margin-left 35px（相对左列右缘 +70px）、top 430；
- `.newsSwiper .swiper`：100% 撑满框（图片区域 914×456 内容区）；`img` 100%×100% object-fit 铺满；
- `.newsSwiperTit`：**在图片框下方**（left 0 / top 510，相对 newsSwiper），显示当前轮播标题，居中；
- `.pagination`：右下（right 0 / top 520），子弹 **20×20、radius 20、#616161 底 + 1px #515151 边**，active **#7ce3f2**，间距 margin-left 40px 右对齐；
- 数据源 `yh_data_data.lb1`：`{title, bigpic(1068×540 ≈ 926×468 同比例), link}`；Swiper `loop+autoplay`，slideChange 时 `.newsSwiperTit .newsItem` 切到当前标题。

### 4.1.2 左列列表固定高度证据（CEO 反馈 3）

- 参考站 newsCont **无 CSS 固定 height**——高度由内容决定，但 **JS 固定渲染每频道 5 条**（`a.forEach(function(e,t){ if(!(t>=5)){…} })`）+ 行高固定 → 实际渲染高度**恒定 = 5 行**；
- 实测（1920×1080）：`.newsCont` 高 **321px**（5 行 × 64px @1920 = 85.3px 设计稿/行），首行 top 428、末行 bottom 749；
- 行高构成：padding 23px×2 + 文字行高(30px×1.2=36px) + 底边框 3px ≈ 85px 设计稿；
- 我们实现：`.news-list` 固定 `height: 5×行高`，数据不足 5 条时补 `is-placeholder` 空行占位 → **高度恒定不伸缩**。

### 4.2 CSS 值（main260813.css，设计稿 px）

| 元素 | 值（设计稿 px） | 说明 |
|---|---|---|
| `.pageNews::before/::after` | 高 7；top 705；宽 2246；`before{right:50%;margin-right:1000}` `after{left:50%;margin-left:1000}` | 左右装饰细线（pageViewLineRight.png = 2246×7 细线+白点） |
| `.newsList` | left 50% margin-left -970；top 350 | 左列定位 |
| `.newsHead` | 926×196；bg newsHead.png（含上装饰条/艺术字标题/下装饰） | 标题图 |
| `.newsNav` | left 33；top 128；flex | 在标题图内 |
| `.newsNav span` | 157×62；margin-right 10 | Tab 外壳 |
| `.newsNav button` | 100%；sprite 2 态（157×124）：`0 0`=普通 / `0 100%`=active | 黑底白字 sprite |
| `.newsNav span:hover,.newsNav .active` | bg #1d1d1d；radius 10；**skew(-15deg)** | 激活斜切 |
| `.newsNav span:hover button,.newsNav .active button` | bg-pos `0 100%`；**skew(15deg)** | 内层反切 |
| `.newsMore a` | 192×50 | 每频道"更多"链接 |
| `.newsCont` | left 0；top 220；宽 927 | 列表容器（display:none，切 Tab 显示对应频道） |
| `.newsCont .newsItem` | border-bottom 3px solid #313131；padding 23px 0 | 行底边框 |
| `.newsItem` | flex 居中；font-size 30 | 行布局 |
| `.newsItem .type` | 95×37；radius 5；**skew(-15deg)**；text-align center | 徽章 |
| `.type.gamenews` | bg #7ce3f2；color #313131 | 新闻=青 |
| `.type.gamebroad` | bg #fe5a95；color #fff | 公告=粉 |
| `.type.gameevent` | bg #7958cb；color #fff | 活动=紫 |
| `.type span` | inline-block；**skew(15deg)** | 文字反切 |
| `.newsItem .title` | #dfdfdf；margin-left 33；宽 550；ellipsis；hover → #7ce3f2 | 标题 |
| `.newsItem .date` | #dfdfdf；margin-left auto | 日期右对齐 |
| `.newsSwiper` | left 50% margin-left 35；top 430；926×468；border 6px #363636；radius 6 | 右列轮播框 |
| `.newsSwiperTit` | left 0；top 510（相对 swiper） | 轮播标题条 |
| `.newsSwiper .pagination` | right 0；top 520；子弹 20×20 radius 20；#616161 底/#515151 边；active #7ce3f2 | 分页点 |

### 4.3 实测几何（无头浏览器 1920×1080，×0.75，2026-08-23 复测）

- 装饰线 y≈528（705×0.75），白点散布（x=182/548/740…）；
- 左列 x=232.5 起、宽 694.5；Tab 区 y=358.5，非激活 tab 117.75×46.5，激活 tab 因 skew 宽 130.2；
- 列表 y=427.5 起；**每行高 64px（85.3 设计稿）**；底边框 2px #313131；容器高 321px 固定（5 行）；
- 徽章 78.7×27.75（skew(-15deg) matrix(1,0,-0.268,1,0,0)），色值如 CSS；
- 标题 22.5px #dfdfdf、margin-left 24.75；日期 MM/DD 右对齐 #dfdfdf；
- **右列 newsSwiper x=986.25、694.5×351 内容区（含 4px 边框 #363636）**；图片 1068×540 铺满；
- **标题条 newsSwiperTit y=709（图片框下方）**、分页点 y≈717 右对齐，子弹 15×15（20×0.75）active #7ce3f2。

### 4.4 数据与渲染（JS 证据）

```js
// 每频道最多 5 条
a.forEach(function(e,t){ if(!(t>=5)){ … } });
// 行结构
<div class="newsItem"><p class="type {channelName}"><span>{channelCnName}</span></p>
  <p class="title"><a href="https://yh.wanmei.com{url}" target="_blank">{title}</a></p>
  <p class="date">{MM}/{DD}</p></div>        // time.split("-") → n[1]+"/"+n[2]
// Tab 切换
$(".newsNav span").click(function(){ …$(this).addClass("active").siblings().removeClass("active");
  $(".newsMore a").hide().eq(e).show(); $(".newsCont").hide().eq(e).show(); });
// 右轮播：yh_data_data.lb1（bigpic 图 + title + link），loop+autoplay+pagination；.newsSwiperTit 显示当前标题
```

频道体系：`news(全部) / gamenews(新闻,#7ce3f2) / gamebroad(公告,#fe5a95) / gameevent(活动,#7958cb)`。

### 4.5 移动端（/m/）差异

- 结构顺序：**轮播在上（6.03×3.05rem，边框 #363636，radius 12px），列表在下（居中 6.14rem 宽）**；
- Tab 组居中全宽（span 1.3×0.4rem、间距 0.12rem），激活态同为 #1d1d1d + skew(-15deg) + 反切；
- 徽章 0.65×0.25rem，gamenews 用 **#51e5fb**（与桌面 #7ce3f2 不同）、gamebroad/gameevent 文字 #e8e8e8；
- 行底边框 2px #313131、padding 0.17rem；分页点 active #4fe5fb 描边 #515151。

## 5. 与当前 NavBar.tsx / NewsPage.tsx 的差距清单

| 维度 | 参考站（1:1 目标） | 当前实现 | 差距 |
|---|---|---|---|
| 顶栏形态 | #1d1d1d **实底**固定条，高 118 设计稿（@1920=88.5px），右侧品牌字标 header.png 贴 100% 0 | 同：实底 #1d1d1d + 4.6vw + 右品牌字标文字 | ✅ 一体 |
| logo | 左 170px 字标图（85px 高） | "AI°"+文字，left 6.64vw | 位置对齐（无图素材，用文字） |
| 导航项 | 241×40 透明底按钮，**紧贴无间距**，居中 | 同：透明底 + 紧贴 + 居中 | ✅ |
| 高亮 | normal 灰(170) → hover 白(255) → active 青(81,229,251)（首页 #7CECFC），**零光晕** | 同（本轮修正：去光晕、灰→白→青） | ✅（上轮曾错做白字+青光晕） |
| 按钮背景 | 透明（sprite 仅文字） | 透明（本轮修正：去 #0a0a0a 黑底） | ✅ 一体感关键 |
| 移动端 | /m/ 独立页，导航 sprite | 横滑文字导航 | 可对齐程度有限 |
| 板块标题 | 926×196 艺术字标题图 + 上/下装饰条，Tab 内嵌左下 | SectionHead（kicker+title）居中，Tab 在标题下左 | 标题形态/位置、Tab 位置 |
| Tab | 157×62 方形黑底白字，active=#1d1d1d+skew(-15deg)+内层反切 | 同（本轮移入左列标题区） | ✅ 形态 |
| 徽章 | 95×37，skew(-15deg) 反切，青/粉/紫 | 同 | ✅ |
| 列表行 | 行高 85 设计稿（实测 64px@1920），底边框 3px #313131，标题 30px #dfdfdf hover 青，日期 MM/DD 右对齐 | 同（行高修正 3.33vw） | ✅ |
| 列表高度 | **固定 5 行**（JS 渲染上限 + 行高固定） | **固定 height = 5×行高 + 占位补满** | ✅ CEO 反馈 3 |
| 装饰线 | y=705 处 7px 高、白点、左右断开细线 | 标题上方 2px 细线（形态不同） | 位置/形态 |
| 右列轮播 | 926×468 边框图轮播 + 下方标题条 + 分页点（20×20 圆点 #616161/#7ce3f2） | **同结构**（本轮实现，图片=团队生活照占位） | ✅（素材为 AI 生成占位，可替换） |
| 数据 | 4 频道 × 5 条，MM/DD | /api/news + type 过滤 + 兜底 | 保持现状 |

## 6. 复刻映射（2026-08-23 修正版，含如实标注的差异）

| 参考站 | 我们 | 说明 |
|---|---|---|
| header.png 品牌字标（右，贴 100% 0） | 右侧文字装饰「AI° STUDIO」（.nav-brand） | 无素材；装饰性元素，非内容；位置/右缘对齐 |
| NTE_logo 字标图 | 文字「世界第一 AI 工作室」（缩写 AI°） | 任务明确不用图片 |
| nav 三态 sprite（灰→白→青，零光晕） | 文字按钮三态同色（灰 170 / 白 255 / 青 #51E5FB，首页 #7CECFC），**无 shadow** | **本轮修正**：上轮错做白字+青色 text-shadow 光晕；sprite 像素实测证明零光晕、active 为青色 |
| nav 按钮背景 | 透明（同参考站） | **本轮修正**：去掉 #0a0a0a 黑底 → 与 #1d1d1d 顶栏一体（CEO 反馈 2） |
| 顶栏一体 | 单条 .nav：logo + 导航 + 右品牌字标同 bar | **本轮强化**：logo 绝对定位左缘、导航绝对居中、品牌字标右缘，均在实底 #1d1d1d 条内 |
| 登录/充值/音乐按钮 | 删除 | 任务明确 |
| newsHead 标题图 | CSS 标题「情报速递」+ 左列标题区（Tab 左下 + 「更多」右上） | 无美术字素材，位置/层次对齐 |
| Tab sprite（黑底白字 2 态） | CSS 文字 Tab：黑底白字方钮，active=#1d1d1d+skew(-15deg)+反切 | 1:1 形态 |
| 右列图片轮播 | **实现**：926×468 边框 #363636 + 标题条 + 分页点；图片=AI 生成团队生活照（3 张，集中管理于 lib/newsCarousel.ts，**可替换为真实照片**） | **本轮实现**（上轮无素材跳过）；生成图标注为占位 |
| 频道映射 | gamenews(青)=做了什么 / gameevent(紫)=入职 / gamebroad(粉)=牢骚 | 任务确认（参考站频道语义不同，映射到团队类型） |
| ?nav=N | 保持现有 1-5（参考站为 1,3,4,5,6） | 内部兼容参数，非 UI |

## 7. 本轮（f615049 后续修正迭代）改动对照

| CEO 反馈 | 根因（逆向证据） | 本轮修正 |
|---|---|---|
| ① 导航发光和原版不一样 | 上轮把 sprite 三态看反 + 臆造青色 text-shadow 光晕 | 三态换色：灰→白→青，**去光晕**（sprite alpha 零扩散、CSS/JS 无 shadow） |
| ② 导航与顶栏不一体 | 按钮 `background:#0a0a0a` 黑底 → 视觉独立黑条；上轮顶栏曾半透明 | 按钮透明底 + 实底 #1d1d1d 单条 bar（logo+导航+品牌字标同体） |
| ③ 情报速递改左右双列 | 上轮仅单列列表，无右轮播；列表随内容伸缩 | 左列固定 5 行高度 + 右列轮播（边框/标题条/分页点 1:1）；图片集中管理可替换 |
