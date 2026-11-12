param(
  [Parameter(Mandatory = $true)][string]$NewTgz,
  [Parameter(Mandatory = $true)][string]$PrevTgz,
  [Parameter(Mandatory = $true)][long]$StartMs,
  [Parameter(Mandatory = $true)][string]$ResultFile
)

# 这个脚本由 install-safe 通过 WMI 以**脱离 DSH 进程树**的方式启动，
# 因此能安全重启 DSH 并在崩溃时回滚，不会被自身重启杀死。
$dsh = "C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd"
$logDir = Join-Path $env:APPDATA "@deepseek-ai\dsh-desktop\logs"

function Get-LatestCrashMs {
  try {
    $files = Get-ChildItem $logDir -File -Filter "crash-*" -ErrorAction Stop
    if (-not $files) { return 0 }
    return ($files | Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum.Ticks / 10000
  } catch { return 0 }
}

function Restart-Dsh {
  & powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "D:\MeetingStone\scripts\restart-dsh.ps1" | Out-Null
}

function Install-Tgz([string]$tgz) {
  & cmd.exe /d /s /c "`"$dsh`" plugin --profile desktop remove dsh-meetingstone" | Out-Null
  & cmd.exe /d /s /c "`"$dsh`" plugin --profile desktop add `"$tgz`"" | Out-Null
}

# 先重启一次（安装已完成，尚未验证）
Restart-Dsh
Start-Sleep -Seconds 35

$crashed = (Get-LatestCrashMs) -gt $StartMs
if (-not $crashed) {
  Set-Content -Path $ResultFile -Value "PASS" -Encoding utf8
  exit 0
}

# 崩溃 → 回滚
Install-Tgz $PrevTgz
Restart-Dsh
Set-Content -Path $ResultFile -Value "ROLLED_BACK" -Encoding utf8
exit 2
