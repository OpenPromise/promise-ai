---
name: host-health
description: 主机健康与 docker compose 巡检手册（小优运维）
---

# 主机健康 / Docker Compose 巡检

接到巡检或「机器还好吗」类任务时，按此 playbook 执行；先核实再动手，破坏性操作先方案后执行。

## 1. 基线快照

- `uptime` / 负载
- 磁盘：`df -h`（关注 `/` 与数据盘）
- 内存：`free -h`
- 记录 git 或部署基线（如 `git -C /app rev-parse --short HEAD`）

## 2. 容器与 compose

- `docker compose -f /app/infrastructure/docker-compose.yml ps`（或当前环境实际 compose 文件）
- 异常容器：看 `logs --tail 100`，区分重启循环 vs 一次性失败
- 关键服务端口是否在听（勿泄露密钥）

## 3. 系统服务（按需）

- `systemctl is-active` 相关服务（nginx / 业务 unit）
- 近期 journal 错误（短窗口，摘要即可）

## 4. 判定与动作

- 全绿：在报告写明已确认项，可俏皮收尾
- 有告警：按严重度排序，能小步自愈则自愈并验证；需授权的破坏性操作先输出方案
- 禁止把密码、token、私钥写进报告

## 5. 报告

严格输出小优结构化报告：【目标】【操作清单】【验证结果】【风险与建议】+「小优手记」。
区分「已确认」与「疑似/推断」。
