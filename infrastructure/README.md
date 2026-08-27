# 部署与运维说明

## 生产环境配置

本项目在腾讯云轻量服务器上运行，使用 Docker Compose 编排。

### 安全加固措施

1. **Docker 套接字隔离**
   - 容器内 **不挂载** `/var/run/docker.sock`
   - 容器内 agent 无法启动新容器或映射端口
   - 降低容器逃逸与横向移动风险

2. **SSH 密钥最小权限**
   - **不挂载** 宿主机全部 `~/.ssh` 目录
   - 如需 git push SSH 认证，仅挂载指定部署密钥（如 `/home/ubuntu/.ssh/promise-ai-deploy`）
   - 当前配置优先使用 GitHub App / token 认证（通过 `.env` 注入），无需 SSH 挂载

3. **端口绑定**
   - Postgres: `127.0.0.1:5432`（仅本机）
   - Agent Server: `127.0.0.1:3000`（仅本机）
   - Weixin Bridge: `127.0.0.1:3100`（仅本机）
   - 仅 80 端口（team-site-proxy）暴露公网

4. **密钥管理**
   - 所有密钥通过 `.env` 注入（已被 `.gitignore` 排除）
   - **禁止提交** 任何 `.env` 文件或真实密钥到仓库
   - **生产运维警告**：不要在服务器上保留 `.env.bak` 等备份文件（易泄露且无版本控制）

### 网络架构

```
公网 :80 → team-site-proxy (socat) → app:80 (nginx)
         ↓
     app:3000 (agent-server) ← weixin-bridge:3100
         ↓
     postgres:5432
```

- SSH 端口 22 已配置 key-only 认证（已关闭密码登录）
- 其他服务均监听 localhost，不暴露公网

### HTTPS / TLS

当前配置 **不启用 HTTPS**：

- 运营商域名仍在 ICP 备案流程中，暂无法启用 HTTPS
- 未来若需启用，使用 Let's Encrypt + Caddy/nginx，但当前阶段跳过

### Git Push 认证配置

#### 方案一：GitHub Token（推荐）

在 `.env` 中配置 GitHub Personal Access Token 或 GitHub App：

```bash
GITHUB_TOKEN=ghp_xxxxxxxxxxxxx
```

容器内 git 使用 HTTPS + token 认证，无需 SSH。

#### 方案二：SSH 部署密钥

1. 生成专用部署密钥（read-write）：

   ```bash
   ssh-keygen -t ed25519 -C "promise-ai-deploy" -f ~/.ssh/promise-ai-deploy
   ```

2. 将公钥添加到 GitHub 仓库 Deploy Keys（勾选 "Allow write access"）

3. 修改 `docker-compose.yml` app 服务挂载：

   ```yaml
   volumes:
     - /home/ubuntu/.ssh/promise-ai-deploy:/root/.ssh/id_ed25519:ro
   ```

4. 容器内配置 git 使用该 key：

   ```bash
   # 在容器内或 entrypoint 脚本中
   git config --global core.sshCommand "ssh -i /root/.ssh/id_ed25519"
   ```

### 启动与重启

```bash
# 启动所有服务
cd /home/ubuntu/promise-ai/infrastructure
sudo docker compose --profile server up -d

# 查看日志
sudo docker compose logs -f app
sudo docker compose logs -f weixin-bridge

# 重启特定服务
sudo docker compose restart app
sudo docker compose restart weixin-bridge

# 停止所有服务
sudo docker compose --profile server down
```

### 健康检查

所有服务已配置健康检查：

```bash
# 查看服务状态
sudo docker compose ps

# 检查 agent-server
curl -fsS http://127.0.0.1:3000/health

# 检查 weixin-bridge
curl -fsS http://127.0.0.1:3100/health

# 检查 postgres
sudo docker compose exec postgres pg_isready -U assistant
```

### 日志与监控

日志位置：

- Agent Server: `docker compose logs app`
- Weixin Bridge: `docker compose logs weixin-bridge`
- Postgres: `docker compose logs postgres`
- Nginx (team-site): `/app/.deploy/nginx-run/logs/`

### 数据备份

持久化卷：

- `postgres-data`：Postgres 数据库
- `weixin-data`：微信会话状态
- `app_node_modules` / `bridge_node_modules`：依赖缓存

备份命令参考 [`docs/backup-restore.md`](../docs/backup-restore.md)。

### 故障排查

1. **容器无法启动**
   - 检查 `.env` 文件是否存在
   - 检查端口占用：`sudo netstat -tlnp | grep -E ':(80|3000|3100|5432)'`
   - 查看容器日志：`sudo docker compose logs <service>`

2. **git push 失败**
   - 确认 GitHub token 或 SSH key 配置正确
   - 容器内测试：`sudo docker compose exec app git push origin main`
   - 检查网络：`sudo docker compose exec app ping github.com`

3. **微信消息无响应**
   - 检查 weixin-bridge 日志
   - 确认 agent-server 健康：`curl http://127.0.0.1:3000/health`
   - 检查网络连通性：weixin-bridge → app

---

© 2026 Promise AI · 运维文档由小优维护
