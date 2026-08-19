#!/bin/sh
set -e

# 把 DEEPSEEK_API_KEY 写入 dsh 凭证文件（dsh 通过 $DSH_HOME/.credentials.yaml 读取）
if [ -n "${DEEPSEEK_API_KEY:-}" ]; then
  mkdir -p "$DSH_HOME"
  printf 'DEEPSEEK_API_KEY: %s\n' "$DEEPSEEK_API_KEY" > "$DSH_HOME/.credentials.yaml"
  chmod 600 "$DSH_HOME/.credentials.yaml"
fi

exec "$@"
