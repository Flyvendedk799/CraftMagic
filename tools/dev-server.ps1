# Restart the built dev server on :3016.
#
# `pkill -f` from Git Bash does not reliably kill node on Windows — it silently matches
# nothing and leaves the old process holding the port, so the next request is answered by
# whatever was built an hour ago. That failure looks exactly like a bug in the code you just
# wrote, twice in this project's history. This kills by command line via CIM, which works.
param([switch]$StopOnly)

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*dist*index.js*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Start-Sleep -Seconds 2
if ($StopOnly) { "stopped"; exit 0 }

$root = Split-Path -Parent $PSScriptRoot
Start-Process -FilePath "node" -ArgumentList "dist/index.js" -WorkingDirectory (Join-Path $root "apps/server") -WindowStyle Hidden
Start-Sleep -Seconds 6

try {
  $code = (Invoke-WebRequest -Uri "http://localhost:3016/studio" -UseBasicParsing -TimeoutSec 10).StatusCode
  "server up ($code)"
} catch {
  "server did not answer: $_"
  exit 1
}
