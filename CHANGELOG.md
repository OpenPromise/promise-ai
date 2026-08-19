# Changelog

## [0.14.24] - 2026-08-20

### 自我开发完善：新增工具权限准则 + 守卫测试

- **规则层**：`persona/self-development.md` 新增「新增工具准则（权限与通道）」——
  新增工具前必须回答通道/权限约束/是否永久破坏性/风险匹配四个问题；
  明确微信通道 L2/L3 自动拒绝，微信工具只能是 L0/L1；永久删除类操作用户
  明确要求时 L1 并标注"永久/不可恢复"
- **编码侧**：`AGENTS.md` 同步写入权限准则，coding.run（dsh）读仓库规则
- **守卫测试**：新增测试强制 `weixin.*` 工具权限 ≤ L1——若自我开发写出
  L2 微信工具，`self.check` 会失败并自动修正（形成自我纠错闭环）

## [0.14.23] - 2026-08-20

### 微信文件库删除功能

- **`weixin.delete_file`（L1）**：按文件名（精确/前缀/包含）从微信文件库
  删除文件，永久删除、不可恢复；任何会话可用
- **桥接口**：`POST /api/weixin/delete-file`（文件名消毒防路径穿越）
- 说明：删除为 L1 自动执行（微信通道无法做 L2 确认）；自我开发在微信里
  生成的代码改动需要人工部署激活（`system.restart` 为 L3，微信不可确认）

## [0.14.22] - 2026-08-20

### 微信后台异步文件发送 + 实时进度

- **异步后台任务**：`weixin.send_file` 立即返回 `jobId`，上传/投递在桥后台
  执行，对话不阻塞，期间可继续聊天
- **分步进度实时推送微信**：📤 开始上传 → ⏳ 上传完成、投递中 → ✅ 已送达
  / ❌ 失败原因，完成时自动提醒
- **任务查询**：`GET /api/weixin/jobs` / `/api/weixin/jobs/:id` 查看状态
  （queued / uploading / sending / done / failed）
- **去重**：同一文件发送中不会重复创建任务；异步任务同样支持模糊匹配

## [0.14.21] - 2026-08-20

### 修复大文件传输假超时与重复发送

- **sendMessage 超时 15s → 120s**：大文件（几十 MB）时服务端需校验 CDN
  文件后才回执，15s 会假超时导致"已中断"误报
- **CDN 上传单次 180s 超时、getuploadurl 30s**：杜绝挂起也不再轻易掐断
- **工具层放宽**：`weixin.send_file` 超时 60s → 300s，`send_image` → 120s
- **行为规则**：大文件/媒体调用超时或报错时先询问用户是否收到，禁止自动
  重试，避免重复发送

## [0.14.20] - 2026-08-20

### 微信中继稳定性加固（修复"暂无法连接 OpenClaw"）

- **单条消息处理护栏**：图片下载 / 视觉识别 / 对话任一环节卡死超过 90 秒
  即中断并继续轮询，避免 relay 永久阻塞导致微信侧显示"暂无法连接"
- **网络调用超时**：CDN 图片下载 30s、DashScope 视觉调用 60s，杜绝挂起
- **心跳日志**：relay 每分钟记录一次轮询状态，异常时可快速定位

## [0.14.19] - 2026-08-20

### 文件库任意会话可用 + 上限提升

- **任意会话可发文件**：`weixin.send_file` 不再要求当前会话是微信会话——
  桌面/网页等会话请求文件时，桥自动回退到已绑定的微信账号发送
- **文件上限 20MB → 100MB**：对齐参考实现入站上限，交给平台判断
  （如 28MB 的 psd 也能发）

## [0.14.18] - 2026-08-20

### 微信文件库（本地文件直发微信）

- **服务器专属文件库**：`<仓库>/weixin-files` 目录（bind mount 到桥容器
  `/data/weixin-files`），直接往目录里丢文件即入库
- **按名发送**：`weixin.send_file`（L1）按文件名精确/前缀/包含匹配 →
  桥读取 → iLink 文件消息（`file_item`）发送；`weixin.list_files`（L0）
  随时列出文件库（名称/大小/时间）；超过 20MB 拒绝
- **入站文件自动入库**：微信里发给 bot 的文件下载解密后自动保存到文件库，
  并告知大脑，之后可按名要回
- **安全**：文件名消毒防路径穿越，只读文件库目录
- **测试**：新增文件库匹配/消毒/读写、文件消息结构、入站文件中继、
  文件工具用例，全量 209 passed / 3 skipped

## [0.14.17] - 2026-08-20

### 微信收图理解 + 提醒/任务推送微信

