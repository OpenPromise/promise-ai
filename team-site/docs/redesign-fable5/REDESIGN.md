# Promise AI 官网整站重设计（2026-08-24）

> 执行者：Claude Fable 5（CEO 直接派单）；本次改版**抛弃全部旧版内容**，从项目事实出发重新设计。

## 设计概念：「一个人，四位 AI 同事」

这间工作室最独特、也最诚实的事实：一位人类 CEO + 四位各有人格、各司其职的 AI 员工，
系统真实运行（微信通道 / 工具 / 记忆 / 调度 / 审计）。官网只讲这一件事，不编造客户与指标。

视觉语言参考顶级公司实践——Apple 的电影感与克制、Linear 的深色精密感、Anthropic 的排版留白：

- 近黑画布（#07080a）+ 大号中文标题 + 等宽英文系统标签
- 成员签名色：小黑青 #22d3ee / 小优粉 #ff6fb5 / 小夜月蓝紫 #8b9fff /
  小美灰白 + 国际橙 #ff4d21 / CEO 金 #e8b45a
- 动效克制：进入视口淡入上移，尊重 prefers-reduced-motion，无滚动劫持

## 信息架构

Hero（全屏视频）→ 宣言 → 成员（5 人，各自自述）→ 系统（任务旅程 + 能力）→ 历程 → 愿景 → 页脚

## 素材生成

- 图片：火山方舟 `doubao-seedream-5-0-pro-260628`（5 张立绘 1024x1536 + 五人同框 1920x1080）
- 视频：MiniMax `MiniMax-H3` v2 接口，图生视频（首帧 = 五人同框图），768P 16:9 10s
- 提示词：小黑 / 小优 / 小夜使用 `characters/*.md` **本人自写原文**；
  小美（入职当日尚未自写）由本次改版按其 `identity/persona.md` 人格代拟；
  CEO 为背影 + 四色全息微光意象，不使用真人肖像。提示词全文见 `prompts/`。

## 工程

- 前端：React 18 + Vite 6 + TS，纯静态（不再依赖 8080 内容 API）
- 素材经 sharp 压缩为 webp（18MB → 0.9MB），视频 2.1MB
- 部署：替换 `team-site/frontend/`（nginx 拓扑不变），旧版已备份至
  `~/backups/frontend-taskroom-backup-*.tar.gz`
- 成员个人主页 /xiaohei /xiaoyou /xiaoye /xiaomei 不受影响
