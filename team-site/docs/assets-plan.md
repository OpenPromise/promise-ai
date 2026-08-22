# 视频与图片素材规划（assets-plan）

> 记录人：小黑；日期：2026-08-22；**本阶段不生成素材、不碰 API key**（任务明确），本文件只定需求要点与调用参数，Phase 2 执行。
> 调用参数依据：learnings.md §十五《火山引擎 Seedream 文生图 API 接入》已实测验证的最小可用调用。

## 1. 素材清单总览

| # | 素材 | 用途 | 生成模型 | 尺寸建议 | 阶段 |
|---|---|---|---|---|---|
| 1 | 首页视频 | 首页全屏背景（三成员形象 + 目标） | MiniMax-H3（视频） | 16:9 横版 | Phase 2 |
| 2 | 角色 2D 形象图 ×3 | 角色介绍页立绘 | doubao-seedream-5-0-pro-260628 | 1024×1536 竖版 | Phase 2 |
| 3 | 世界全景图 ×3 | 世界全景页（各自工作环境） | doubao-seedream-5-0-pro-260628 | 1920×1080 横版 | Phase 2 |
| 4 | 都市映像图 ×3 | 都市映像页（梦想愿景） | doubao-seedream-5-0-pro-260628 | 1920×1080 横版 | Phase 2 |

## 2. 首页视频（MiniMax H3）

- **需求要点**（生成时须覆盖）：
  1. 场景：深色科技感都市/工作室环境，青色（#50e5fb 档）霓虹光效，与官网整体深色冷光一致；
  2. 内容：三位成员（小黑-工程师、小优-运维、小夜-助理）的二次元形象依次/同框出现，每人携带其个人目标意象（如小黑：代码/全息屏；小优：服务器/监控面板；小夜：任务板/日程）；
  3. 主题收尾：出现团队愿景文字意象"世界第一 AI 工作室"；
  4. 风格：高质量二次元动画电影质感、流畅运镜、适配网页背景（画面主体居中/留边、避免快速闪烁）。
- **重要原则约束**：视频含三成员形象 → **形象部分必须引用 `characters/*.md` 中每人自写的形象提示词**；组合 prompt 由协调方（小夜/监督者）在三人形象定稿后合并，本阶段不代写任何成员形象。
- **调用参数（已实测落地 2026-08-22，依据 learnings §二十）**：`POST https://api.minimaxi.com/v2/video_generation`（异步，返回 `task_id`），`GET /v2/query/video_generation/{task_id}` 轮询，成功取 `task.content.url` 下载；模型 `MiniMax-H3`；文生视频（t2v）必须带非空 `text`，`ratio` 必填且不能为 `adaptive`（16:9 合法）；`resolution`：`768P`/`2K`；`duration`：4-15 整数秒；鉴权 `Authorization: Bearer $MINIMAX_API_KEY`。火山方舟 Seedance 方案因账号未开通（ModelNotOpen）受阻，CEO 已明确改派 MiniMax H3。
- 输出落地：`team-site/assets/home-video.mp4`（H.264/avc1 + AAC，768P 16:9 10s，2.7MB）。

## 3. 角色 2D 形象图（doubao-seedream-5-0-pro）

- 每个成员一张，**prompt 由该成员本人在 `characters/*.md` 中自写**（本阶段仅小黑已写 `characters/xiaohei.md`；小优/小夜后续阶段自写）。
- 通用需求要点：二次元立绘（半身或全身）、竖版构图、深色背景呼应官网（#1d1d1d 系 + 青色光效）、高清细节、干净利落光影；个人风格（配色/道具/气质）以本人自写 prompt 为准。
- 调用参数（learnings §十五 已验证）：

```json
POST https://ark.cn-beijing.volces.com/api/v3/images/generations
Authorization: Bearer $ARK_API_KEY

{
  "model": "doubao-seedream-5-0-pro-260628",
  "prompt": "<来自 characters/<member>.md 的本人 prompt>",
  "size": "1024x1536",
  "output_format": "png",
  "response_format": "b64_json",
  "watermark": false,
  "optimize_prompt_options": { "mode": "standard" }
}
```

- size 校验（learnings 已确认）：1024×1536 = 1,572,864 像素，落在 [921600, 4624220] 内、宽高比 1.5 ∈ [1/16, 16]，合法。
- 输出落地：`frontend/public/assets/roles/{id}.png`；key 安全按 learnings 经验 4（环境变量注入、不入库、提交前扫描）。

## 4. 世界全景图（工作环境，doubao-seedream-5-0-pro）

- 需求要点：每位成员的工作环境场景（如小黑：三屏工作站 + 全息代码屏的深色机房/工作室；小优：服务器机柜 + 监控大屏的运维作战室；小夜：日程面板 + 任务看板的助理工位）；深色冷光、青色霓虹点缀、与官网一致的氛围；横版全景构图、无人物或背影点缀即可（与角色立绘区分）。
- 调用参数：同上，`size: "1920x1080"`（2,073,600 像素合法，16:9）。生成后如需放大做全屏背景，可 2K 档重绘或留作 poster。
- 输出落地：`frontend/public/assets/worlds/{id}.png`。

## 5. 都市映像图（梦想愿景，doubao-seedream-5-0-pro）

- 需求要点：团队梦想"世界第一 AI 工作室"的未来愿景意象——未来都市天际线、AI 工作室地标建筑、青色科技光带、二次元厚涂电影感；横版；可含"世界第一"的视觉隐喻（如地标顶端的发光徽标）。
- 调用参数：同上，`size: "1920x1080"`。
- 输出落地：`frontend/public/assets/cities/{id}.png`。

## 6. Phase 2 执行清单（交接给后续阶段）

1. 确认三位成员形象 prompt 齐备（每人自写，本阶段仅小黑完成）。
2. 合并首页视频组合 prompt（协调方）；视频模型已切换 MiniMax H3 并落地（2026-08-22，见 §2 与 learnings §二十）。
3. 按 §3-§5 参数脚本生成 3+3+3 张图（脚本放 /tmp 不入库，key 环境变量注入）。
4. 校验产物（learnings 经验 5：PNG 魔数 + IHDR 尺寸 + IDAT 字节量；最终视觉 QA 需人工看图）。
5. 素材入库 `frontend/public/assets/`，引用关系对照 content-model.md 字段。