- **收图理解**：微信里给 bot 发图片 → 桥下载并 AES-128-ECB 解密 CDN 图片
  （兼容 16 字节/32 hex 两种 aes_key 编码）→ DashScope 视觉模型
  （`WEIXIN_VISION_MODEL`，默认 qwen3.8-max）描述 → 连同描述交给大脑回复；
  识别失败有兜底提示
- **事件推送微信**：weixin-bridge 订阅 agent-server `/api/events`（SSE），
  提醒（`reminder.due`）与定时任务结果（`task.run`）主动推送到所有已登录
  微信对端（⏰/✅/❌ 格式，断线指数退避重连）
- **测试**：新增入站解密、视觉描述、图片中继、事件格式化用例，
  全量 201 passed / 3 skipped

## [0.14.15] - 2026-08-20

### 微信媒体发送修复 + 语音探索结论

- **修复 CDN 上传域名**：媒体上传必须走微信 CDN
  `https://novac2c.cdn.weixin.qq.com/c2c`（此前误用 ilink 主站导致 404）；
  `getuploadurl` 只返回 `upload_param` 时按 CDN 拼接上传地址
- **真实端到端验证**：向微信发送测试图片与 ElevenLabs 合成语音均成功
  （图片消息成功送达；语音消息服务端返回成功但客户端不显示——原生
  voice_item 被服务端静默丢弃，参考实现同样不支持，详见 0.14.16）
- **健康检查修复**：weixin-bridge 覆盖镜像内置的健康检查（:3100），容器
  显示 healthy

## [0.14.16] - 2026-08-20

### 移除微信语音发送

- 微信原生语音气泡在 iLink 服务端不可用（协议枚举存在但服务端静默丢弃，
  OpenClaw/hermes 等参考实现均未提供可用路径），**删除语音发送全部代码**：
  `weixin.send_voice` 工具、桥 `/api/weixin/send-voice`、silk 转码模块、
  `silk-wasm` 依赖、Dockerfile 中的 ffmpeg
- 保留：微信**接收**语音并自动转文字（`voice_item.text`，平台自带转写）；
  图片发送（`weixin.send_image`）继续可用

## [0.14.14] - 2026-08-20

### 微信媒体发送（图片 + 语音）

- **图片发送链路**：`weixin.send_image` 工具（L1）→ weixin-bridge
  `/api/weixin/send-image` → iLink `getuploadurl` 预签名 + AES-128-ECB 加密
  上传 CDN（`x-encrypted-param`）→ `image_item` 消息；支持服务器本地图片
  路径或 http(s) URL
- **会话绑定**：weixin-bridge 建会话时写入 `metadata.weixinPeer`，工具据此
  定位要发送的微信对端；compose 内 agent-server 通过
  `WEIXIN_BRIDGE_URL=http://weixin-bridge:3100` 回调桥
- **测试**：新增媒体协议闭环（加密/上传/消息结构）、图片工具、会话元数据
  断言

## [0.14.13] - 2026-08-20

### 微信 ClawBot 接入（weixin-bridge，方案 A 自研轻量桥）

- **新增 `services/weixin-bridge`**：不依赖 OpenClaw，直接对接腾讯 iLink
  （`ilinkai.weixin.qq.com`）ClawBot HTTP 协议——扫码登录
  （`get_bot_qrcode` / `get_qrcode_status`）、消息长轮询（`getupdates`）、
  回复（`sendmessage`）、输入中（`sendtyping`）、起停通知
  （`notifystart/stop`），鉴权用 `ilink_bot_token` + Bearer
- **消息闭环**：微信私聊消息 → agent-server `/api/sessions/:id/chat`（按
  对端自动建会话并持久化映射）→ Markdown 转纯文本 → 长回复分段 → 回微信
- **权限策略**：L2/L3 工具在微信通道默认拒绝（自动提交 permission 拒绝），
  并回微信提示"请到桌面端授权"
- **登录页**：`GET /weixin/login` 提供扫码页（自动轮询状态、过期可刷新、
  配对码输入）；token/同步游标/会话映射持久化到数据卷，重启自动续接
- **部署**：compose 新增 `weixin-bridge` 服务（同镜像、端口 3100、数据卷
  `weixin-data`）；已部署到腾讯云服务器

## [0.14.12] - 2026-08-20

### 远程服务器部署（腾讯云 Ubuntu 24.04）

- **新增部署脚本** `scripts/deploy/install-docker.sh`：腾讯云/国内网络环境下
  安装 Docker CE + compose 插件（腾讯云镜像源），并配置 registry 镜像加速
  （腾讯云内网 + DaoCloud 兜底）
- **部署验证**：`122.152.209.182:3000` 全链路可用——/health 正常、LLM
  fallback 生效、postgres 记忆后端、dsh 内置；公网对话验证 `self.info` +
  `memory.remember` 落库成功
