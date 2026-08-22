# Seedance 5.0 pro 文生视频 API 调研结论

> 记录人：小黑；调研日期：2026-08-23；依据：火山方舟官方文档（库 82379，`getDocList`/`getDocDetail` 实时抓取）+ 公开报道交叉验证。
> **本文档为调研结论，未实际调用生成视频（不消耗配额），调用参数供首页视频生成（Phase 2）落地使用。**

## 0. 最重要的结论（先说结论）

> ⚠️ **【已确认】官方文档与公开渠道不存在 "Seedance 5.0" / "Seedance-5.0-pro" 模型。**

- 火山方舟文档库 82379（2026-08-23 实时拉取，共 771 个文档）中，视频生成模型清单**最高版本为 Seedance 2.5**，无任何 5.0 条目；
- 公开报道（新华网、澎湃、东方财富等）最新视频生成模型为 **Seedance 2.5**（2026-06 发布、7 月上线，支持 30 秒直出），无 Seedance 5.0 发布记录；
- **【已确认】** "5.0 pro" 目前只存在于**文生图**模型 **Seedream 5.0 Pro**（model ID：`doubao-seedream-5-0-pro-260628`，ByteDance 官方博客确认）。CEO 要求的 "Seedance-5.0-pro" **极可能为 Seedream（图）与 Seedance（视频）的混淆**（推断，待监督者与 CEO 澄清）。

**执行建议**：首页视频若必须走官方公开模型，当前唯一可用最新模型为 **Seedance 2.5**（`doubao-seedance-2-5-260628`），与本仓库 `assets-plan.md` 原规划一致；若坚持 5.0，需先向火山方舟确认是否存在未公开/内测模型 ID，**不要编造 model ID**。

---

## 1. 模型 ID（以官方文档为准）

### 1.1 官方现有文生视频模型清单（已确认，来源：库 82379 官方教程/API 文档）

| 模型 | Model ID | 备注 |
|---|---|---|
| Seedance 2.5 | `doubao-seedance-2-5-260628` | **当前最新**；30 秒直出、50 个全模态参考、有声视频；默认值 720p |
| Seedance 2.0 | `doubao-seedance-2-0-260128` | 支持 4k、有声 |
| Seedance 2.0 fast | `doubao-seedance-2-0-fast-260128` | |
| Seedance 2.0 mini | `doubao-seedance-2-0-mini-260615` | |
| Seedance 1.5 pro | `doubao-seedance-1-5-pro-251215` | 文档示例默认；支持 draft 样片 |
| Seedance 1.0 pro | `doubao-seedance-1-0-pro-250528` | |
| Seedance 1.0 pro fast | `doubao-seedance-1-0-pro-fast-251015` | |

> **命名规律**（已确认，用于未来 5.0 发布的对照推断）：`doubao-seedance-<版本>-<发布日期 YYMMDD>`。若未来 Seedance 5.0 pro 发布，**推断**（未验证）ID 形如 `doubao-seedance-5-0-pro-<YYMMDD>`（对照 Seedream 5.0 pro 的 `doubao-seedream-5-0-pro-260628`），**但此 ID 当前不存在，严禁直接使用**。

### 1.2 本次未能确认的信息（如实说明）

- Seedance 5.0 / 5.0 pro 的模型 ID：**查不到**（官方文档树、API 文档、公开报道均无）；
- 若 CEO 有内测渠道拿到 5.0 的 model ID，需以火山方舟控制台/文档实际返回为准。

---

## 2. API 端点与鉴权（已确认，来源：库 82379 文档 1520757/1521309/1521675）

| 操作 | 端点 | 说明 |
|---|---|---|
| 创建视频生成任务 | `POST https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks` | 异步：提交后返回 task id |
| 查询视频生成任务 | `GET https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks/{id}` | 轮询状态；**仅支持最近 7 天任务** |
| 查询任务列表 | `GET https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks?page_size=N&filter.status=<status>` | 可选 |

