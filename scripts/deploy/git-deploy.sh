#!/usr/bin/env bash
# 从 GitHub 主线精确部署：先同步 bot 改动，再 reset+clean 工作区，最后构建。
# 相比 tar 部署，杜绝旧文件残留进镜像（如已删除的 silk.ts 复活问题）。
set -euo pipefail

REPO=/home/ubuntu/promise-ai
cd "$REPO"

# 1) 先同步并推送 bot 改动（无改动/推送成功才继续，避免 reset 丢改动）
SYNC_OUTPUT=$(bash scripts/deploy/sync-bot-changes.sh 2>&1)
echo "$SYNC_OUTPUT"
if echo "$SYNC_OUTPUT" | grep -q "推送失败"; then
  echo "[deploy] bot 改动推送失败，中止部署（避免丢失改动）"
  exit 1
fi

# 2) 从 GitHub 拉取最新主线并精确还原工作区（清理未跟踪残留）
git fetch origin
git reset --hard origin/main
git clean -fd

# 3) 构建并启动
sudo docker compose -f infrastructure/docker-compose.yml --profile server up -d --build
echo "[deploy] 部署完成"
