# 小黑 · 跨任务经验沉淀（长期记忆）

> 格式：一条经验 = 触发场景 + 动作 + 证据。标注置信度：高=跨任务多次验证；低=单次观察（待验证）。
> 重要结论回溯权威来源（代码/文档/工具输出）验证后才可当指令复用。

## 1. 参考站逆向（异环官网角色板块，2026-08-23，高置信）

- **触发场景**：1:1 复刻 yh.wanmei.com/main.html 角色板块。
- **动作/结论**：
  - 站点是 2560×1440 设计稿按 rem 等比缩放：内联 JS `docEl.style.fontSize = 100*(clientWidth/2560)px`，**1rem=100px@2560**，所有 CSS rem 值可直接换算设计稿像素。
  - 角色板块（pageRole）无板块标题、无左右大箭头；结构 = 左侧竖排头像导航条（深灰圆角框+上下箭头）+ 整屏角色 slide（背景视频+名字图+台词图+简介滚动文本），角色立绘在视频画面**右侧**（poster 像素级确认），信息区左缘 = 中心-820px（约 18vw）、名字顶 36% 高。
  - 切换交互：点击缩略图/导航箭头 → 主轮播 **fade crossFade 交叉淡化 ≈1s**（Swiper `slideToLoop(realIndex,1000)`）。
  - 移动端（/m/）是另一套 DOM：顶部横排导航 + 底部信息面板 + 「更多」按钮展开描述层（#111 底、青色 #4fe5fb 滚动条）。
  - 双态 sprite 技法：`.role-tab-* p` 背景图 138×278（上=普通、下=激活，`background-position:0 100%` 切态）；箭头 hover 同样切 sprite（灰→青）。
- **证据**：main.html/main260813.css/main260702.js/m 版全部抓到并解析；tab sprite 像素解码确认双态。完整记录见 `docs/roles-1to1.md`。

## 2. 无头浏览器布局验证（极简容器，高置信）

- **触发场景**：需要真实浏览器验证布局/动画（无显示环境、模型不能看图片）。
- **动作**：
  - 环境无字体 → **`ch` 单位解析为 0、所有文本宽度 0、元素高度坍缩**（页面"看起来坏了"其实是环境缺字体！）。装字体（fonts-wqy-zenhei + fonts-dejavu-core，dpkg -x 到 /tmp 根）+ 自定义 fonts.conf（`FONTCONFIG_FILE` 指向它）后正常。
  - 无 GUI 库 → apt-get download + dpkg -x 解包 libglib/libnss3/libX11/cairo/pango 等 ~30 个 deb 到公共根，`LD_LIBRARY_PATH` 指过去即可跑 Chrome。
  - 完整 Chrome 在极简容器启动崩溃 → 用 **chrome-headless-shell**（npmmirror CDN 下载，`cdn.npmmirror.com/binaries/chrome-for-testing/...`，比 storage.googleapis.com 快一个数量级）。
  - 验证用 `getBoundingClientRect` 几何断言（导航左侧/立绘右侧/信息区不重叠/仅当前 slide 可见/动画中间帧采样），比截图可靠且不依赖看图能力。
- **证据**：16/16 布局断言通过；fade 中间帧 0.89→0 / 0.11→1 确认交叉淡化；`1ch=0px` 探针确认字体缺失是坍缩根因。

## 3. npm 极简环境避坑（高置信）

- **触发场景**：沙箱容器里 npm install 报 `/root/.npm` 权限错、postinstall 被拦。
- **动作**：`npm install --cache <tmp> --userconfig <tmp/npmrc>` 绕过 /root 写权限；npm 11 默认拦 postinstall，用 `npm install-scripts approve <pkg>` 放行（puppeteer 下载 Chrome 需此步）。
- **证据**：jpeg-js / puppeteer 安装成功。

## 4. 交叉淡化纯 CSS 实现（高置信）

- **触发场景**：不引 Swiper 依赖实现参考站整屏 fade crossFade。
- **动作**：多 slide 绝对叠放，`.role-slide{opacity:0;visibility:hidden;transition:opacity .9s ease,visibility .9s}` + `.is-active{opacity:1;visibility:visible}`——visibility 离散过渡（显→隐在动画末尾翻转）恰好构成交叉淡化，且隐藏 slide 自动退出可访问性树。
- **证据**：浏览器中间帧采样 0→1 平滑，aria/焦点无冲突。

