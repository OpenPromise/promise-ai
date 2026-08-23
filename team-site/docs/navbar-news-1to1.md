# 导航栏 + 情报速递 1:1 复刻逆向文档（异环官网 → 世界第一 AI 工作室）

> 记录人：小黑（工程师）；日期：2026-08-23；方式：curl 抓取桌面版 + 移动版（/m/）+ CSS/JS 逆向 + sprite 纯 Python 像素分析 + 无头浏览器 DOM 几何/计算样式实测。
> 目标页：`https://yh.wanmei.com/main.html` 的 `header`（顶栏）与 `pageNews`（情报速递）板块。

---

## 0. 一句话结论

参考站顶栏 = **#1d1d1d 实底固定条（高 1.18rem=118px 设计稿，右侧贴品牌字标图）+ 居中紧贴的黑底白字按钮组（每按钮 241×40px，三态 sprite 切图）**；
情报速递 = **双列布局（左：926×196 艺术字标题图 + 内嵌 Tab 组 + 5 行列表；右：926×468 带边框图片轮播）+ 顶部 y=705px 的 7px 高左右装饰细线（带白点）**。
全站 2560×1440 设计稿按 rem 等比缩放（1rem=100px@2560），移动端 `/m/` 为独立页面。

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
| `.header` | 高 118；bg #1d1d1d + `header.png`（664×144 品牌字标）no-repeat 100% 0，bg-size 664×144；fixed top0 left0 全宽；z-index 4；min-width 1920 | **实底**，无半透明/模糊/边框 |
| `.logo` | 高 85；left 170；top 50% translateY(-50%) | 字标图（NTE_logo.png） |
| `.headerNav` | left 50% top 50% translate(-50%,-50%)；flex | 绝对居中 |
| `.headerNav::before` | #1d1d1d 条带：高 118、宽 103%、z-index 1 | 垫在按钮后遮挡滚动内容 |
| `.headerNav button` | 241×40；相对；z-index 3 | 按钮紧贴无间距 |
| `.headerNav .n0~.n5` | 背景三态 sprite（241×120 = 3 段 ×40）：`0 0`=普通 / `0 -40`=hover / `0 -80`=active | background-size:100% auto |
| `.headerLogin` | right 42；top 50% | 我们删除 |
| `.bgMusic` | right 300；69×69 | 我们删除 |

### 3.3 sprite 像素证据（headerNav1-6.png，241×120）

- 三态各 40px 高；文字**黑底白字**：普通态亮像素 avg≈(249,249,249)（纯白），hover/active 态 avg≈(188,188,188)（灰）；
- 文字居中（4 字项 x 跨度 ≈61-178，字高 ≈26px 设计稿 → 字号 ≈30px 设计稿 = 22.5px@1920）；
- **青色像素检测 = 0**：参考站 sprite 本身**无青色**，hover/active 是"灰字暗化"而非提亮。

> ⚠️ 与任务说明"hover/active 提亮青色"不一致——此为**实测差异**，复刻采用监督者要求（白字 + hover/active 青色提亮），形态保留黑底白字（详见 §6）。

### 3.4 实测几何（无头浏览器 1920×1080）

- header 高 88.5px（118×0.75）、bg rgb(29,29,29)；
- logo 位于 x=127.5、90×63.75（170/85 ×0.75）；
- 导航组 x=417.75 起，5 按钮各 180.75×30 **紧贴**（含 menu-full 时总宽 1084.5 = 居中于 960）；
- active 按钮 `background-position:0 -60px`（-80×0.75），普通按钮 `0 0`。

### 3.5 交互联动（JS 证据）

```js
new Swiper(".wrapSwiper",{effect:"fade",fadeEffect:{crossFade:!0},mousewheel:!0,allowTouchMove:!1,on:{slideChange:function(){…$(".headerNav button").eq(activeIndex).addClass("active").siblings().removeClass("active");…}}});
$(".headerNav button").on("click",function(){…wrapSwiper.slideTo($(this).index(),1000,!1);…});
nav&&…$(".headerNav button[index='"+nav+"']").click();   // ?nav=N 深链，N=index 属性
```
→ **点击导航 = 1s 切换对应板块并置 active；滚动切板块时对应按钮置 active**（与当前实现语义一致：click→scrollIntoView + IntersectionObserver 高亮）。

### 3.6 移动端（/m/，独立页面）

- header 同结构（更矮），导航按钮仍为 sprite 图；`.page_menu` 汉堡菜单（public260421.js）；
- 我们不做 /m/ 独立页，沿用现有响应式（导航横滑），形态能对齐多少对齐多少。