- **鉴权**（已确认，与 seedream 相同）：Header `Authorization: Bearer $ARK_API_KEY`，API Key 从火山方舟控制台 API Key 管理页获取（`https://console.volcengine.com/ark/region:cn-beijing/apiKey`）。Access Key 鉴权时 model 需换 Endpoint ID。
- Base URL：`https://ark.cn-beijing.volces.com/api/v3`（官方 SDK 默认值）。

---

## 3. 请求参数（已确认，来源：库 82379 文档 1520757）

### 3.1 最小文生视频请求体（Seedance 2.5）

```json
{
  "model": "doubao-seedance-2-5-260628",
  "content": [
    {
      "type": "text",
      "text": "小猫对着镜头打哈欠"
    }
  ],
  "ratio": "16:9",
  "resolution": "720p",
  "duration": 5,
  "generate_audio": true,
  "watermark": false
}
```

### 3.2 参数明细表

| 参数 | 类型/默认 | 说明 | 模型支持 |
|---|---|---|---|
| `model` | string，必选 | 模型 ID | — |
| `content[].type` | string，必选 | 输入内容类型，`text` / `image_url` / `video_url` / `audio_url` / `draft_task` | — |
| `content[].text` | string | 文本提示词（文生视频时仅此一项即可） | — |
| `content[].image_url.url` | string | 图片 URL（首帧/尾帧/参考图） | — |
| `content[].role` | string | `first_frame`（首帧）/ `last_frame`（尾帧）/ `refer`（参考图）；首帧图生视频可只传 1 张 `first_frame` | 2.5 支持首尾帧 |
| `generate_audio` | boolean，默认 true | 是否生成同步有声视频（对话建议放双引号内） | 2.5 / 2.0 系列 / 1.5 pro |
| `ratio` | string，默认 adaptive | 宽高比：`16:9`、`4:3`、`1:1`、`3:4`、`9:16`、`21:9`、`adaptive`（编辑/延长/首帧任务仅支持 adaptive，自动保持输入比例） | 2.5：默认 adaptive |
| `resolution` | string | `480p`、`720p`、`1080p`；2.0 额外支持 `4k`。**2.5 不支持 4k**；2.5 的 1080p 为 10bit H.265/HEVC | 2.5：默认 720p，480p/720p/1080p |
| `duration` | integer | 时长秒；2.5：`[4, 30]` 或 `-1`（智能选择）；2.0：`[4, 15]`；1.5 pro：`[4, 12]`；1.0：`[2, 12]`。`duration` 与 `frames` 二选一 | 2.5：默认 -1 |
| `output_format` | string，默认 mp4 | `mp4`（通用）/ `mov`（高色彩精度，仅 2.5） | 2.5 支持 mov |
| `watermark` | boolean，默认 false | 是否加水印（右下角 "AI 生成"） | — |
| `seed` | integer | 随机种子 | — |
| `camera_fixed` | boolean，默认 false | 固定摄像头（参考图场景不支持） | 1.5 pro / 1.0 |
| `omni_reference_task_type` | string，默认 auto | 任务类型：`auto` / `reference`（参考生视频）/ `edit`（视频编辑）/ `extend`（视频延长） | 2.5 |
| `return_last_frame` | boolean，默认 false | 返回尾帧图（png，用于连续视频拼接） | — |
| `service_tier` | string，默认 default | 服务等级：`default`（在线）/ `flex` / `dedicated` / `offline` 等 | — |
| `execution_expires_after` | integer，默认 172800 | 任务超时阈值（秒），范围 `[3600, 259200]` | — |
| `safety_identifier` | string | 终端用户唯一标识（≤64 字符，建议哈希） | — |

> 兼容性提示：`resolution`、`ratio`、`duration`、`frames`、`seed`、`camera_fixed`、`watermark` 也支持在提示词后追加 `--rs 720p --rt 16:9 --dur 5 --seed 11 --cf false --wm true` 弱校验传参（所有模型兼容）；推荐 request body 强校验方式。

### 3.3 首页视频（16:9 横版）推荐参数（推断，基于已确认参数表）

```json
{
  "model": "doubao-seedance-2-5-260628",
  "content": [{ "type": "text", "text": "<组合 prompt，覆盖三成员形象+目标+主题收尾>" }],
  "ratio": "16:9",
  "resolution": "1080p",
  "duration": 10,
  "generate_audio": false,
  "watermark": false,
  "output_format": "mp4"
}
```

