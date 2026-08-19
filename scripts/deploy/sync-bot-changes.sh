#!/usr/bin/env bash
# 服务器端：把容器 /app 里 bot 自我开发产生的改动同步到宿主机仓库并提交。
# 幂等：无改动时不产生新提交。之后可用 pull-bot-changes.ps1 拉回本地。
set -euo pipefail

REPO=/home/ubuntu/promise-ai
GIT_USER="Promise AI Bot"
GIT_EMAIL="bot@promise-ai.local"

cd "$REPO"

if [ ! -d .git ]; then
  echo "[sync] 初始化服务器 git 仓库..."
  git init -q
  git config user.email "$GIT_EMAIL"
  git config user.name "$GIT_USER"
  if [ ! -f .gitignore ]; then
    cat > .gitignore <<'EOF'
node_modules/
dist/
coverage/
.env
.env.*
!.env.example
*.log
*.tsbuildinfo
weixin-files/
EOF
  fi
  git add -A
  git -c user.email="$GIT_EMAIL" -c user.name="$GIT_USER" commit -q -m "chore: 服务器基线（部署快照）" || true
  echo "[sync] 基线已提交"
fi

# 容器 /app（含 bot 自我开发改动）同步到宿主机仓库，排除 node_modules
echo "[sync] 同步容器 /app 到 $REPO ..."
sudo docker exec assistant-app tar -C /app --exclude=node_modules -cf - . | tar -C "$REPO" -xf -

if ! git diff --quiet; then
  git add -A
  git -c user.email="$GIT_EMAIL" -c user.name="$GIT_USER" commit -q -m "sync: 服务器 bot 改动 $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[sync] 已提交：$(git rev-parse --short HEAD)"
  echo "[sync] 改动文件："
  git show --stat --oneline HEAD | head -30
else
  echo "[sync] 无改动"
fi

sudo chown -R ubuntu:ubuntu "$REPO" || true
