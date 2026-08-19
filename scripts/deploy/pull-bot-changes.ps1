<#
本地端：把服务器上 bot 自我开发的改动同步回本地仓库并提交。
用法：powershell -File scripts/deploy/pull-bot-changes.ps1
依赖：Posh-SSH（已安装），服务器信息从参数或环境变量读取。
#>
param(
  [string]$Server = $env:SYNC_SERVER,
  [string]$User = $env:SYNC_USER,
  [string]$Password = $env:SYNC_PASSWORD,
  [string]$Repo = (Join-Path (Split-Path $PSScriptRoot -Parent) '..')
)

$ErrorActionPreference = 'Stop'
if (-not $Server -or -not $User -or -not $Password) {
  Write-Error '需要 SYNC_SERVER / SYNC_USER / SYNC_PASSWORD 环境变量（或参数）'
  exit 1
}

Import-Module Posh-SSH
$secure = New-Object System.Security.SecureString
foreach ($ch in $Password.ToCharArray()) { $secure.AppendChar($ch) }
$cred = New-Object System.Management.Automation.PSCredential($User, $secure)
$session = New-SSHSession -ComputerName $Server -Credential $cred -AcceptKey -ConnectionTimeout 20 -Force

try {
  # 1) 服务器端同步并提交（容器 /app -> 服务器仓库）
  $sync = Invoke-SSHCommand -SessionId $session.SessionId -Command 'bash /home/ubuntu/promise-ai/scripts/deploy/sync-bot-changes.sh 2>&1'
  $sync.Output | ForEach-Object { Write-Host $_ }

  # 2) 本地从 GitHub 拉取并提交（无变化则跳过）
  Push-Location $Repo
  try {
    git fetch origin
    git pull --ff-only origin main 2>&1 | ForEach-Object { Write-Host $_ }
    $dirty = git status --porcelain
    if ($dirty) {
      git add -A
      git commit -m "sync: 服务器 bot 改动（$(Get-Date -Format 'yyyy-MM-dd HH:mm')）"
      Write-Host '--- 本地已提交 ---'
      git log --oneline -1
    } else {
      Write-Host '本地无改动，跳过提交'
    }
  } finally {
    Pop-Location
  }
} finally {
  Remove-SSHSession -SessionId $session.SessionId | Out-Null
}
