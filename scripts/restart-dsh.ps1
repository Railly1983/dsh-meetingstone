# 自动重启 DeepSeek Harness（WMI 创建，脱离 DSH 进程树）
$log = Join-Path $env:TEMP 'mt-restart.log'
"$(Get-Date -Format o) start (sleep 20s before kill)" | Out-File -FilePath $log -Encoding utf8

Start-Sleep -Seconds 20

"$(Get-Date -Format o) killing" | Out-File -FilePath $log -Append -Encoding utf8
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 5

$exe = 'C:\Users\30673\AppData\Local\Programs\DeepSeek Harness\DeepSeek Harness.exe'
for ($i = 1; $i -le 3; $i++) {
  Start-Process -FilePath $exe
  Start-Sleep -Seconds 6
  if (Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue) {
    "$(Get-Date -Format o) relaunched on attempt $i" | Out-File -FilePath $log -Append -Encoding utf8
    break
  }
  "$(Get-Date -Format o) attempt $i did not survive" | Out-File -FilePath $log -Append -Encoding utf8
}

"$(Get-Date -Format o) done" | Out-File -FilePath $log -Append -Encoding utf8