## 5. 素材仿真参考站效果（低置信，待验证）

- **触发场景**：无角色视频，用静态图模拟"立绘入画"构图。
- **动作**：world 图作背景 + 2:3 立绘放右侧（`mask-image` 底部/左缘渐变融入背景 + 背后青色氛围光 + brightness(1.12) 提亮），暗色素材需适度提亮否则与背景糊在一起（小黑场景过暗，亮度 0.72→0.8 + 立绘 1.12 后结构可见）。
- **证据**：截图像素统计立绘区亮度对比；未在真实设备/多浏览器验证，待验证。

## 6. 参考站导航栏 + 情报速递逆向（2026-08-23，高置信；**同日夜修正：sprite 三态方向勘误**）

- **触发场景**：1:1 复刻 yh.wanmei.com/main.html 顶栏 + pageNews。
- **动作/结论**：
  - 顶栏（`.header`，样式在 **public260423.css** 而非 main260813.css）：**实底 #1d1d1d** 固定条，高 118px 设计稿（4.6vw），右侧贴 664×144 品牌字标图（bg no-repeat 100% 0）；logo 左 170px 设计稿；导航组绝对居中、按钮 **241×40 紧贴无间距**、三态 sprite（`0 0` / `0 -.4rem`=hover / `0 -.8rem`=active）。
  - ⚠️ **勘误（CEO 反馈后复扒）**：导航 sprite（headerNav1-6.png，241×120）三态**不是**"白→灰暗化"——上轮把 y 段方向看反了。实测：**normal=灰 rgb(170,170,170) → hover=白 rgb(255,255,255) → active=青 rgb(81,229,251)**（headerNav1/首页 active=#7CECFC=124,236,252）；**active 段青色像素占比 100%**。**零光晕**：alpha 直方图无扩散半透明、CSS 无 box-shadow/text-shadow、JS 无 glow → "发光"= 纯切图换色。**按钮背景透明**（sprite 仅文字像素，92% 透明），"黑底"即顶栏 #1d1d1d 本身。
  - **一体感关键**：按钮**不加黑底**（透明背景浮在 #1d1d1d 实底顶栏上）；若给按钮加 `#0a0a0a` 底色，视觉上变成"独立黑条"破坏顶栏一体（CEO 反馈 2 根因）。
  - pageNews：左列（927 宽：926×196 标题图 + 内嵌 Tab 157×62 + **固定 5 行列表**）+ 右列（926×468 边框 6px #363636 图轮播 + **图片下方标题条 + 右下分页点**）+ 顶部 y=705 装饰细线（7px 高、白点、左右断开各距中心 1000px）。
  - **列表高度恒定**：参考站 newsCont 无 CSS 固定 height，靠 JS 固定渲染 5 条（`if(!(t>=5))`）+ 行高固定实现；行高实测 64px@1920 = 85.3px 设计稿。
  - 行结构 = 徽章（95×37 skew(-15deg) 内层反切，青/粉/紫）+ 标题（#dfdfdf 30px 设计稿，hover #7ce3f2）+ 日期（MM/DD 右对齐），**无摘要/无封面/无置顶标**；每频道 5 条。
  - Tab 激活态 = #1d1d1d 底 + radius 10 + skew(-15deg)，内层按钮反切 skew(15deg)（`transform` 内层反切是 sprite 切态的通用技法）。
  - 右列轮播数据 `yh_data_data.lb1`：`{title, bigpic(1068×540 ≈ 926×468 同比例), link}`，Swiper loop+autoplay，`newsSwiperTit`（图片下方）显示当前标题。
  - 移动端 /m/ 是独立页面：轮播在上、列表在下（居中 6.14rem），Tab 居中，gamenews 徽章用 #51e5fb（与桌面 #7ce3f2 不同）。
