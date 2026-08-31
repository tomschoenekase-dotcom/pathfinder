[CmdletBinding()]
param(
  [ValidateSet('Status', 'Up', 'Stop')]
  [string]$Action = 'Status'
)

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$composeFile = Join-Path $repoRoot 'compose.local-staging.yml'
$dataRoot = Join-Path ([Environment]::GetFolderPath('UserProfile')) 'PathFinderLocalStaging'
$logsRoot = Join-Path $dataRoot 'logs'
$stateRoot = Join-Path $dataRoot 'state'
$dashboardPidFile = Join-Path $stateRoot 'dashboard.pid'
$webPidFile = Join-Path $stateRoot 'web.pid'
$workerPidFile = Join-Path $stateRoot 'workers.pid'
$databaseName = 'pathfinder_disposable_local_staging'
$databaseUrl = 'postgresql://pathfinder:pathfinder-local-staging@127.0.0.1:55440/pathfinder_disposable_local_staging'

function Get-LocalStagingLanAddress {
  $configuration = Get-NetIPConfiguration -ErrorAction SilentlyContinue |
    Where-Object {
      $_.NetAdapter.Status -eq 'Up' -and
      $_.IPv4DefaultGateway -ne $null -and
      $_.IPv4Address -ne $null
    } |
    Select-Object -First 1
  $address = $configuration.IPv4Address | Select-Object -First 1 -ExpandProperty IPv4Address
  if ($address -and $address -notlike '127.*' -and $address -notlike '169.254.*') {
    return [string]$address
  }
  return '127.0.0.1'
}

$localStagingLanAddress = Get-LocalStagingLanAddress

function Write-Structured([string]$eventName, [hashtable]$detail) {
  [ordered]@{
    timestamp = [DateTime]::UtcNow.ToString('o')
    event = $eventName
    detail = $detail
  } | ConvertTo-Json -Compress -Depth 6
}

