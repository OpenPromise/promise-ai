# 角色介绍板块 1:1 复刻逆向文档（异环官网 → 世界第一 AI 工作室）

> 记录人：小黑（工程师）；日期：2026-08-23；方式：curl 抓取桌面版 + 移动版（/m/）+ CSS/JS 逆向 + 素材像素级分析（纯 Python PNG/JPEG 解码）。
> 目标页：`https://yh.wanmei.com/main.html` 的角色板块（pageRole）。

---

## 0. 一句话结论

参考站角色板块 = **左侧竖排头像缩略导航（带上下箭头）+ 整屏 16:9 角色背景视频（角色立绘在画面右侧）+ 左侧信息区（名字图 + 台词图 + 简介滚动文本）**；切换交互 = **点击缩略图 / 导航箭头 → 整屏交叉淡化（fade crossFade，1s）**，无左右大箭头、无标题栏。整个站点是 2560×1440 设计稿按 rem 等比缩放。

## 1. 抓取清单（如实记录）

| 资源 | 状态 | 说明 |
|---|---|---|
| `main.html`（桌面版 34.8KB） | ✅ | pageRole 完整 DOM |
| `style/main260813.css`（26.7KB） | ✅ | 角色板块全部布局/交互 CSS |
| `style/public260423.css`（5.4KB） | ✅ | `.abs`/`.auto` 基础类 |
| `js/main260702.js`（11KB） | ✅ | Swiper 配置、缩放逻辑、移动端切换 |
| `m/main.html`（移动版 34KB） | ✅ | 移动端角色 DOM（与桌面差异大） |
| `m/style/main260813.css`（11.6KB） | ✅ | 移动端角色 CSS |
| 角色素材 `role-tab-*.png`（138×278 双态 sprite）、`role-name-*.png`（≈363-380×102）、`role-dec-*.png`（≈790-822×104）、`roleNav.png`（169×930）、`factionsPrev/Next.png`（78×156）、`role-poster-*.jpg`（1920×1080） | ✅ | 像素级尺寸 + 平均色 + 构图分析（纯 Python 解码，无图像库） |
| 角色背景视频 `role-*.mp4` | ⚠️ 仅 URL | 未下载（防盗链/体积），行为已从 HTML/JS 确认：`autoplay muted loop` |
| 实际渲染时序/hover 手感 | ❌ | 无浏览器，动效以 CSS/JS 代码证据描述 |

> 诚实声明：色值/布局/字体/动效均为 CSS/JS/图片像素证据；视频实际画面未验证（但 poster 已解码，构图确认：**角色在画面右侧**）。

## 2. 设计稿缩放机制（关键）

```js
// main.html 内联脚本（原样逻辑）
var _w = 2560, _h = 1440, _p = _w / _h;   // 16:9 设计稿
function recalc() {
  var clientWidth = docEl.clientWidth;
  var clientHeight = docEl.clientHeight;
  if (clientWidth / clientHeight < _p) clientWidth = _p * clientHeight; // 窄屏按高缩放（居中裁切两侧）
  docEl.style.fontSize = 100 * (clientWidth / 2560) + 'px';  // 1rem = 100px @2560
}
```

→ 全站为 2560×1440 设计稿的等比缩放，**1rem = 100px（2560 宽时）**。以下所有 rem 值已换算为设计稿像素。

## 3. 桌面版 DOM 结构（精确）

