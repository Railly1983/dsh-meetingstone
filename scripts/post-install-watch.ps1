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

function Get-CrashesSince([long]$sinceMs) {
  try {
    return Get-ChildItem $logDir -File -Filter "crash-*" -ErrorAction Stop |
      Where-Object { ([DateTimeOffset]$_.LastWriteTimeUtc).ToUnixTimeMilliseconds() -gt $sinceMs }
  } catch { return @() }
}

# Only plugin/boot failures count. Killing DSH to restart produces
# "dsh desktop host exited with 4294967295" and must NOT trigger rollback.
function Test-BootFailure($files) {
  foreach ($file in $files) {
    $text = Get-Content $file.FullName -Raw -ErrorAction SilentlyContinue
    if ($text -match "web boot:|entry did not activate|dsh-meetingstone:\s*failed|plugin .* failed to activate") {
      return $true
    }
  }
  return $false
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

$crashes = Get-CrashesSince $StartMs
if (-not (Test-BootFailure $crashes)) {
  Set-Content -Path $ResultFile -Value "PASS" -Encoding utf8
  exit 0
}

Overlay-Tgz $PrevTgz
Restart-Dsh
Set-Content -Path $ResultFile -Value "ROLLED_BACK" -Encoding utf8
exit 2