- **安全加固**：postgres 仅绑定 127.0.0.1（`infrastructure/.env` 的
  `POSTGRES_PORT`），ufw 只放行 22/3000，Docker 转发策略设为 ACCEPT

## [0.14.11] - 2026-08-20

### 文件权限体验对齐 + Docker 全链路部署验证

- **新增桌面本地工具**：`filesystem.read`（L0，读取文本文件，>256KB 截断标注）、
  `filesystem.list`（L0，列出目录内容），读文件/列目录不再需要走 L3 终端
- **权限体验对齐**：日常文件操作（读写/移动/复制/删除/压缩/解压/建目录/打开）
  全部 L0/L1 自动执行免确认；删除进回收站并拒绝系统关键目录；仅
  `system.power` / `terminal.run` 保留 L3，`process.kill` / `screen.click` /
  `screen.type` 为 L2
- **测试覆盖**：vitest 纳入 `apps/desktop-agent`，新增 read/list 单元测试
- **Docker 全链路验证**：Ubuntu 镜像构建成功（Node 24 + dsh 0.1.0-rc.7），
  容器内 `/health` 正常、记忆后端 postgres、LLM fallback 生效；端到端对话验证
  `self.info`（/app、Linux、dsh、postgres）+ `memory.remember` 落库；
  容器重启后记忆仍在

## [0.14.10] - 2026-08-20

### Prime Agent 参考吸收（证据驱动改进 + 持久目标 + 反馈启动摘要）

- **self.refine（证据驱动的自我改进）**：把失败证据/用户反馈沉淀成一条小规则，
  只追加到 `persona/refinements.md`（经验层，不改写基础人设），同时写入
  `[feedback]` 长期记忆；返回当前 git 快照作为回滚点
- **self.rollback（快照回滚）**：L3 二次确认后 `git reset --hard` 回滚到
  self.refine 记录的快照；回滚后调用 system.restart 让改动生效
- **持久目标 goal.\***：`goal.set` / `goal.list` / `goal.done` 把长期目标以
  `[goal]` 前缀写入长期记忆（跨会话存活、同 title 覆盖），无新增存储抽象
- **反馈台账启动摘要**：每次对话自动注入「长期目标 + 近期 [feedback] 教训」
  到系统提示词（上限 5 目标 / 3 条反馈），让 AI 跨会话推进目标、避免重复踩坑
- **persona 经验层**：`FilePersonaProvider` 新增 `refinements.md`（可选文件），
  存在即注入系统提示词，缺失自动跳过

## [0.14.9] - 2026-08-19

### OpenCrabs / Prime Agent 参考吸收（故障韧性 + 有界自我开发）

- **LLM 多后端故障转移**：主模型（qwen3.8-max）未产出内容即失败时，透明
  切换到备用后端（OpenRouter，默认 deepseek-v4-pro）；流式一旦开始则不回滚，
  由上层既有错误路径处理。配置：`LLM_FALLBACK_PROVIDER` / `LLM_FALLBACK_MODEL`
- **记忆混合检索 RRF**：向量 + 关键词双路独立召回，用 Reciprocal Rank Fusion
  融合排名（不再"向量优先、关键词兜底"）；内存库与 Postgres 库同步升级
- **重启恢复上报**：服务启动时扫描最近 24h 会话，为存在"悬空工具调用"的
  会话注入中断提示（幂等，不重复注入），让下一轮对话知道任务曾被重启打断
- **有界自主自我开发**：`self.check` 新增 `goal` / `maxIterations` 参数并在
  输出中返回预算与质量门约束；`persona/self-development.md` 新增有界自主规则
  （目标+最多 3 轮迭代+质量门失败即回滚）与反馈台账（[feedback] 记忆）

## [0.14.8] - 2026-08-19

### 自我开发与更新能力

- **新增自我开发工具**：`self.info`（L0，项目根/版本/环境）、
  `self.check`（L1，跑 typecheck + 测试作为改动门禁）、
  `system.restart`（L3 二次确认，优雅重启让改动生效）
- **自我开发行为准则**：新增 `persona/self-development.md`（注入系统提示词），
  规定流程：self.info → 读代码出方案 → coding.run 实现 → self.check 全绿 →
  更新 CHANGELOG → system.restart 生效；并划红线（不改密钥/不绕权限/
  不自动发起/破坏性操作需确认）
- **守护进程**：新增 `npm run serve`（agent-supervisor），服务退出自动拉起，
  带防重启风暴退避；容器部署靠 Docker `restart: unless-stopped`
- **git 基线**：仓库初始化并提交基线 commit（138 文件），自我更新可回滚

## [0.14.7] - 2026-08-19

### coding.run 移入服务端 + 全服务端部署拓扑

