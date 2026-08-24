<#
.SYNOPSIS
  Local PostgreSQL for CraftMagic development.

.DESCRIPTION
  Runs a user-mode cluster from the portable binaries in C:\Users\tobia\tools\pgsql — no
  Windows service, no admin rights, and it cannot collide with any other Postgres because
  it listens on 55432 rather than the default 5432.

  Data lives in .pgdata/ at the repo root, which is gitignored. Delete that directory to
  start over.

.EXAMPLE
  ./tools/pg.ps1 init     # create the cluster, role and database (run once)
  ./tools/pg.ps1 start
  ./tools/pg.ps1 status
  ./tools/pg.ps1 psql
  ./tools/pg.ps1 stop
#>
param(
  [Parameter(Position = 0)]
  [ValidateSet('init', 'start', 'stop', 'status', 'psql', 'destroy')]
  [string]$Command = 'status'
)

# NOT 'Stop': Windows PowerShell turns anything a native exe writes to stderr into a
# NativeCommandError, and initdb writes ordinary warnings there. Correctness comes from
# checking $LASTEXITCODE after each call instead.
$ErrorActionPreference = 'Continue'

$PgHome = 'C:\Users\tobia\tools\pgsql'
$RepoRoot = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $RepoRoot '.pgdata'
$Port = 55432
$DbName = 'craftmagic'
$DbUser = 'craftmagic'
$DbPass = 'craftmagic'
$LogFile = Join-Path $DataDir 'postgres.log'

if (-not (Test-Path $PgHome)) {
  throw "PostgreSQL binaries not found at $PgHome. See README."
}

$pgCtl = Join-Path $PgHome 'bin\pg_ctl.exe'
$initdb = Join-Path $PgHome 'bin\initdb.exe'
$psqlExe = Join-Path $PgHome 'bin\psql.exe'

function Test-Running {
  # pg_ctl exits 0 only when the server is up.
  & $pgCtl -D $DataDir status *> $null
  return $LASTEXITCODE -eq 0
}

# Start the server without letting it hold this console's stdout.
#
# `& pg_ctl start` looks like it works, but the long-lived postgres it spawns inherits the
# console/pipe handles, so anything collecting this script's output (`| Select-Object`, or
# a CI harness) blocks forever waiting for a stream that never closes. Start-Process with
# its own hidden window hands the child fresh handles, so pg_ctl can return and the pipe
# closes with it.
function Start-Cluster {
  # Fire and forget, then poll. Every "wait for pg_ctl" variant deadlocks here: the
  # long-lived postgres inherits whatever stdout handle pg_ctl was given — a PowerShell
  # pipe or a redirect file alike — and -Wait blocks on that stream closing, which never
  # happens while the database is up. A hidden window with no redirection hands the child
  # its own handles, and pg_isready tells us when it is actually serving.
  #
  # One string, not an array: Start-Process joins array elements on spaces without quoting,
  # which would split `-o "-p 55432"` into two arguments and make pg_ctl reject "55432".
  $argLine = '-D "{0}" -o "-p {1}" -l "{2}" start' -f $DataDir, $Port, $LogFile
  Start-Process -FilePath $pgCtl -ArgumentList $argLine -WindowStyle Hidden | Out-Null

  $isReady = Join-Path $PgHome 'bin\pg_isready.exe'
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Milliseconds 500
    & $isReady -h 127.0.0.1 -p $Port *> $null
    if ($LASTEXITCODE -eq 0) { return 0 }
  }
  return 1
}

function Invoke-Sql {
  param([string]$Database, [string]$User, [string]$Sql)
  $env:PGPASSWORD = $DbPass
  # Keep -c and its argument on one line: a backtick continuation between them silently
  # breaks the invocation and psql then waits on stdin.
  $out = & $psqlExe -h 127.0.0.1 -p $Port -U $User -d $Database -v ON_ERROR_STOP=1 -Atc $Sql 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) { throw "psql failed: $out" }
  return $out.Trim()
}

switch ($Command) {
  'init' {
    if (Test-Path $DataDir) {
      Write-Host "Cluster already exists at $DataDir. Use 'destroy' first to recreate it." -ForegroundColor Yellow
      break
    }
    $pwFile = Join-Path $env:TEMP "ic-pgpw-$([guid]::NewGuid()).txt"
    try {
      # --pwfile avoids putting the superuser password in the process command line.
      Set-Content -Path $pwFile -Value $DbPass -NoNewline -Encoding ascii
      & $initdb -D $DataDir -U postgres --pwfile=$pwFile --encoding=UTF8 --locale=C
      if ($LASTEXITCODE -ne 0) { throw "initdb failed" }
    } finally {
      Remove-Item -Force $pwFile -ErrorAction SilentlyContinue
    }

    if ((Start-Cluster) -ne 0) { throw "could not start cluster; see $LogFile" }
    Start-Sleep -Seconds 2

    Invoke-Sql -Database postgres -User postgres -Sql "CREATE ROLE $DbUser LOGIN PASSWORD '$DbPass' CREATEDB;" | Out-Null
    Invoke-Sql -Database postgres -User postgres -Sql "CREATE DATABASE $DbName OWNER $DbUser;" | Out-Null

    Write-Host ""
    Write-Host "Cluster ready. DATABASE_URL=postgres://${DbUser}:${DbPass}@localhost:$Port/$DbName" -ForegroundColor Green
  }

  'start' {
    if (Test-Running) { Write-Host "Already running on port $Port."; break }
    if ((Start-Cluster) -ne 0) { throw "could not start cluster; see $LogFile" }
    Write-Host "Started on port $Port."
  }

  'stop' {
    if (-not (Test-Running)) { Write-Host "Not running."; break }
    & $pgCtl -D $DataDir -m fast stop *> $null
    Write-Host "Stopped."
  }

  'status' {
    if (Test-Running) {
      Write-Host "running on port $Port" -ForegroundColor Green
    } else {
      Write-Host "not running" -ForegroundColor Yellow
    }
  }

  'psql' {
    $env:PGPASSWORD = $DbPass
    & $psqlExe -h localhost -p $Port -U $DbUser -d $DbName
  }

  'destroy' {
    if (Test-Running) { & $pgCtl -D $DataDir -m immediate stop }
    Remove-Item -Recurse -Force $DataDir -ErrorAction SilentlyContinue
    Write-Host "Cluster deleted."
  }
}
