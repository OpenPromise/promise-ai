#!/usr/bin/env bash
# ============================================================
# 世界第一 AI 工作室官网 · 一键启动脚本（Phase 4 部署，幂等可重复执行）
#
# 用法：bash /app/team-site/start.sh
# 组成：
#   1. 后端  Node/Express 内容 API → 127.0.0.1:8080（nohup，日志 backend/server.log）
#   2. 前端  dist 已存在则跳过构建（缺失时才 npm install + build）
#   3. nginx 静态托管 frontend/dist + /api 反代 → 容器内 80
#
# nginx 说明：本环境（Ubuntu 容器）沙箱无法写系统目录（/etc /usr /var），
#   apt 系统安装不可行，故采用官方 Ubuntu deb（nginx_1.24.0）解包到
#   /app/.deploy/nginx-root/ 运行。运行时配置由本脚本从 nginx/nginx.conf 生成
#   （仅替换 mime.types 绝对路径 + pid/日志/临时目录重定向到运行时前缀），
#   仓库内 nginx.conf 保持标准系统安装原样。
#
# 恢复：若 nginx 二进制缺失，按如下命令重新准备（重定向 apt 缓存到 /app）：
#   mkdir -p /app/.deploy/apt-cache/archives /app/.deploy/apt-lists/partial
#   apt-get -o Dir::Cache=/app/.deploy/apt-cache -o Dir::State::lists=/app/.deploy/apt-lists \
#           -o Dir::Etc::sourcelist=/etc/apt/sources.list.d/ubuntu.sources update
#   cd /app/.deploy/debs && apt-get -o Dir::Cache=... -o Dir::State::lists=... \
#           -o Dir::Etc::sourcelist=... download nginx nginx-common
#   dpkg -x nginx-common_*.deb /app/.deploy/nginx-root/ && dpkg -x nginx_*.deb /app/.deploy/nginx-root/
# ============================================================
set -u

ROOT=/app/team-site
NGINX_BIN=/app/.deploy/nginx-root/usr/sbin/nginx
NGINX_RUN=/app/.deploy/nginx-run
BACKEND_PORT=8080

echo "[start.sh] team-site 官网启动（幂等）"

# ---------- 1. 后端（已下线） ----------
# 官网改为纯静态后不再启动 Express :8080。残留进程在此收口，避免重启后复活。
if pgrep -f '^node src/server\.js$' >/dev/null 2>&1; then
  echo "[start.sh] 发现遗留内容 API，正在停止"
  pkill -f '^node src/server\.js$' || true
  sleep 0.4
fi
echo "[start.sh] 跳过内容 API（静态站不需要 8080）"

# ---------- 2. 前端构建（dist 缺失时才构建） ----------
if [ ! -f "$ROOT/frontend/dist/index.html" ]; then
  echo "[start.sh] 构建前端 dist..."
  (cd "$ROOT/frontend" && NODE_ENV=development npm install >/dev/null 2>&1 \
    && NODE_ENV=production npm run build >/dev/null 2>&1) \
    || { echo "[start.sh] 前端构建失败"; exit 1; }
  echo "[start.sh] 前端构建完成"
else
  echo "[start.sh] 前端 dist 已存在，跳过构建"
fi

# ---------- 3. nginx ----------
if [ ! -x "$NGINX_BIN" ]; then
  echo "[start.sh] 错误：nginx 二进制缺失（$NGINX_BIN）"
  echo "[start.sh] 请按脚本头部注释的恢复步骤重新准备，或系统安装 nginx"
  exit 1
fi

mkdir -p "$NGINX_RUN/conf" "$NGINX_RUN/logs"
# 从仓库配置生成运行时配置：mime.types 指向解包路径；pid/日志/临时目录落到运行时前缀
sed -e 's|/etc/nginx/mime.types|/app/.deploy/nginx-root/etc/nginx/mime.types|' \
    -e '/^worker_processes auto;/a pid logs/nginx.pid;\nerror_log logs/error.log;' \
    -e '/^http {/a\    access_log logs/access.log;\n    client_body_temp_path logs/client_body;\n    proxy_temp_path logs/proxy;\n    fastcgi_temp_path logs/fastcgi;\n    uwsgi_temp_path logs/uwsgi;\n    scgi_temp_path logs/scgi;' \
    "$ROOT/nginx/nginx.conf" > "$NGINX_RUN/conf/nginx.conf"

if "$NGINX_BIN" -p "$NGINX_RUN" -c conf/nginx.conf -t >/dev/null 2>&1; then
  echo "[start.sh] nginx 配置校验通过"
else
  echo "[start.sh] nginx 配置校验失败，中止"; exit 1
fi

if [ -f "$NGINX_RUN/logs/nginx.pid" ] && kill -0 "$(cat "$NGINX_RUN/logs/nginx.pid")" 2>/dev/null; then
  echo "[start.sh] nginx 已在运行（PID=$(cat "$NGINX_RUN/logs/nginx.pid")），跳过启动"
else
  "$NGINX_BIN" -p "$NGINX_RUN" -c conf/nginx.conf || { echo "[start.sh] nginx 启动失败"; exit 1; }
  sleep 0.5
  echo "[start.sh] nginx 已启动（PID=$(cat "$NGINX_RUN/logs/nginx.pid")，日志 ${NGINX_RUN}/logs/）"
fi

echo "[start.sh] 完成：容器内 http://localhost/ 可访问"
echo "[start.sh] 注意：宿主机需把 80 端口映射到本容器、云安全组放行 TCP 80，公网才能访问"