- **coding.run 从桌面代理搬到服务端**：编码能力属于"大脑"，不依赖桌面客户端；
  服务端直接驱动 dsh（DeepSeek Harness，默认 deepseek-v4-flash），
  `CODING_AGENT=claude` 仍可切 Claude Code（服务器未装时给出明确提示）
- **Docker 镜像内置 dsh**：构建期安装 `@deepseek-ai/dsh` + pnpm 并引导 headless
  profile；入口脚本把 `DEEPSEEK_API_KEY` 写入 dsh 凭证文件后启动服务
- **拓扑**：服务器 = agent-server + Postgres + coding.run（Ubuntu 容器）；
  桌面 UI / 桌面代理是薄客户端（麦克风、音频、本机工具），通过
  `AGENT_URL` / `AGENT_WS_URL` 连接远端；树莓派、车机等未来客户端走同一套
  WebSocket/SSE 协议（语音 /ws/voice、事件 /api/events）
- 实测：容器内 `dsh` 正常推理；服务端 qwen 经 coding.run 调用 dsh 在
  `/tmp` 创建文件并回读验证成功

## [0.14.6] - 2026-08-19

### Docker 服务端部署（Ubuntu）

- **新增 `Dockerfile`（Ubuntu 24.04 + Node 24）**：只打包 agent-server 生产运行
  （`npm ci --omit=dev`，跳过 electron/esbuild 等构建依赖），含 `/health` 健康检查
- **compose 新增 `app` 服务**（`server` profile）：自动等 Postgres 健康后启动，
  `DATABASE_URL` 在容器内指向 compose 网络内的 postgres，环境变量走 `.env`
- **命令**：`npm run server:up` / `server:down` / `server:logs`（默认 3000 端口，
  可用 `APP_PORT` 覆盖）；本地开发 `infra:up` 仍只起 Postgres，互不干扰
- 修正 agent-server 缺失的 workspace 运行时依赖声明；`tsx` 移入 dependencies
  （生产镜像需要它作为启动器）
- 实测：镜像构建 + 容器启动 + Postgres 会话恢复 + qwen3.8-max 真实对话流
  （chat.token / chat.done）全部通过

## [0.14.5] - 2026-08-19

### 桌面 UI 主题系统（OpenDex use-amplitude 思路）

- **可插拔主题架构**：渲染层重构为主题管理器（`themes.js`），每个主题是
  完整界面，统一接收状态（idle/listening/thinking/speaking/approval）
  与麦克风/播放振幅，运行时切换、localStorage 持久化
- **新增"柔光光晕"主题**：纯 2D Canvas 多层渐变光体（宽柔光 + 核心光体 +
  高光 + 细环 + 音量涟漪），呼吸节奏与振幅实时驱动，状态切换平滑变色，
  不依赖 three.js；原"流光光球"（three.js）保留为默认主题
- **托盘切换**：系统托盘 → 切换主题 → 流光光球 / 柔光光晕，即时生效

## [0.14.4] - 2026-08-19

### 语音委托子代理（OpenDex run_task 模式）

- 语音 S2S 会话新增 `voice.delegate` 工具：语音模型把复杂/多步骤/耗时任务
  （写代码、连续操作、需要仔细推理）交给文本推理代理（qwen3.8-max）执行，
  代理拥有全部工具（含桌面桥：屏幕/终端/文件/编程），完成后只把结果摘要
  回给语音模型播报——语音不再被长工具循环拖垮
- 委托过程中状态/审批/工具进度事件照常推送到桌面 UI（光球可确认 L2 权限），
  简单单步操作仍走直连工具（低延迟）
- 委托上限 20 分钟，超时中止并返回错误摘要，语音回合不会无限等待

## [0.14.3] - 2026-08-19

### 记忆检索升级（OpenClaw 混合检索思路）

- **真实语义嵌入**：长期记忆默认改用百炼 `text-embedding-v4`（1024 维，中文
  语义检索质量远超本地 bigram 哈希）；云接口失败自动回退本地嵌入，不阻断写入
- **维度自动迁移**：pgvector 列维度变化（384→1024）时启动自动重建 embedding
  列并用当前嵌入器重新嵌入存量记忆，记忆数据不丢失
- **关键词兜底**：向量检索命中不足时用查询关键词（CJK 二元组）做 ILIKE/
  包含匹配，避免"明明记过但搜不到"（OpenClaw FTS+向量混合检索的简化版）
- 内存版记忆存储增加向量缓存，云嵌入下不再每次搜索重复调用 API

## [0.14.2] - 2026-08-19

### Computer-use 循环工程 + Agent Core 护栏（参考 OpenDex / OpenClaw）

