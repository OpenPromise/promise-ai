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
  # 剔除"git 历史中已删除、容器里却残留"的陈旧文件，防止旧镜像文件被复活
  for f in $(git diff --cached --name-only --diff-filter=A); do
    if ! git cat-file -e "HEAD:$f" 2>/dev/null && git log --all --oneline -- "$f" | grep -q .; then
      git rm --cached --quiet "$f" 2>/dev/null || true
      rm -f "$f" 2>/dev/null || true
      echo "[sync] 剔除陈旧文件: $f"
    fi
  done
  git -c user.email="$GIT_EMAIL" -c user.name="$GIT_USER" commit -q -m "sync: 服务器 bot 改动 $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "[sync] 已提交：$(git rev-parse --short HEAD)"
  echo "[sync] 改动文件："
  git show --stat --oneline HEAD | head -30
  # 推送到 GitHub（部署 key，read-write），bot 改动永久保留在远程
  if git remote | grep -q '^origin$'; then
    if git push origin main 2>&1 | tail -2; then
      echo "[sync] 已推送到 GitHub（origin/main）"
    else
      echo "[sync] 推送失败，可稍后手动执行：git push origin main"
    fi
  fi
else
  echo "[sync] 无改动"
fi

sudo chown -R ubuntu:ubuntu "$REPO" || true