function Set-LocalStagingEnvironment {
  $env:PATHFINDER_LOCAL_STAGING_DATA_DIR = $dataRoot.Replace('\', '/')
  $env:PATHFINDER_LOCAL_STAGING_MINIO_BIND_ADDRESS = $localStagingLanAddress
  $env:PATHFINDER_LOCAL_STAGING_DASHBOARD_ORIGIN = "http://${localStagingLanAddress}:3101"
  $env:RAILWAY_ENVIRONMENT = 'staging'
  $env:DATABASE_URL = $databaseUrl
  $env:DIRECT_DATABASE_URL = $databaseUrl
  $env:REDIS_URL = 'redis://127.0.0.1:56380'
  $env:STORAGE_BUCKET = 'pathfinder-local-staging'
  $env:STORAGE_REGION = 'us-east-1'
  $env:STORAGE_ENDPOINT = "http://${localStagingLanAddress}:59000"
  $env:STORAGE_ACCESS_KEY_ID = 'pathfinder-local-staging'
  $env:STORAGE_SECRET_ACCESS_KEY = 'pathfinder-local-staging-secret'
  $env:INTAKE_CLAMAV_HOST = '127.0.0.1'
  $env:INTAKE_CLAMAV_PORT = '53310'
  $env:DATABASE_RESOURCE_ID = 'pc-local-postgres-55440'
  $env:REDIS_RESOURCE_ID = 'pc-local-redis-56380'
  $env:STORAGE_RESOURCE_ID = 'pc-local-minio-59000'
  $env:NEXT_PUBLIC_WEB_URL = 'http://127.0.0.1:3100'
  $env:NEXT_DIST_DIR = '.next-local-staging'
  $env:OUTBOUND_PROVIDER_WORKERS_ENABLED = 'false'
  $env:INTAKE_UPLOAD_VERIFICATION_WORKERS_ENABLED = 'false'
  $env:WORKER_SCHEDULERS_ENABLED = 'false'
  $env:EMBEDDING_DISPATCH_ENABLED = 'false'
  $env:GENERATION_DISPATCH_ENABLED = 'false'
  $env:GENERATION_RECOVERY_ENABLED = 'false'
  $env:EVALUATION_RUNNER_ENABLED = 'false'
  $env:VENUE_MEDIA_DERIVATIVE_WORKERS_ENABLED = 'true'
}

function Get-RecordedProcess([string]$pidFile, [string]$expectedFragment) {
  if (-not (Test-Path -LiteralPath $pidFile)) { return $null }
  $recorded = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  if ($recorded -notmatch '^\d+$') { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$recorded" -ErrorAction SilentlyContinue
  if (-not $process -or $process.CommandLine -notlike "*$expectedFragment*") { return $null }
  return $process
}

function Get-ListenerProcess([int]$port) {
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if (-not $listener) { return $null }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listener.OwningProcess)" -ErrorAction SilentlyContinue
  if (-not $process -or $process.CommandLine -notlike '*PathFinder*' -or $process.CommandLine -notlike '*next*') {
    return $null
  }
  return $process
}

function Start-AppProcess(
  [string]$name,
  [string]$workspace,
  [int]$port,
  [string]$pidFile
) {
  $stdout = Join-Path $logsRoot "$name.stdout.log"
  $stderr = Join-Path $logsRoot "$name.stderr.log"
  $process = Start-Process -FilePath 'pnpm.cmd' `
    -ArgumentList @('exec', 'next', 'dev', '--port', "$port") `
    -WorkingDirectory (Join-Path $repoRoot $workspace) `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru
  Set-Content -LiteralPath $pidFile -Value $process.Id -NoNewline
  return [int]$process.Id
}

function Start-WorkerProcess([string]$pidFile) {
  $stdout = Join-Path $logsRoot 'workers.stdout.log'
  $stderr = Join-Path $logsRoot 'workers.stderr.log'
  $process = Start-Process -FilePath 'node.exe' `
    -ArgumentList @('--require', './dist/sentry.js', './dist/bootstrap.js') `
    -WorkingDirectory (Join-Path $repoRoot 'apps/workers') `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdout `
    -RedirectStandardError $stderr `
    -PassThru
  Set-Content -LiteralPath $pidFile -Value $process.Id -NoNewline
  return [int]$process.Id
}

function Wait-ForWorker([int]$processId) {
  $stdout = Join-Path $logsRoot 'workers.stdout.log'
  for ($attempt = 0; $attempt -lt 30; $attempt++) {
    if (-not (Get-Process -Id $processId -ErrorAction SilentlyContinue)) {
      throw "Local staging worker exited before readiness. Inspect $logsRoot."
    }
    if ((Test-Path -LiteralPath $stdout) -and
        (Select-String -LiteralPath $stdout -Pattern '"action":"workers.started"' -Quiet)) {
      return
    }
    Start-Sleep -Seconds 1
  }
  throw "Local staging worker did not report readiness. Inspect $logsRoot."
}

function Stop-RecordedProcess([string]$pidFile, [string]$expectedFragment) {
  $process = Get-RecordedProcess $pidFile $expectedFragment
  if ($process) {
    Stop-Process -Id $process.ProcessId
    for ($attempt = 0; $attempt -lt 100; $attempt++) {
      if (-not (Get-Process -Id $process.ProcessId -ErrorAction SilentlyContinue)) { break }
      Start-Sleep -Milliseconds 100
    }
  }
  Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
}

function Wait-ForHttp([string]$url) {
  for ($attempt = 0; $attempt -lt 90; $attempt++) {
    try {
      $response = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 3
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400) { return }
    } catch {}
    Start-Sleep -Seconds 1
  }
  throw "Local staging did not become reachable: $url"
}

function Stop-LocalAppListener([int]$port, [string]$pidFile) {
  $process = Get-ListenerProcess $port
  if ($process) {
    Stop-Process -Id $process.ProcessId
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
      if (-not (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)) {
        break
      }
      Start-Sleep -Milliseconds 100
    }
  }
  Remove-Item -LiteralPath $pidFile -ErrorAction SilentlyContinue
}

Set-LocalStagingEnvironment