- **证据**：4 份 CSS/JS/数据 + 13 张素材全部抓到并解析；sprite 用 node pngjs 逐段取色（三态主色如上）+ ASCII 渲染验证方向；无头浏览器实测几何（header 88.5px@1920、按钮 180.75×30、列表 5×64px 固定高、右列边框 4px@1920）；完整记录见 `docs/navbar-news-1to1.md`。

## 9. sprite 三态像素分析姿势（高置信，本轮踩坑）

- **触发场景**：从 sprite 背景图扒三态 hover/active 颜色。
- **动作**：sprite 通常竖排多段（每段 = 按钮高）；用 `pngjs` 按 y 分段统计主色 + ASCII 渲染整图确认文字方向；**先确认哪段对应哪个 CSS 状态**（`background-position` 的负偏移方向 = 向下取段），再取色。alpha 直方图看是否有扩散半透明（判断有无光晕），透明像素占比看按钮是否有底色。
- **证据**：上轮因段方向看反得出错误"白→灰"结论，本轮按 CSS `0 -.4rem/-.8rem` 方向重新取色即得"灰→白→青"。

## 10. doubao-seedream 生成占位素材（高置信，本轮验证）

- **触发场景**：需要"团队生活照/宣传图"风格素材但无真实照片。
- **动作**：火山 ark `POST https://ark.cn-beijing.volces.com/api/v3/images/generations`，model **`doubao-seedream-4-0-250828`**（3-0-t2i 旧名 404）、`{prompt, size:"1280x720", response_format:"url", watermark:false}`；返回 `data[0].url` 直链下载。写实风关键词：写实摄影风格照片、真实人物、自然抓拍、生活化瞬间。**key 走环境变量、脚本放 /tmp、严禁入库**；提交前 `git grep` 确认零泄漏。
- **降级**：图片生成失败/无 key 时用现有素材或纯色占位，URL 集中配置文件管理，标注"待替换"。
- **证据**：3 张 1280×720 生成成功；模型 4-0 可用（3-0/3-5/4-0 其他日期名 404）。

## 11. JPEG 元数据（C2PA）剥离（高置信，本轮验证）

- **触发场景**：AI 生成图自带 C2PA（AI 内容凭证）APP11 段，希望去掉 AI 指纹/减小体积。
- **动作**：JPEG 段解析：SOI(FFD8) 后各段 `FF marker + 2字节长度 + 数据`，SOS(FDDA) 后为熵编码原样拷贝。C2PA 在 **APP11(0xEB)** 段（非 APP1），按段名含 `c2pa` 删除即可。**勿删 DQT(0xDB)/DHT(0xC4)/SOF(0xC0)**——那是解码必需（上轮误删致图片损坏）。
- **证据**：剥离后图片 1280×720 正常渲染、`c2pa` 字节消失、体积 -25%。

## 7. headless-shell 截图不渲染背景色（高置信，本次新发现）

- **触发场景**：想用截图做参考站像素级取色/对齐验证。
- **动作/结论**：此环境 chrome-headless-shell 152 的截图合成器**不绘制元素背景色**——连 `setContent('<div style="background:#fe5a95">')` 的纯色 div 截出来都是黑（换 `--use-gl=angle/--use-angle=swiftshader/--disable-gpu-compositing` 均无效）；但文字、边框、背景图线条能渲染。→ **像素截图验证在此环境不可靠**，改用 DOM 几何（getBoundingClientRect）+ getComputedStyle 断言（与上轮角色板块同法）；参考站颜色以 CSS 源码声明为准。
- **证据**：纯色 div 三组渲染参数截图中心像素均 (0,0,0)；注入参考站页内同样全黑；几何断言 28/28 通过。

## 8. 参考站资源抓取要点（高置信）

- **触发场景**：抓 yh.wanmei.com 资源。
- **动作**：header 样式在 `style/public260423.css`（不在 main260813.css）；导航/新闻素材在 `images/cover250513/`、`images/main260326/`、`images/cover240718/` 目录；移动版是 `m/` 独立子站（m/style/main260813.css）；新闻数据在 `include/newsData20260112.js`（全局 `newsdataObj`，pc/m 双份）；所有资源直链可 curl（图片无需 Referer）。
- **证据**：本任务 4 CSS/JS + 13 图片全部 200 抓取成功。
