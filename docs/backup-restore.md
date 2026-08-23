# Postgres 备份与恢复 SOP

> 适用：云服务器（122.152.209.182）上的 `assistant-postgres` 容器（pgvector/pg16）。
> 目的：数据库被误删/损坏时，能在一小时内恢复，最多丢一天数据。

## 1. 自动备份（已在运行）

服务器已配置每日自动备份：

- 脚本：`/home/ubuntu/backup-postgres.sh`（root cron 每天 **03:30** 执行）；
- 备份文件：`/home/ubuntu/backups/postgres/postgres-<UTC时间戳>.dump`；
- 稳定指针：`/home/ubuntu/backups/postgres/latest.dump`（每次备份后更新的符号链接）；
- 本机拉取：仓库根目录执行 `powershell -File scripts/pull-postgres-backup.ps1`；
- 格式：`pg_dump` custom 格式（gzip 压缩，可 `pg_restore` 选择性恢复）；
- 保留：最近 **14 份**（旧的自动删除）；
- 日志：`/home/ubuntu/backups/postgres-backup.log`。


## 1.1 如何确认调度还在跑

调度归属：**root crontab**（不是 ubuntu 用户 crontab，也不是 Agent TaskService）。

```bash
sudo crontab -l | grep backup-postgres
# 期望：30 3 * * * /home/ubuntu/backup-postgres.sh >> /home/ubuntu/backups/postgres-backup.log 2>&1

tail -5 /home/ubuntu/backups/postgres-backup.log
# 期望每天 03:30 出现一行 [backup] ok ...
```

若连续两天没有新日志，先手动跑 `sudo /home/ubuntu/backup-postgres.sh` 看脚本本身是否失败，再查 `sudo crontab -l`。

手动备份一条命令：

```bash
sudo /home/ubuntu/backup-postgres.sh
```

## 2. 恢复流程（pg_restore）

### 2.1 确认备份

```bash
ls -lh /home/ubuntu/backups/postgres/
# 校验 dump 有效（能看到 TOC Entries 列表即有效）
sudo docker run --rm -v /home/ubuntu/backups/postgres:/backup:ro postgres:16 \
  pg_restore --list /backup/postgres-<时间戳>.dump | head -20
```

### 2.2 恢复到新库（推荐：先恢复到一个新库验证，再切换）

```bash
# 1) 起一个临时恢复库（与 assistant-postgres 同网络，避免端口冲突）
sudo docker run -d --name assistant-pg-restore \
  --network infrastructure_default \
  -e POSTGRES_USER=assistant -e POSTGRES_PASSWORD=assistant -e POSTGRES_DB=assistant \
  pgvector/pgvector:pg16

# 2) 把 dump 拷进恢复容器并还原
sudo docker cp /home/ubuntu/backups/postgres/postgres-<时间戳>.dump assistant-pg-restore:/tmp/backup.dump
sudo docker exec assistant-pg-restore pg_restore -U assistant -d assistant --no-owner /tmp/backup.dump

# 3) 验证数据
sudo docker exec assistant-pg-restore psql -U assistant -d assistant -c \
  'SELECT (SELECT count(*) FROM sessions) AS sessions, (SELECT count(*) FROM memories) AS memories, (SELECT count(*) FROM tasks) AS tasks;'
```

### 2.3 切换主库（确认恢复库数据无误后）

```bash
# 停应用，备份当前（可能已损坏）的库，再用恢复库替换
sudo docker stop assistant-app assistant-weixin
sudo docker stop assistant-postgres
sudo mv /var/lib/docker/volumes/infrastructure_postgres-data/_data /var/lib/docker/volumes/infrastructure_postgres-data/_data.broken
sudo docker rm assistant-postgres
sudo docker rename assistant-pg-restore assistant-postgres
sudo docker start assistant-postgres
sudo docker start assistant-app assistant-weixin
```

> 注意：容器名/卷名以实际 `infrastructure/docker-compose.yml` 为准；替换前先把
> 损坏库目录改名保留（可抢救），不要直接删除。

## 3. 验证清单

恢复完成后逐项确认：

1. `sudo docker ps` 三个容器（app / weixin / postgres）都 healthy；
2. 会话数量与备份时刻一致：`SELECT count(*) FROM sessions;`；
3. 记忆/画像/任务/提醒表非空：`memories`、`user_profiles`、`tasks`、`reminders`、`profile_events`；
4. 微信发一条消息，确认 bot 能正常回复（会话历史可继续）；
5. `sudo docker logs assistant-app --tail 20` 无报错。

## 4. 演练建议

每季度在低峰期做一次"恢复到临时库 + 数据比对"演练，确保备份真能救命。
