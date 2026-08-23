# Promise AI 项目全面审计报告（第五轮）

> 审计人：Claude Fable 5（CEO 直接派单）
> 审计日期：2026-08-24 凌晨
> 基线：`main` @ `2628c32`（fix: 视频与场景图改带版本文件名，穿透 /assets 7 天缓存）
> 性质：**只审计，不修改**（本轮审计过程中未改动任何代码与配置）
> 范围：代码 + 系统 + 安全 + 运维 + 官网，覆盖服务器 122.152.209.182 全机

---

## 0. 总体评价

| 维度 | 评分 | 一句话结论 |
| --- | --- | --- |
| 代码质量 | ★★★★★ | 18,000 行源码配 12,300 行测试，TODO/FIXME 为零，工程纪律罕见地好 |
| 测试基线 | ★★★★☆ | 533 个测试 532 通过；唯一失败是一个陈旧断言（见 §3.2），非功能缺陷 |
| 架构设计 | ★★★★☆ | Agent → ToolRouter → Tool 链路清晰，delegate 子代理模式可复制性强 |
| 安全 | ★★☆☆☆ | **本轮最大短板**：SSH 密码认证 + root 登录开启 + 无 fail2ban，公网 22 端口裸奔 |
| 运维 | ★★★☆☆ | 备份在跑、容器全绿，但磁盘 81%（元凶：22GB Docker 构建缓存）、备份无异地副本 |
| 文档与传承 | ★★★★★ | AGENTS.md 纪律、characters 自写传统、learnings 沉淀、四轮审计——文化是这个项目最强的资产 |

**一句话总评**：这是一个代码质量远超个人项目平均水平的系统，当前真正的风险不在代码里，而在**服务器安全配置**和**单机单盘的数据容灾**上。

---

## 1. 审计范围与方法

- **代码**：monorepo 全量（packages/ 9 包 + services/ 2 服务 + team-site），源码约 17,960 行、测试约 12,316 行（另有少量 root 属主文件未计入统计）
- **质量基线**：容器内实跑 `npm run typecheck`（通过）与 `npm test`（59 个文件 533 用例）
- **系统**：端口暴露、sshd 配置、ufw 规则、fail2ban、cron/systemd 定时器、磁盘/内存/容器资源
- **运维**：备份机制与产物、git 远端与推送状态、部署拓扑、遗留服务
- **对照**：已阅读第四轮审计（claude-code-audit-v4.md）的豁免清单，本轮沿用其"有意设计不列为缺陷"的原则

---

## 2. 项目全景

### 2.1 系统架构（当前运行态）

```
微信 ClawBot ⇄ assistant-weixin (:3100, 仅本机)
                  ⇄ assistant-app (:3000, 仅本机)
                       ├─ Agent 核心：会话/工具/权限/记忆/调度
                       ├─ delegate 子代理 ×5（dsh 底盘 + 人格注入）
                       └─ 容器内 nginx :80 ← team-site-proxy(socat) ← 公网 :80
                  ⇄ assistant-postgres (:5432, 仅本机, pgvector)
```

- LLM：DeepSeek v4-flash（主）+ OpenRouter fallback；Qwen 负责 ASR 与记忆嵌入
- 全权限模式 `AUTO_APPROVE_ALL=true`（第四轮审计已列为设计豁免）
- 部署：宿主 `~/promise-ai` bind mount 进容器 `/app`，改源码 + 重启容器即生效

### 2.2 AI 团队（1 人类 + 6 AI）

| 成员 | 职务 | 派单入口 | 模式 | 权限 |
| --- | --- | --- | --- | --- |
| 小夜 | 私人助理/中枢 | （主会话） | — | 与用户同级 |
| 小黑 | 工程师 | engineer.delegate | 异步（taskId+事件） | L1 |
| 小优 | 运维 | ops.delegate | 同步 danger-full-access | L1 |
| 小美 | 设计师 | designer.delegate | 同步 workspace-write，独立 OpenAI 路由 | L1 |
| 小真 | QA（08-24 入职） | qa.delegate | 同步 workspace-write | L1 |
| 小知 | 研究员（08-24 入职） | research.delegate | 同步 workspace-write | L1 |

新入职两人已通过 typecheck + 9 个单元测试，容器重启后注册成功。

---

## 3. 质量基线（实测）

### 3.1 通过项

- `npm run typecheck`：**通过，零错误**
- `npm test`：59 个测试文件，**532/533 通过**，全程 9.76s
- TODO / FIXME / HACK 计数：**0**（工程卫生极佳）

### 3.2 唯一失败的测试（陈旧断言，非本轮引入）

`services/agent-server/src/services/designer-tools.test.ts:103` 断言小美模型为
`'gpt-4.1'`，而代码默认值已升级为 `gpt-5.6-sol`（`XIAO_MEI_OPENAI_MODEL`）。
**属于测试跟随代码升级时漏改**，一行修复：断言改为引用 `XIAO_MEI_OPENAI_MODEL`
常量而非硬编码字符串（顺带根治此类漂移）。建议派给小黑，小真验收。

---

## 4. 安全审计

### 4.1 高危（建议 24 小时内处理）