- 说明（推断）：首页背景视频建议 `generate_audio: false`（网页背景无声更稳妥）、`1080p`（若担心 H.265 兼容性可退 720p）、`mp4` 容器；时长 10s 内（2.5 上限 30s）。实际以生成阶段视觉 QA 为准。
- 视频 URL 24h 有效且 2.5 下载次数上限 100 次，生成后须及时下载转存（官方建议 TOS 数据订阅）。

---

## 4. 轮询方式（已确认，来源：库 82379 文档 1521309）

1. **提交**：POST 创建任务 → 响应返回 `id`（任务 ID）；
2. **轮询**：`GET /api/v3/contents/generations/tasks/{id}`，状态字段 `status`：
   - `queued`：排队中；
   - `running`：运行中；
   - `cancelled`：已取消（取消状态 24h 自动删除；只支持 queued 任务取消）；
   - `succeeded`：成功；
   - `failed`：失败（`error.code` / `error.message` 详因）；
   - `expired`：超时（超过 `execution_expires_after`）；
3. **取结果**：`succeeded` 后读 `content.video_url`（24h 有效，2.5 下载 ≤100 次）、`content.last_frame_url`（若开启 return_last_frame）；`usage.completion_tokens` 为计费 token；
4. 官方 SDK 示例轮询间隔：10~60 秒；仅支持查询最近 7 天任务。

响应关键字段：`id`、`status`、`model`、`content.video_url`、`content.last_frame_url`、`duration`（= 实际帧数/24 向下取整）、`frames`、`resolution`、`ratio`、`generate_audio`、`output_format`、`framespersecond`、`created_at`、`updated_at`、`error`、`usage`。

---

## 5. 参考资料（官方文档 ID，库 82379）

| 文档 | 文档 ID | 内容 |
|---|---|---|
| 创建视频生成任务 | 1520757 | 端点、请求/响应参数、模型能力表 |
| 查询视频生成任务 | 1521309 | 状态字段、结果 URL |
| 查询视频生成任务列表 | 1521675 | 列表接口 |
| 取消或删除视频生成任务 | 1521720 | 取消接口 |
| Doubao Seedance 2.5 教程 | 2607688 | 模型 ID、能力、示例（30 秒直出） |
| 视频生成教程 | 2298881 | 各语言 SDK 调用示例与轮询写法 |
| Base URL 及鉴权 | 1298459 | 鉴权细节 |

获取正文方式（learnings §十五-1 经验）：`GET https://docs.volcengine.com/api/doc/getDocDetail?LibraryID=82379&DocumentID=<文档ID>&lang=zh`。

---

## 6. 置信度汇总

| 结论 | 置信度 | 依据 |
|---|---|---|
| Seedance 5.0 / 5.0 pro 不存在于官方文档与公开渠道 | **已确认** | 库 82379 文档树（771 篇，无 5.0 条目）+ 3 轮 web 搜索无任何发布记录 |
| 官方现有最新文生视频模型为 Seedance 2.5（`doubao-seedance-2-5-260628`） | **已确认** | 官方教程 2607688 模型 ID 表格 + 创建任务文档模型能力表 |
| 端点 POST `/api/v3/contents/generations/tasks`、GET `/tasks/{id}`、Bearer 鉴权 | **已确认** | 官方文档 1520757/1521309 原文 |
| 请求参数表（ratio/resolution/duration/generate_audio 等） | **已确认** | 官方文档 1520757 参数表原文 |
| CEO "Seedance-5.0-pro" 系 Seedream（图）与 Seedance（视频）混淆 | **推断** | 5.0 pro 仅 Seedream 文生图存在（官方博客）；未见其他合理解释 |
| 未来 5.0 命名规律 `doubao-seedance-5-0-pro-<YYMMDD>` | **推断（未验证）** | 对照既有命名规律；当前无此 ID，不可使用 |
| 首页视频推荐参数（16:9/1080p/无声/mp4/10s） | **推断（未验证）** | 基于已确认参数表按首页场景推导，未实测 |
