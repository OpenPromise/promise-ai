#!/usr/bin/env bash
# 腾讯云/国内网络环境下安装 Docker CE + compose 插件，并配置镜像加速。
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL --connect-timeout 15 --max-time 60 \
  https://mirrors.cloud.tencent.com/docker-ce/linux/ubuntu/gpg -o /tmp/docker-ce.gpg
sudo gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker-archive-keyring.gpg /tmp/docker-ce.gpg
echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker-archive-keyring.gpg] https://mirrors.cloud.tencent.com/docker-ce/linux/ubuntu noble stable" \
  | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
sudo apt-get update -y
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
sudo systemctl enable --now docker

# 镜像加速：腾讯云内网镜像 + DaoCloud 兜底（docker.io 拉取加速）
sudo mkdir -p /etc/docker
printf '{\n  "registry-mirrors": ["https://mirror.ccs.tencentyun.com", "https://docker.m.daocloud.io"]\n}\n' \
  | sudo tee /etc/docker/daemon.json >/dev/null
sudo systemctl restart docker

docker --version
docker compose version
