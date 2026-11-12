param(
  [Parameter(Mandatory = $true)][string]$NewTgz,
  [Parameter(Mandatory = $true)][string]$PrevTgz,
  [Parameter(Mandatory = $true)][long]$StartMs,
  [Parameter(Mandatory = $true)][string]$ResultFile
)

# Started by install-safe via WMI, outside the DSH process tree, so it can
# restart DSH and roll back without being killed by its own restart.
$logDir = Join-Path $env:APPDATA "@deepseek-ai\dsh-desktop\logs"
$targetDir = Join-Path $env:USERPROFILE ".dsh\profiles\desktop\node_modules\dsh-meetingstone"

function Get-LatestCrashMs {
  try {
    $files = Get-ChildItem $logDir -File -Filter "crash-*" -ErrorAction Stop
    if (-not $files) { return 0 }
    return ($files | Measure-Object -Property LastWriteTimeUtc -Maximum).Maximum.Ticks / 10000
  } catch { return 0 }
}

function Overlay-Tgz([string]$tgz) {
  $stage = Join-Path $env:TEMP ("ms-rollback-" + [guid]::NewGuid().ToString("N"))
  New-Item -ItemType Directory -Force -Path $stage | Out-Null
  & tar -xzf $tgz -C $stage | Out-Null
  $source = Join-Path $stage "package"
  if (Test-Path $source) {
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
    Copy-Item -Path (Join-Path $source "*") -Destination $targetDir -Recurse -Force
  }
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
}

function Restart-Dsh {
  & powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "D:\MeetingStone\scripts\restart-dsh.ps1" | Out-Null
}

Restart-Dsh
Start-Sleep -Seconds 35

$crashed = (Get-LatestCrashMs) -gt $StartMs
if (-not $crashed) {
  Set-Content -Path $ResultFile -Value "PASS" -Encoding utf8
  exit 0
}

Overlay-Tgz $PrevTgz
Restart-Dsh
Set-Content -Path $ResultFile -Value "ROLLED_BACK" -Encoding utf8
exit 2