```
<div class="swiper-slide pageRole">                          ← 无板块标题，无左右大箭头
  <div class="abs factionsWrap">                             ← 全屏，z-index:-1
    <div class="abs roleNav">                                ← 左导航条：left:120px; top:50%; translateY(-50%); 169×930
      │  background: url(roleNav.png) no-repeat 0 0/100% auto  ← 深灰(#282828)圆角竖条框
      <div class="abs swiper factions_nav">                  ← 138×625，居中于导航条
        <div class="swiper-wrapper">
          <div class="swiper-slide role-tab-*"><p></p></div>  ← 每个角色一个 tab：138×139，间距 22px
          │  p 的 background = role-tab-*.png（138×278 双态 sprite）
          │  普通态 background-position:0 0；激活态 .swiper-slide-active p → 0 100%（提亮+描边框）
        </div>
      </div>
      <button class="abs factionsPrev"></button>             ← 导航条内上下箭头：78×78，top:53px
      <button class="abs factionsNext"></button>             ← 78×78，bottom:53px；hover → sprite 0 100%（灰→青）
    </div>
    <div class="abs swiper roleSwiper">                      ← 全屏角色轮播，z-index:-1
      <div class="swiper-wrapper">
        <div class="swiper-slide">                           ← 每角色一屏
          <video poster="...role-poster-*.jpg" src="...role-*.mp4" autoplay muted loop class="abs roleBg">
          │  2560×1440 整屏 16:9 居中；角色立绘画在视频画面【右侧】（poster 像素级确认）
          <img src="...role-name-*.png" class="abs role_name">  ← 名字图：h=105，left:50%，margin-left:-820px，top:523px
          <div class="abs role_cont">                       ← 信息区：left:50%，margin-left:-820px，top:710px
            <div class="role_des role-dec-*"></div>          ← 台词图（bg 图）：mb 30px，如 790×104
            <div class="role_text"><p>…</p>…</div>            ← 简介文本：780×180，fs 20px，lh 30px，#afafaf，hover 滚动
          </div>
        </div>
      </div>
    </div>
  </div>
</div>
```

### 关键布局换算（2560×1440 设计稿 → 相对值）

| 元素 | 设计稿 px | 相对宽高 |
|---|---|---|
| 左导航条 | left:120; top:50%; 169×930 | 左 4.7%；高 64.6% |
| 导航 tab | 138×139 / 个，间距 22 | ≈1:1 方头像 |
| 名字图 | left: 460(=中心-820); top:523; 高105 | 信息列左缘 18%；名字顶 36.3% |
| 信息区 | top:710 | 49.3% |
| 简介文本 | 780×180 | 宽 30.5%；高 12.5% |
| 角色立绘（视频内） | 画面右侧 x≈55%-100% | 右侧约 45% 宽、近乎全高 |

### 交互（JS 证据）

```js
// 导航 swiper：桌面竖排 / 移动横排
new Swiper(".factions_nav", { direction: isMobile()?"horizontal":"vertical",
  loop:true, slidesPerView:"auto", slideToClickedSlide:true,
  navigation:{ prevEl:".factionsPrev", nextEl:".factionsNext" },
  on:{ slideChange(){ setTimeout(()=> roleSwiper.slideToLoop(this.realIndex, 1000, false), 0); } } });

// 主角色轮播：整屏交叉淡化
new Swiper(".roleSwiper", { loop:true, allowTouchMove:false, effect:"fade", fadeEffect:{crossFade:true} });

// 桌面：.role_text hover 出现滚动条（6px，#616161 底 / #c1c1c1 滑块），wheel 不冒泡
// 移动：roleMoreDes 按钮 toggle —— 点击后 .roleNav 隐藏、.roleDesText 展示（覆盖层）
```

→ **切换动画 = 交叉淡化（约 1s）**；缩略图点击与导航箭头均驱动主轮播。

## 4. 移动版（/m/）差异

```
<div class="abs auto roleNav">          ← 顶部横排导航：top:998px，692×126，水平居中（left:50% translateX(-50%)）
  .factions_nav：横排 tab 105×104，间距 14；激活态 border:#b3b3b3 + sprite 0 100%
  .factionsPrev / .factionsNext：左右箭头 60×60，竖居中
<div class="abs swiper roleSwiper roleSwiper1">
  .swiper-slide
    <img class="abs roleBg">            ← 用 poster 静态图（非视频）：整宽，高 836px，top:0
    <div class="abs roleInfoCont">      ← 底部信息面板（bg 图）：top:836px 至底部
      <img class="abs role_name">       ← 名字：left:30px top:50px h:71px
      <button class="abs roleMoreDes">  ← 「更多」按钮：right:30px top:65px 159×54；点击加 .on 态
      <div class="abs roleDesText">     ← 隐藏描述层：display:none；#111 底，top:153px h:194px
        <div class="abs cont">          ← 内部滚动：680 宽，滚动条 #080808 底 / #4fe5fb(青) 滑块
          <dl>
            <dt>台词（引语）</dt>         ← 下边框 .03rem 虚线 #504f4f
            <dd><p>简介段落</p></dd>
          </dl>
```