- **屏幕帧校验与无变化检测**：`screen.analyze` 返回轻量截图签名（frameId），
  `screen.click` 传回 frameId 校验画面未过期（OpenClaw 过期帧语义）；点击后自动
  复查画面，无变化时明确提示"可能未生效"，避免模型反复点击同一位置
- **区域放大分析**：`screen.analyze` 支持 `region` 只分析屏幕局部（小目标先放大），
  坐标相对裁剪区域原点，`screen.click` 传同一 region 自动映射回屏幕坐标
- **任务级权限授权**（OpenDex Allow once）：一次请求内已放行的 L2 工具，后续
  任意参数调用自动执行（覆盖整个多步工具循环），请求结束即清理，不跨请求泄漏
- **工具循环恢复**（OpenClaw）：连续 3 次相同工具调用（同工具同参数）判定为循环，
  拦截执行并结束对话，提示重新评估任务
- **工具结果配对修复**（OpenClaw）：会话历史存在"有 tool_calls 缺 tool result"
  （服务中断残留）时，发送前自动补合成错误结果，避免接口拒绝悬空调用
- AGENTS.md 参考清单新增 OpenDex（仅架构参考）

## [0.14.1] - 2026-08-19

### Agent Core 可靠性（参考项目差距落地）

- **LLM 流式超时 + 重试**：对话与上下文压缩的 LLM 调用新增"无数据超时"
  （默认 90 秒卡死中断）；首个 token 前的瞬时错误（网络失败 / 429 / 5xx /
  超时）自动退避重试最多 2 次，已输出内容后的失败不重试（避免重复流）
- **失败事件化**：LLM 持续失败时不再让 SSE 静默断流——产出 `chat.error`
  事件、把"回复生成失败"写入会话历史，并让光球/聊天窗回到 listening，
  不再卡在"正在思考"
- **工具结果裁剪**：工具返回进入 LLM 上下文前统一截断（>8KB 保留头 4KB +
  尾 1KB 并标注省略），防止单条大输出（如 terminal/filesystem 结果）撑爆
  上下文；`agent.tool_result` 事件仍携带完整结果
- **桌面桥断线自动重连**：desktop-agent 断开后指数退避重连
  （1s→2s→4s…封顶 30s），重连后自动重新注册全部工具；服务端重启后
  不再需要手动重启桌面代理

## [0.14.0] - 2026-08-19

### coding.run 切换 dsh（DeepSeek Harness）后端

- **默认后端改为 dsh**：`coding.run` 现在通过 `dsh --profile headless` 执行
  开发任务（DeepSeek Harness，Agent/工具/模型适配器全部插件化，可扩展性强）；
  模型走百炼 OpenAI 兼容接口（`qwen3.8-max`），沙箱按权限模式生效
- **双后端切换**：环境变量 `CODING_AGENT=claude` 可切回 Claude Code
  （`--resume` 会话续接）；dsh headless 每次调用是全新会话，暂无续接
- **dsh 默认模型切到 DeepSeek 官方 `deepseek-v4-flash`**：密钥走 `DEEPSEEK_API_KEY`
  凭证；百炼 qwen3.8-max（newapi 适配器）保留，可在 profile patch 中一键切回
- **coding.run 改为 L1 自动执行**：不再弹出「需要确认」审批（L2 → L1），
  编码代理内部的终端命令/读写操作直接执行；dsh 仍受 workspace-write 沙箱约束，
  `bypassPermissions` 可完全免沙箱
- **权限映射**：`acceptEdits` → `DSH_PERMISSION_MODE=workspace-write`
  （沙箱限工作区），`bypassPermissions` → `danger-full-access`（完全免确认）；
  dsh 通过 `node` 直连 `bin.js` 启动，避免 .cmd shim 引号问题

## [0.13.0] - 2026-08-19

### 文本推理只保留千问 + 定时任务通知闭环

- **移除 Grok（xAI 直连）**：删除 `GrokProvider` 与全部 `GROK_*` 配置，
  `packages/grok` 更名为 `packages/llm`（保留 LLMProvider 抽象与 OpenAI 兼容
  流式工具）；`LLM_PROVIDER` 现在只有 `dashscope`（默认，qwen3.8-max）与
  `openrouter`（可选替代）两个选项
- **定时任务通知闭环**：`TaskService` 新增 `onRun` 事件订阅（成功/失败均触发），
  新增 `GET /api/events` SSE 推送端点；桌面端常驻订阅，任务执行完/失败时
  立即弹系统通知（含任务名与结果摘要），"每天 9 点查天气→下雨提醒你"
  这类场景现在真正闭环
- **任务会话自愈**：任务专属会话因存储切换/清理而丢失时自动重建
  （`TaskStore.updateTask` 支持更新 `sessionId`），旧任务不再无限失败刷通知