if ($Action -eq 'Status') {
  $dashboard = Get-NetTCPConnection -LocalPort 3101 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  $web = Get-NetTCPConnection -LocalPort 3100 -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1
  $worker = Get-RecordedProcess $workerPidFile 'dist/bootstrap.js'
  $containers = @(docker compose -f $composeFile ps --format json 2>$null | ForEach-Object {
      $row = $_ | ConvertFrom-Json
      @{
        service = $row.Service
        state = $row.State
        health = $row.Health
        status = $row.Status
      }
    })
  Write-Structured 'local-staging.status' @{
    dataRoot = $dataRoot
    dashboardUrl = 'http://127.0.0.1:3101'
    dashboardLanUrl = "http://${localStagingLanAddress}:3101"
    dashboardPid = $dashboard.OwningProcess
    webUrl = 'http://127.0.0.1:3100'
    webLanUrl = "http://${localStagingLanAddress}:3100"
    storageEndpoint = $env:STORAGE_ENDPOINT
    webPid = $web.OwningProcess
    workerPid = $worker.ProcessId
    workerMode = if ($worker) { 'venue-media-derivative-only' } else { 'not-running' }
    containers = $containers
  }
  exit 0
}

if ($Action -eq 'Stop') {
  Stop-RecordedProcess $workerPidFile 'dist/bootstrap.js'
  Stop-LocalAppListener 3101 $dashboardPidFile
  Stop-LocalAppListener 3100 $webPidFile
  docker compose -f $composeFile stop | Out-Null
  Write-Structured 'local-staging.stopped' @{ dataPreservedAt = $dataRoot }
  exit 0
}

New-Item -ItemType Directory -Force -Path $logsRoot, $stateRoot | Out-Null
docker compose -f $composeFile up -d --wait postgres redis minio clamav
if ($LASTEXITCODE -ne 0) { throw 'Local staging dependencies failed to start.' }
docker compose -f $composeFile run --rm minio-init
if ($LASTEXITCODE -ne 0) { throw 'Local staging storage initialization failed.' }

$env:PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS = '1'
$env:PATHFINDER_DISPOSABLE_DATABASE_URL = $databaseUrl
Push-Location $repoRoot
try {
  pnpm db:migrate:disposable --database $databaseName --confirm-database $databaseName
  if ($LASTEXITCODE -ne 0) { throw 'Local staging migration failed.' }
} finally {
  Pop-Location
  Remove-Item Env:PATHFINDER_ALLOW_DISPOSABLE_MIGRATIONS -ErrorAction SilentlyContinue
  Remove-Item Env:PATHFINDER_DISPOSABLE_DATABASE_URL -ErrorAction SilentlyContinue
}

Stop-LocalAppListener 3101 $dashboardPidFile
Stop-LocalAppListener 3100 $webPidFile
Stop-RecordedProcess $workerPidFile 'dist/bootstrap.js'
Push-Location $repoRoot
try {
  pnpm --filter '@pathfinder/workers' build
  if ($LASTEXITCODE -ne 0) { throw 'Local staging worker build failed.' }
} finally {
  Pop-Location
}
$dashboardPid = Start-AppProcess 'dashboard' 'apps/dashboard' 3101 $dashboardPidFile
$webPid = Start-AppProcess 'web' 'apps/web' 3100 $webPidFile
$workerPid = Start-WorkerProcess $workerPidFile
Wait-ForHttp 'http://127.0.0.1:3101/sign-in'
Wait-ForHttp 'http://127.0.0.1:3100/api/health'
Wait-ForWorker $workerPid

$dashboardListener = Get-ListenerProcess 3101
$webListener = Get-ListenerProcess 3100
if (-not $dashboardListener -or -not $webListener) {
  throw 'Local staging listeners could not be attributed safely to PathFinder.'
}
$dashboardPid = [int]$dashboardListener.ProcessId
$webPid = [int]$webListener.ProcessId
Set-Content -LiteralPath $dashboardPidFile -Value $dashboardPid -NoNewline
Set-Content -LiteralPath $webPidFile -Value $webPid -NoNewline

Write-Structured 'local-staging.ready' @{
  dataRoot = $dataRoot
  dashboardUrl = 'http://127.0.0.1:3101'
  dashboardLanUrl = "http://${localStagingLanAddress}:3101"
  dashboardPid = $dashboardPid
  webUrl = 'http://127.0.0.1:3100'
  webLanUrl = "http://${localStagingLanAddress}:3100"
  storageEndpoint = $env:STORAGE_ENDPOINT
  webPid = $webPid
  workerPid = $workerPid
  minioConsoleUrl = 'http://127.0.0.1:59001'
  database = $databaseName
  workerMode = 'provider-disabled-health-only'
}
