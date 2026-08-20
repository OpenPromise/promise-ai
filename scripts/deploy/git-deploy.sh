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

# 记录部署前 HEAD：用于判断本次是否发生依赖变更
PREV_HEAD=$(git rev-parse HEAD)

# 2) 从 GitHub 拉取最新主线并精确还原工作区（清理未跟踪残留）
git fetch origin
git reset --hard origin/main
git clean -fd

# 3) 构建并启动
sudo docker compose -f infrastructure/docker-compose.yml --profile server up -d --build

# 依赖变更时同步 node_modules 命名卷：镜像重建不会覆盖运行时卷，
# 新依赖必须重新 npm ci 进卷，否则容器启动即 ERR_MODULE_NOT_FOUND。
if git diff --name-only "$PREV_HEAD" HEAD | grep -qE '(^|/)package(-lock)?\.json$'; then
  echo "[deploy] 检测到依赖变更，同步 node_modules 命名卷…"
  sudo docker compose -f infrastructure/docker-compose.yml --profile server run --rm --no-deps app npm ci --omit=dev
  sudo docker compose -f infrastructure/docker-compose.yml --profile server run --rm --no-deps weixin-bridge npm ci --omit=dev
fi

# 源码以 bind mount 方式运行，拉取新代码后重启即可生效
sudo docker compose -f infrastructure/docker-compose.yml --profile server restart app weixin-bridge
echo "[deploy] 部署完成"
