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

  # 2) 相对基线的全部改动（服务器 git 历史已永久保留）
  $baseline = (Invoke-SSHCommand -SessionId $session.SessionId -Command 'cd /home/ubuntu/promise-ai; git rev-list --max-parents=0 HEAD').Output |
    Where-Object { $_ -match '^[0-9a-f]{7,40}$' } | Select-Object -First 1
  if (-not $baseline) { Write-Host '无基线提交，跳过'; return }

  $status = Invoke-SSHCommand -SessionId $session.SessionId -Command "cd /home/ubuntu/promise-ai; git diff --name-status $baseline HEAD"
  $changed = @()
  $deleted = @()
  foreach ($line in $status.Output) {
    if ($line -match '^([AM])\s+(.+)$') { $changed += $matches[2].Trim() }
    elseif ($line -match '^D\s+(.+)$') { $deleted += $matches[1].Trim() }
  }

  Write-Host "--- 服务器改动：新增/修改 $($changed.Count) 个，删除 $($deleted.Count) 个 ---"
  $paths = @()
  foreach ($file in $deleted) {
    $local = Join-Path $Repo $file
    if (Test-Path $local) {
      Remove-Item -LiteralPath $local -Force
      $paths += $file
      Write-Host "删除本地: $file"
    }
  }
  foreach ($file in $changed) {
    $local = Join-Path $Repo $file
    $parent = Split-Path $local -Parent
    if ($parent -and -not (Test-Path $parent)) {
      New-Item -ItemType Directory -Force -Path $parent | Out-Null
    }
    # base64 直传保留相对路径（Get-SCPItem 会丢路径）
    $b64 = (Invoke-SSHCommand -SessionId $session.SessionId -Command "cat /home/ubuntu/promise-ai/$file | base64 -w0").Output -join ''
    if ($b64) {
      [System.IO.File]::WriteAllBytes($local, [Convert]::FromBase64String($b64.Trim()))
      $paths += $file
    }
    Write-Host "拉回: $file"
  }

  # 3) 本地提交（无变化则跳过）
  Push-Location $Repo
  try {
    $dirty = git status --porcelain
    if ($dirty) {
      git add -A -- $paths
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