| # | 发现 | 证据 | 后果 | 建议 |
| --- | --- | --- | --- | --- |
| S1 | **SSH 密码认证开启 + 允许 root 登录 + fail2ban 未运行** | `sshd -T`: passwordauthentication yes / permitrootlogin yes；fail2ban inactive；22 端口对全网开放 | 公网口令爆破面完全敞开；现用密码强度一般且曾以明文传输过 | 密钥登录已配好——关闭密码认证（`PasswordAuthentication no`）、`PermitRootLogin prohibit-password`，可选装 fail2ban |
| S2 | **明文密钥备份文件全局可读** | `.env.bak-20260822` 权限 `664`，含 11 行 KEY/TOKEN | 任何本机进程/用户可读走全部第三方密钥（.env 本体是 600，无此问题） | `chmod 600` 或直接删除；密钥应只活在 .env |
| S3 | **聊天中明文传输过的凭据未轮换** | 服务器密码、MiniMax key、火山 Ark key 均出现在对话里 | 一旦聊天记录泄露即全部失守 | 轮换服务器密码与两个 API key |

### 4.2 中危（一周内处理）

| # | 发现 | 证据 | 说明 |
| --- | --- | --- | --- |
| S4 | **UFW 管不住 Docker 发布的端口** | ufw 只放行 22/3000，但公网 80 照常可达（docker-proxy 的 iptables 规则先于 ufw） | 当前 80 是官网、属预期；但**未来任何容器 `-p 0.0.0.0:x` 都会绕过防火墙**，需知晓此陷阱 |
| S5 | ufw 的 3000/tcp 放行规则已陈旧 | 3000 实际只绑 127.0.0.1，规则无效但具误导性 | 删除该规则，防止未来误绑 0.0.0.0 时"恰好"被放行 |
| S6 | **docker.sock + docker CLI + ~/.ssh 挂载进 assistant-app** | Mounts: `/var/run/docker.sock`(rw)、`/usr/bin/docker`、`~/.ssh → /root/.ssh`(ro) | 容器内 Agent 等效 root（可控整个宿主机）且可读 SSH 私钥。与"全权限模式"哲学一致，**列为知情豁免**，但应明确：任何 prompt 注入攻击的爆炸半径是整台服务器 |

### 4.3 已确认良好的安全实践

- `.env` 权限 600；`.gitignore` 覆盖 .env/数据目录/部署产物
- 3000/3100/5432 全部只绑 127.0.0.1，公网仅暴露 22/80
- 微信通道 L2/L3 文字审批、weixin.* 工具 ≤L1 有测试强制
- 派单审计日志（JSON Lines）留痕可回放

---

## 5. 运维审计

### 5.1 磁盘：81%，元凶是 Docker 构建缓存

```
/dev/vda2  40G 已用31G 余7.3G (81%)
Docker Build Cache: 22.49GB，其中 22.32GB 可回收   ← 全盘最大可回收项
Docker Images:      2.58GB，其中 0.64GB 可回收
```

一条命令可释放约 22GB（降到 ~55%）：`docker builder prune -af`。
次要清理项：`~/promise-ai-deploy*.tar.gz` ×21（约 9MB，历史部署包）、`~/NUL`（2MB 垃圾文件）、`~/backups/frontend-taskroom-backup-20260824.tar.gz`（82MB，确认新官网稳定后可删）。

### 5.2 备份与容灾

- **PostgreSQL 备份正常**：每日 19:30 UTC 执行（日志三天连续 ok），custom 格式，保留 15 份，当前 4 份
- **风险：所有备份和本体在同一块盘**——磁盘故障 = 记忆/会话/审计全灭
- **git 远端存在**（github.com:OpenPromise/promise-ai）但**有 3 个本地提交未推送**（今天的官网重设计、招新、缓存修复）；服务器一旦损坏，今天的全部工作只剩本地 e:\promise_fable5 一份副本
- 建议：推送 git；给 postgres 备份加一条异地上传（对象存储或 scp 到本地机器）

### 5.3 服务与资源

- 4 容器全部 healthy；内存合计约 314MB / 3.6GB，负载 0.01，资源非常宽裕
- **遗留服务**：team-site 旧 Express 后端仍在容器内监听（nginx /api 反代返回 200），但新官网已纯静态、不再调用 /api——建议择机下线该进程与 nginx /api 配置块，减一个暴露面
- **文件属主混乱**：repo 内约 15 个源码文件属主为 root（ops-tools.ts、designer-tools.ts 等，系容器内以 root 写入所致），导致 ubuntu 用户 grep/wc 报 Permission denied，也让 git 操作偶发权限问题。建议 `chown -R ubuntu:ubuntu ~/promise-ai`

### 5.4 备份调度出处待确认

crontab 与 systemd timer 中均未找到 postgres 备份的调度项，但日志显示每日准点执行——推测由小夜的任务调度器（TaskService）触发。建议在 README 或 ops 文档中**显式记录该调度的归属**，避免未来"没人知道它为什么在跑/为什么停了"。

---

## 6. 代码与工程实践（正面清单）