## 4. 情报速递（pageNews）逆向

### 4.1 DOM 结构（精确）

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
    <div class="abs newsSwiperTit"></div>                       ← 当前轮播图标题（图片下方）
    <div class="abs pagination"></div>                          ← 轮播分页点（右下）
  </div>
</div>
```

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

### 4.3 实测几何（无头浏览器 1920×1080，×0.75）

- 装饰线 y≈528（705×0.75），白点散布（x=182/548/740…）；
- 左列 x=232.5 起、宽 694.5；Tab 区 y=358.5，非激活 tab 117.75×46.5，激活 tab 因 skew 宽 130.2；
- 列表 y=427.5 起；每行高 67.5（90×0.75）；底边框 2px #313131；
- 徽章 78.7×27.75（skew(-15deg) matrix(1,0,-0.268,1,0,0)），色值如 CSS；
- 标题 22.5px #dfdfdf、margin-left 24.75；日期 MM/DD 右对齐 #dfdfdf；
- 右列 x=986.25、694.5×351（含 4px 边框 #363636）；标题条 y=709、分页 y≈716。

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
| 顶栏形态 | #1d1d1d **实底**固定条，高 118 设计稿（@1920=88.5px），右侧品牌字标装饰 | rgba(13,13,13,0.72) 半透明 + backdrop blur + 底边框，高 64px | 高度、实底/半透明、装饰缺失 |
| logo | 左 170px 字标图（85px 高） | "AI°"+文字，left padding 16-48px | 位置/形态（无图素材，用文字） |
| 导航项 | 241×40 黑底白字按钮，**紧贴无间距**，居中 | 文字按钮 gap 18-44px，hover 白/active 青+下划线 | 间距、按钮形态、状态色 |
| 高亮 | 参考：白→灰暗化；任务要求：hover/active 青色提亮 | 青色提亮（上一轮已接受） | 采用任务要求（§6 差异说明） |
| 移动端 | /m/ 独立页，导航 sprite | 横滑文字导航 | 可对齐程度有限 |
| 板块标题 | 926×196 艺术字标题图 + 上/下装饰条，Tab 内嵌左下 | SectionHead（kicker+title+desc）居中，Tab 在标题下居中 | 标题形态/位置、Tab 位置 |
| Tab | 157×62 方形黑底白字，active=#1d1d1d+skew(-15deg)+内层反切 | 圆角 pill 描边按钮 | Tab 形态 |
| 徽章 | 95×37，skew(-15deg) 反切，青/粉/紫 | 有（尺寸偏小） | 尺寸对齐 |
| 列表行 | 行高 90，底边框 3px #313131，标题 30px #dfdfdf hover 青，日期 MM/DD 右对齐 | 行高约 48，边框 1px，标题 ~1.02rem，日期 YYYY/MM | 行高/字号/边框/日期格式 |
| 装饰线 | y=705 处 7px 高、白点、左右断开细线 | 标题上方 2px 细线（形态不同） | 位置/形态 |
| 右列轮播 | 926×468 边框图轮播 + 标题条 + 分页点 | 无 | **无素材不实现**（如实标注） |
| 数据 | 4 频道 × 5 条，MM/DD | /api/news + type 过滤 + 兜底 | 保持现状 |

## 6. 复刻映射（含如实标注的差异）

| 参考站 | 我们 | 说明 |
|---|---|---|
| header.png 品牌字标（右） | CSS 轻装饰（青色调字标/细线） | 无素材；装饰性元素，非内容 |
| NTE_logo 字标图 | 文字「世界第一 AI 工作室」（缩写 AI°） | 任务明确不用图片 |
| nav 三态 sprite（白→灰） | 文字按钮：普通白字 → hover/active **青色提亮发光** | 按任务说明与上一轮验收标准；参考站 sprite 实测无青色（§3.3） |
| 登录/充值/音乐按钮 | 删除 | 任务明确 |
| newsHead 标题图 | CSS 标题「情报速递」+ 上下装饰条 | 无美术字素材，位置/层次对齐 |
| Tab sprite（黑底白字 2 态） | CSS 文字 Tab：黑底白字方钮，active=#1d1d1d+skew(-15deg)+反切 | 1:1 形态 |
| 右侧图片轮播 | 不实现（无新闻图素材） | 如实标注；列表细节 1:1 |
| 频道映射 | gamenews(青)=做了什么 / gameevent(紫)=入职 / gamebroad(粉)=牢骚 | 任务确认（参考站频道语义不同，映射到团队类型） |
| ?nav=N | 保持现有 1-5（参考站为 1,3,4,5,6） | 内部兼容参数，非 UI |