- **提醒投递闭环**：新增 `ReminderService`（10 秒扫描到期提醒），
  `reminder.create` 创建的提醒到点会通过 SSE `reminder.due` 事件推送到桌面端
  弹系统通知——此前提醒只存储、从不触发，是功能缺口
- **文件权限体验对齐**：日常文件操作全部 L1 自动执行（移动/复制/写入/
  新建目录/压缩/解压/删除/打开路径）；`filesystem.delete` 改为删除到
  **回收站**（免确认但可恢复），并拒绝磁盘根目录与系统关键目录
  （Windows / Program Files / ProgramData 等）；`app.launch` 描述明确
  支持打开文件/文件夹/磁盘/URL

## [0.12.0] - 2026-08-19

### Agent Core 稳定性（按参考项目差距分析落地）

- **接入本机 Claude Code 开发**：新增 `coding.run` 工具（L2 确认），
  通过本机 Claude Code headless 模式（`-p --output-format json`）执行开发任务，
  同一目录自动 `--resume` 延续会话；工具/桥接支持每工具超时
  （`timeoutMs`），并修复工具超时只依赖 abort 信号、不响应 abort 时
  会拖到自身超时的问题（改为 Promise.race 真正兜底）
- **文字推理可切千问**：新增 `LLM_PROVIDER=dashscope`（`DASHSCOPE_LLM_MODEL=qwen3.8-max`，
  DashScope OpenAI 兼容接口），文字对话与上下文压缩都走 qwen3.8-max；
  语音仍为 Qwen S2S 端到端
- **会话持久化**：新增 `PostgresSessionStore`（`sessions` 表 + JSONB 消息列），
  Agent Server 重启后会话不丢；桌面端在 localStorage 记住 sessionId，
  重启后自动恢复同一段对话（会话失效时自动新建）
- **上下文压缩**：会话超过 60 条消息时，把早期历史交给 LLM 生成摘要并裁剪
  （保留最近 24 条），提示词不再无限膨胀；压缩失败自动降级为原行为
- **统一 Agent 状态机**：新增 `agent.state` 事件
  （`thinking / awaiting_approval / speaking / listening`），
  光球与聊天窗据此展示真实状态，不再误报"正在等待回复"；
  语音 S2S / 级联 / ElevenLabs 三条路由统一发出
- **工具参数 Schema 校验**：执行前按 `inputSchema` 校验参数
  （必填、类型、enum、范围、嵌套），非法调用快速失败并回传给 LLM 修正
- **审批增强**：L2 工具同参数二次调用自动放行（参数指纹记忆，
  参考 Mastra autoResumeSuspendedTools）；L3（电源/终端）始终要求确认
- **文字聊天窗升级**：支持审批弹条（允许/拒绝）、思考状态、会话恢复
- 光球交互修正：思考/说话中点击光球 = 打断并回到待机

## [0.11.0] - 2026-08-19

### 桌面体验完善

- 托盘 orb 图标：渲染进程 Canvas 绘制发光渐变球体，经 IPC 设为托盘图标
- 窗口状态自适应：idle 缩小为 150x170 小光点并开启鼠标点击穿透，
  唤醒后恢复 460x520 并居中（多显示器 workArea 适配）
- 会话复用：多次唤醒共用同一会话，对话上下文连续
- 播放音量可视化：AI 语音播放时 AnalyserNode 实时驱动 orb 波动，
  reactive audio visualization 完整闭环（说话时 orb 随声音起伏）
- AI 回复文本显示：说话时面板同步显示当前句子
- 错误反馈：Agent Server 未启动时明确提示

## [0.10.0] - 2026-08-19

### Phase 9（第一步）：Windows Desktop Agent

- **远端工具桥**（`/ws/desktop`）：桌面端连接后声明本地工具，
  Agent Loop 通过 WebSocket 桥到桌面本地执行；断线自动卸载工具并拒绝
  挂起请求；工具执行 60s 超时
- **桌面工具集**（`apps/desktop-agent`）：`terminal.run`（L3）、
  `app.launch`（L2）、`filesystem.move/copy`（L1）、`screen.capture`（L0）、
  `window.list`（L0），全部走既有权限确认流
- **Siri 式桌面 UI**（`apps/desktop-ui`，Electron）：
  - 视觉遵循设计提示词：luminous orb / glassmorphism / fluid gradient /
    ambient glow / reactive audio visualization
  - 中央发光球体（多层渐变 + 高斯模糊 + 色相流动）、conic 光晕旋转、
    Canvas 动态粒子、玻璃拟态状态面板
  - 麦克风音量实时驱动 orb 波动与粒子强度（音频响应可视化）
  - 全局热键唤醒（默认 `Ctrl+Alt+Space`）、托盘常驻、点击光球开始对话
  - 完整语音链路：getUserMedia 16k PCM → `/ws/voice` → STT → Grok → TTS
    → 逐句音频播放（新增 `tts.sentence` 事件）
