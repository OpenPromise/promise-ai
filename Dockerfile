# syntax=docker/dockerfile:1
#
# 服务端镜像（Ubuntu 24.04 + Node 24）：
# 只打包 agent-server（Fastify + Qwen 语音/文本 + 任务/提醒 + Postgres）。
# 桌面端（desktop-ui / desktop-agent）是 Windows 本地客户端，不进入服务端镜像。

FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_MAJOR=24 \
    NODE_ENV=production \
    DSH_HOME=/root/.dsh \
    CODING_AGENT=dsh

# 安装 Node 24（NodeSource 官方源）+ curl（健康检查用）
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
    && curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && npm install -g npm@11 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先复制清单与 workspace 目录，充分利用镜像层缓存
COPY package.json package-lock.json ./
COPY packages ./packages
COPY services ./services
COPY apps ./apps
COPY persona ./persona
# coding.run（dsh）读取的仓库规则
COPY AGENTS.md ./

# 只装生产依赖（跳过 electron / esbuild / vitest 等构建与测试依赖）
RUN npm ci --omit=dev

# coding.run 后端：dsh（DeepSeek Harness）+ pnpm；构建期引导 headless profile
# 并固定默认模型 deepseek-v4-flash（密钥由入口脚本从环境变量写入凭证文件）
RUN npm install -g pnpm \
    && npm install -g @deepseek-ai/dsh \
    && dsh --profile headless --help >/dev/null 2>&1 \
    && printf -- '- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: deepseek-v4-flash\n' \
       > "$DSH_HOME/profiles/headless/cordis.patch.yml"

COPY infrastructure/docker-entrypoint.sh /app/infrastructure/docker-entrypoint.sh
RUN chmod +x /app/infrastructure/docker-entrypoint.sh

EXPOSE 3000

# 健康检查：/health 返回 200
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:3000/health >/dev/null || exit 1

ENTRYPOINT ["/app/infrastructure/docker-entrypoint.sh"]
CMD ["npm", "start"]
