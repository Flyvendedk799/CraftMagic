# Restart the built dev server.
#
# `pkill -f` from Git Bash does not reliably kill node on Windows — it silently matches nothing
# and leaves the old process holding the port, so the next request is answered by whatever was
# built an hour ago. That failure looks exactly like a bug in the code you just wrote, twice in
# this project's history. This kills by command line via CIM, which works.
#
# -Port runs an isolated instance instead. Several agents working in separate worktrees would
# otherwise fight over 3016: each restart kills the others' server and serves its own build from
# a different tree, so a driver fails against code its author never wrote. With -Port, only the
# instance on that port is stopped, and a driver is pointed at it with CM_ORIGIN.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools/dev-server.ps1 [-Port 3017] [-StopOnly]
param([switch]$StopOnly, [int]$Port = 3016)

$marker = "CM_DEV_PORT_$Port"

# An instance started before this script grew a -Port carries no marker at all, and matching
# only on the marker leaves it holding the port: the new process then fails to bind and dies,
# the health check is answered by the old one, and the script reports success while serving
# hour-old code. So an unmarked server counts as the default instance and is killed with it.
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object {
    $_.CommandLine -like '*dist*index.js*' -and (
      $_.CommandLine -like "*$marker*" -or
      ($Port -eq 3016 -and $_.CommandLine -notlike '*CM_DEV_PORT_*')
    )
  } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

Start-Sleep -Seconds 2
if ($StopOnly) { "stopped $Port"; exit 0 }

$root = Split-Path -Parent $PSScriptRoot
$env:PORT = "$Port"

# The marker rides on argv purely so the kill above can find this instance and only this one.
# The server ignores it; a command line is the one piece of a process another process can read
# without a pidfile to go stale.
Start-Process -FilePath "node" `
  -ArgumentList "dist/index.js", "--$marker" `
  -WorkingDirectory (Join-Path $root "apps/server") `
  -WindowStyle Hidden

Start-Sleep -Seconds 6

try {
  $code = (Invoke-WebRequest -Uri "http://localhost:$Port/studio" -UseBasicParsing -TimeoutSec 10).StatusCode
  "server up ($code) on $Port"
} catch {
  "server did not answer on port $Port : $_"
  exit 1
}