- 测试：桥接注册/执行/超时/断线、桌面工具全链路集成

## [0.9.0] - 2026-08-19

### Phase 8：Task / Scheduler

- `TaskStore`：`tasks` / `task_runs` 表（内存 + Postgres 双实现），
  任务含 cron 调度、自然语言指令、专属会话
- `TaskService`：Node.js 调度器（30 秒 tick，无队列系统），cron 到期检查
  （基于创建时间/上次运行防止重复触发）、无人值守执行、运行记录
- headless 模式：任务执行走完整 Agent Loop，但 L2/L3 工具直接拒绝
  （无人值守不允许需要确认的操作）
- 任务工具：`task.create`（L1，cron 校验）/ `task.list`（L0）/
  `task.delete`（L2，需确认）/ `task.list-runs`（L0）
- 示例：`task.create({schedule:"0 9 * * *", action:"检查杭州天气，如果下雨提醒我"})`
- 测试：cron 到期判断、调度触发、错误记录、headless 拒绝 L2、任务工具

## [0.8.0] - 2026-08-19

### Phase 7：Memory System

- 三层记忆模型：Short-term（会话）+ Episodic（重要事件）+ Semantic（长期事实）
- `MemoryStore` 抽象与两个实现：
  - `InMemoryMemoryStore`：无数据库兜底，本地确定性 embedding 语义检索
  - `PostgresMemoryStore`：PostgreSQL + pgvector（`memories` 表、
    余弦距离 `<=>` 检索），`DATABASE_URL` 不可用时自动降级内存
- 记忆工具：`memory.remember` / `memory.list` / `memory.forget` /
  `memory.edit`——记住/列出/真实删除/修改，Agent 可自主维护长期记忆
- Agent 上下文注入：每轮对话前检索与当前消息最相关的记忆，
  附加为 system prompt（最多 3 条，有冲突时以用户当前说法为准）
- 记忆写入规则（遵循计划）：只保存长期价值信息，不保存闲聊/密钥；
  用户要求"忘记"时永久删除
- `/health` 显示真实版本号与记忆后端（memory / postgres）

## [0.7.0] - 2026-08-19

### Phase 6：权限系统

- 工具权限分级落地：L0 只读无需确认、L1 低风险修改默认执行、
  L2 敏感操作需用户确认、L3 高风险必须二次确认
- `ApprovalRegistry`：会话级 pending 审批（内存），60 秒超时自动拒绝，
  拒绝原因（timeout / session closed / 用户拒绝）回传给 LLM 自我修正
- 审批双通道：
  - SSE：`permission.request` / `permission.response` 事件，
    `POST /api/sessions/:id/permission` 提交决定
  - 语音 WS：`{"type":"permission.response","requestId":...,"approved":...}`
- Agent Loop 挂起/恢复：L2/L3 工具执行前等待确认，
  未批准时工具不执行，拒绝结果作为 ToolResult 回传
- 新增演示工具：`filesystem.delete`（L3，限定工作区、二次确认）、
  `notification.send`（L2，通知内存存储）
- 测试：L2 拒绝/批准、L3 二次确认、超时自动拒绝、敏感工具边界

## [0.6.0] - 2026-08-19

### Phase 5：Agent Core / 工具系统

- LLM tool calling：`grok` / `openrouter` 支持 `tools` 参数，流式累积
  `tool_calls` delta（跨 chunk 拼接 arguments），非流式解析 `message.tool_calls`
- Agent Loop（`ConversationService`）：LLM → 工具调用 → 结果回传 → LLM，
  最多 5 轮；assistant 的 tool_calls 消息原样回传，工具结果按 `toolCallId` 关联
- 消息模型扩展：`tool` 角色、assistant 消息 `toolCalls`、tool 消息 `toolCallId`
- 第一批内置工具（`@personal-ai/tools`）：
  `time.get`（时区）、`weather.get`（Open-Meteo，城市地理编码）、
  `web.search`（维基百科）、`filesystem.search`（限定工作区、glob 通配）、
  `reminder.create/list`、`calendar.create/list`（内存存储，Phase 7 迁数据库）
- 工具执行：15s 超时（区分超时/取消，`AbortController.reason`）、错误捕获后
  作为结果回传 LLM 自我修正、L0/L1 自动执行，L2+ 拒绝（Phase 6 做确认流程）
- 事件：SSE/WS 新增 `agent.tool_call` / `agent.tool_result`；会话历史完整记录
  工具调用链（GET 响应 schema 补齐 toolCalls 字段）