要点：移动端**角色背景为静态海报图**、信息收纳在底部面板、点「更多」按钮展开描述并隐藏导航；滚动条青色 #4fe5fb（呼应主强调色）。

## 5. 像素级证据（纯 Python 解码）

| 素材 | 尺寸 | 结论 |
|---|---|---|
| roleNav.png | 169×930 | 深灰(40,40,40)≈#282828 竖条框，四角透明（圆角） |
| role-tab-xiaozhi.png | 138×278 | 双态 sprite：上=普通(均值 177,147,159 偏暗)、下=激活(188,182,190 提亮)；头像 1:1 方图、圆角透明 |
| factionsPrev/Next.png | 78×156 | 双态 sprite：普通灰(79,79,79)、hover 青(56,81,80) |
| role-name-*.png | ≈363-380×102 | 名字竖排美术字图（半透明文字） |
| role-dec-*.png | 790-822×104-111 | 台词美术字图 |
| role-poster-*.jpg | 1920×1080 | 3×3 网格亮度：角色在右侧（中右格最亮，如 xiaozhi 右列 169/121/136），背景极暗(4-7) |

## 6. 与当前 RolesPage.tsx 的差距清单

| 维度 | 参考站（1:1 目标） | 当前实现 | 差距 |
|---|---|---|---|
| 整体布局 | 整屏角色轮播：**立绘右侧 + 信息左侧**；无标题栏 | 居中 2:3 大图 + 底部信息条 + 顶部 SectionHead 标题 | **布局反了**：图在中间、信息在底部、有标题栏 |
| 缩略导航 | 左缘窄竖条（169px 框）+ 1:1 方头像（无文字）+ 框内上下箭头 | 左缘 2:3 竖图缩略 + 底部名字条 + 无箭头 | 缩略图比例、样式、箭头缺失 |
| 切换动画 | **整屏交叉淡化（1s）** | 大图 fadeUp 上移淡入（0.45s），背景无过渡 | 动画类型与节奏不一致 |
| 信息呈现 | 名字大图(105px) + 台词图 + 简介文本(20px/30px 灰 #afafaf, hover 滚动) | 名字 + 职务徽章 + bio + 梦想，集中在底部信息条 | 信息位置/层级/滚动交互不一致 |
| 背景氛围 | 每角色独立 16:9 背景视频（角色入画） | 每角色 world-*.png 背景 + 渐变遮罩 | 有基础，需对齐右侧立绘构图 |
| 装饰 | 导航条圆角深灰框、箭头双态 sprite、激活提亮 | 圆角缩略框、青光描边 | 部分对齐 |
| 移动端 | 顶部横排导航 + 底部信息面板 + 「更多」展开 + 青色滚动条 | 顶部横排导航 + 压缩信息条 | 需对齐「更多」展开交互与面板样式 |

## 7. 复刻映射（现有素材模拟方案，如实标注）

| 参考站 | 我们 | 说明 |
|---|---|---|
| 角色背景视频（角色入画） | world-*.png 全屏背景 + 2:3 立绘放右侧 | 无视频素材；用「背景图 + 立绘叠加」模拟同等构图（立绘底部渐变融入背景） |
| role_name 名字图 | CSS 大字号名字（accent 色） | 美术字图不可用，用文字排版 |
| role_des 台词图 | 职务/副标题行（accent 描边） | 用我们的「职务」字段做标语行 |
| role_text 简介 | bio + 梦想（梦想带 mono 标签） | 保留我们内容语义 |
| roleNav 方头像 tab | 2:3 立绘裁 1:1 头像（object-position:top） | 头像取上半身，灰→彩模拟双态 sprite |
| fade crossFade 1s | 多 slide 叠放 + opacity 过渡 | 纯 CSS，不引 Swiper 依赖 |

## 8. 内容语义（团队映射）

小黑-工程师 / 小优-运维工程师（DevOps/SRE）/ 小夜-私人助理；字段：name/title/bio/dream/accent 来自 `/api/roles`。
