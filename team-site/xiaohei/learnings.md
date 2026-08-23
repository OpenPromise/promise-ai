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
