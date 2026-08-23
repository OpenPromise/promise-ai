# 从 Promise AI 服务器拉取最新 postgres 备份到本机
# 用法：在仓库根目录执行  powershell -File scripts/pull-postgres-backup.ps1
$ErrorActionPreference = 'Stop'
$destDir = Join-Path $PSScriptRoot '..\backups\postgres'
New-Item -ItemType Directory -Force -Path $destDir | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$dest = Join-Path $destDir "postgres-latest-$stamp.dump"
scp ubuntu@122.152.209.182:/home/ubuntu/backups/postgres/latest.dump $dest
Get-Item $dest | Select-Object FullName, Length, LastWriteTime