- **测试文化**：测试代码量达源码的 69%，含权限约束类"制度测试"（如 weixin.* ≤L1）
- **AGENTS.md 纪律**：参考项目白名单 + 禁止过度工程化 + 新工具必须声明权限等级，且实际被遵守
- **delegate 模式**：五个子代理共享同一底盘（runDshHeadless + 人格注入 + 结构化报告契约），新增成员的边际成本已降到"一个文件 + 两行注册"——本轮小真/小知入职实测约半小时
- **经验沉淀**：learnings.md、CHANGELOG、审计传统（本文档是第五轮）形成闭环
- **配置卫生**：环境变量统一走 @personal-ai/config，启动日志打印关键开关，/health 暴露运行态

---

## 7. 官网与素材（08-24 改版后状态）

- 纯静态 React 18 + Vite 6，构建产物 157KB JS + 9KB CSS，素材 webp 化后全站首屏约 1.5MB + 2.2MB 视频
- 素材链路可复现：提示词/生成脚本/参数全部入库（team-site/docs/redesign-fable5/）
- 已修复的坑并值得沉淀：**public/ 下同名素材更新会被 nginx 7 天缓存吞掉**，必须改文件名（构建产物自带 hash 无此问题）
- 成员立绘 7 张齐全；小真/小知个人主页尚未建立（按传统留给本人）

---

## 8. 行动清单（按优先级）

| 优先级 | 事项 | 一句话方案 | 建议派单 |
| --- | --- | --- | --- |
| P0 | 关闭 SSH 密码认证与 root 登录 | sshd_config 两行 + `systemctl reload sshd`（密钥已验证可用） | 小优 |
| P0 | 轮换泄露过的凭据 | 服务器密码 + MiniMax/Ark key 各家控制台重置 | CEO 本人 |
| P0 | 推送 3 个未推送提交 | `git push origin main` | 小优 |
| P1 | 回收 Docker 构建缓存 22GB | `docker builder prune -af`（磁盘 81%→约 55%） | 小优 |
| P1 | 删除/收权 .env.bak | `chmod 600` 或删除 | 小优 |
| P1 | 修陈旧测试断言 | designer-tools.test.ts 引用常量替代硬编码 | 小黑（小真验收） |
| P2 | postgres 备份异地化 | 每日 dump 后上传对象存储/scp 外机 | 小优 |
| P2 | repo 文件属主归一 | `chown -R ubuntu:ubuntu ~/promise-ai` | 小优 |
| P2 | 下线 team-site 旧后端与 /api 反代 | 新官网已不依赖；减暴露面 | 小黑+小优 |
| P3 | 清理 home 目录历史部署包与 NUL | 21 个 tar.gz + NUL 约 11MB | 小优 |
| P3 | 记录备份调度归属 | 在 ops 文档写明由谁调度、如何检查 | 小知（调研）+小优 |
| P3 | 小真/小知自写人格与主页 | 沿袭"本人自写"传统 | 小真、小知 |

---

## 9. 与前四轮审计的关系

前四轮（claude-code-audit ~ v4）聚焦**代码与 Agent 行为正确性**，其豁免清单本轮全部沿用且未发现回退。本轮首次将审计范围扩展到**服务器安全与运维容灾**——结论是：代码侧的债务已经很少，下一阶段的主要风险敞口在基础设施层。建议下一轮（第六轮）审计在 P0/P1 整改完成后进行，重点复核 SSH 加固效果与备份异地化落地。

---

*本报告由 Fable5 于 2026-08-24 生成；所有数据均为服务器实测，命令与输出可复核。*


---

## 10. 整改记录（2026-08-24 同日）

由 Fable5 按本报告行动清单执行。API 密钥轮换仍需 CEO 在各家控制台完成。

| 事项 | 状态 | 实测结果 |
| --- | --- | --- |
| 关闭 SSH 密码认证 | 已完成 | `/etc/ssh/sshd_config.d/00-harden.conf`；`sshd -T` 为 `passwordauthentication no` / `permitrootlogin without-password`；密钥登录复测通过 |
| 轮换泄露凭据 | 待 CEO | SSH 密码登录已关，泄露的服务器密码对 SSH 失效；MiniMax / 火山 Ark key 仍需控制台重置 |
| 推送未推送提交 | 进行中 | 见本提交之后的 `git push` |
| Docker 构建缓存 | 已完成 | 回收约 22GB；根分区 81% → **26%**（余 28G） |
| `.env.bak` 收权 | 已完成 | `chmod 600` |
| 陈旧测试断言 | 已完成 | 测试改为引用 `XIAO_MEI_OPENAI_MODEL`；designer/qa/research 共 17 测通过 |
| repo 属主归一 | 已完成 | `chown -R ubuntu:ubuntu ~/promise-ai` |
| 清理历史部署包 | 已完成 | `~/promise-ai-deploy*.tar.gz` 与 `~/NUL` 已删 |
| UFW 陈旧 3000 规则 | 已完成 | 仅保留 22/tcp |
| 备份调度归属 | 已完成 | 已写入 `docs/backup-restore.md` §1.1：root cron `30 3 * * *` |
| fail2ban | 已完成 | 已安装并启用，sshd jail 在跑 |