- 新增 `AGENTS.md`：架构参考政策（OpenClaw / Mastra / LiveKit / ElevenLabs SDK
  仅作参考，禁止复制代码与过度工程化）

## [0.5.0] - 2026-08-19

### Phase 4：实时语音 Agent

- 句子级流式 TTS：Grok 回复按 `。！？…` 等边界切句，每句立即合成下发，
  大幅降低首音频延迟（不再等完整回复）
- 用户打断（Barge-in）：
  - TTS 播放期间收到非空 partial transcript 即中断当前任务
  - 客户端可发 `{"type":"interrupt"}` 显式打断
  - 打断后发送 `tts.interrupted`（含原因），已合成的部分回复写入会话历史
- `ElevenLabsTTS` 支持 `AbortSignal`，可随时中止合成（停止说话）
- 并发会话隔离：每个语音 WS 连接独立创建 STT/TTS 客户端，
  修复共享实例导致的多会话串音与 handler 泄漏
- `agent.done` 事件：携带完整回复文本，便于客户端展示/校对
- `splitSentences` 流式句子切分器（含连续标点合并、换行切分）
- 测试：TTS abort、句子切分、partial 打断、客户端 interrupt、每连接独立客户端

## [0.4.0] - 2026-08-19

### Phase 3：ElevenLabs 语音层

- `ElevenLabsTTS`：流式 TTS（MP3 / PCM 输出），支持 `languageCode`（中文清晰输出，
  `eleven_v3` + Sarah 音色）
- `ElevenLabsSTT`：实时 WebSocket STT（`scribe_v2_realtime`），VAD 提交策略、
  部分/最终转写事件、`languageCode` 与 VAD 阈值参数
  - 修复：实时消息的 `text` 位于顶层而非 `data`，此前导致转写恒为空
- `SilenceTurnDetector`：基于 RMS 的静音换轮检测（本地 VAD 备用方案）
- agent-server 新增 `/ws/voice/:sessionId`：STT → Grok（LLM）→ TTS 语音会话闭环，
  统一信封输出 `voice.ready` / `transcript.partial` / `transcript.final` /
  `agent.thinking` / `tts.start` / `audio.chunk` / `tts.end` / `voice.error`
- `npm run voice:smoke`：TTS 生成 → PCM 转 PCM → 实时 STT 回环冒烟测试

## [0.3.0] - 2026-08-19

### Phase 2：Persona 人格系统

- `FilePersonaProvider`：读取 `persona/*.md`（身份/人格/说话风格/行为准则）合成
  System Prompt，每次调用重新读取，人格文件修改即时生效
- `PersonaProvider.getVoiceProfile()` 返回声音档案（来源 `ELEVENLABS_*` 配置，
  Phase 3 语音层使用）
- agent-server 默认 System Prompt 改为由 Persona Loader 提供，会话级
  `systemPrompt` 仍可覆盖
- 测试：`FilePersonaProvider` 单元测试（合成/缺失文件/默认音色/热更新）+ 会话集成测试

## [0.2.0] - 2026-08-18

### LLM Provider 可切换

- 新增 `@personal-ai/openrouter`：OpenRouterProvider（流式 SSE、用量统计、错误处理）
- 抽出 OpenAI 兼容流式解析助手（`iterSsePayloads` / `parseChatCompletionStreamData`），
  Grok 与 OpenRouter 共用
- `LLM_PROVIDER` 环境变量选择大脑：`grok`（直连 xAI）或 `openrouter`
- `.env.example` / README 增加 OpenRouter 配置说明

## [0.1.0] - 2026-08-18

### Phase 0：项目骨架

- 建立 npm workspaces Monorepo（packages / services）
- TypeScript 严格模式 + 统一 tsconfig
- ESLint（typescript-eslint）+ Prettier 配置
- Vitest 测试框架
- 环境变量统一管理（`@personal-ai/config` + `.env.example`）
- Docker Compose：PostgreSQL 16 + pgvector 扩展
- Persona 目录与初始人格定义
- 架构文档 `docs/architecture.md`

### Phase 1：Grok 文本 Agent MVP

- `@personal-ai/types`：Session / ChatMessage 等共享类型
- `@personal-ai/protocol`：统一消息信封与事件名
- `@personal-ai/grok`：LLMProvider 抽象 + GrokProvider（SSE 流式）
- `@personal-ai/memory`：SessionStore 抽象 + 内存实现
- `@personal-ai/tools`：Tool 接口与注册表（为 Phase 5 预留）
- `@personal-ai/elevenlabs`：STT/TTS 抽象（为 Phase 3 预留）
- Agent Server：创建 Session、流式对话、SSE 协议、错误处理、请求/用量日志
