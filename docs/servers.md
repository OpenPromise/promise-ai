# 服务器资产

用户说「小夜」= 本机（腾讯云 Ubuntu 122.152.209.182，容器 `/app`）。
用户说「代理」= 3x-ui 节点机，小夜团队有 root。

## 代理

- SSH：`ssh proxy` 或 `ssh 代理`（root@45.78.64.253，密钥 `~/.ssh/id_ed25519_proxy`）
- 系统：AlmaLinux 9.7，hostname `crucial-buzz-2.localdomain`
- 域名：`node.hggzs.cn`（VLESS Reality）、`panel.hggzs.cn`（3x-ui 面板）、`sub.hggzs.cn`（订阅）
- 证书：`/root/cert/hggzs.cn/`，SAN = node|panel|sub
- 公网 443：nginx stream `ssl_preread`（`/etc/nginx/nginx.conf`）
  - `sub.hggzs.cn` → `127.0.0.1:2096`
  - `panel.hggzs.cn` → `127.0.0.1:49271`
  - 其它 SNI → `127.0.0.1:443`（xray inbound `in-443-tcp`，dest `www.amd.com:443`）
- 面板：https://panel.hggzs.cn （内部监听 49271）
- 订阅：https://sub.hggzs.cn （内部 2096，公网仍开着当后备）
- 改之前备份：`/root/backup-sni-443/`
- 常用检查：`ss -tlnp | grep -E '443|2096|49271'`；`systemctl status nginx x-ui`
- 不要在对话里贴 Reality 私钥、UUID、shortId、面板 webBasePath、root 密码

## 本机（小夜）

- 仓库：`/app`（宿主机 `/home/ubuntu/promise-ai`）
- 容器：assistant-app :3000、assistant-weixin :3100、postgres :5432、team-site :80
- 出站代理：宿主机 xray-client HTTP 7890 / SOCKS 7891 → `node.hggzs.cn:443`
- GitHub HTTPS 必须带 `HTTPS_PROXY`；`server.shell` 已放行代理变量
