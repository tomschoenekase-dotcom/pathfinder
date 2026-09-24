param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('seed', 'stage', 'dispatch')]
  [string] $Mode,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $Arguments
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$container = 'torchiko-crm-research-db-20260919'
$database = 'pathfinder_disposable_crm_research_20260919'
$state = (& docker inspect --format '{{.State.Status}}' $container)
if ($LASTEXITCODE -ne 0 -or $state -ne 'running') { throw 'The retained CRM container must already be running.' }
$ports = (& docker inspect --format '{{json .NetworkSettings.Ports}}' $container | ConvertFrom-Json)
$binding = @($ports.'5432/tcp')
if ($binding.Count -ne 1 -or $binding[0].HostIp -ne '127.0.0.1' -or $binding[0].HostPort -ne '58617') {
  throw 'The retained CRM loopback database identity does not match.'
}
if (($env:REDIS_URL -and $env:REDIS_URL -ne 'redis://127.0.0.1:58619') -or
    ($env:RAILWAY_ENVIRONMENT -and $env:RAILWAY_ENVIRONMENT -ne 'preview')) {
  throw 'Only the retained loopback Redis queue may be used.'
}
if ($env:NEXT_PUBLIC_WEB_URL -and $env:NEXT_PUBLIC_WEB_URL -ne 'https://guide.example.invalid') {
  throw 'Only the synthetic public QR origin may be used.'
}
$containerEnvironment = (& docker inspect --format '{{json .Config.Env}}' $container | ConvertFrom-Json)
$passwordEntry = $containerEnvironment | Where-Object { $_.StartsWith('POSTGRES_PASSWORD=') } | Select-Object -First 1
$userEntry = $containerEnvironment | Where-Object { $_.StartsWith('POSTGRES_USER=') } | Select-Object -First 1
$trustConfigured = $containerEnvironment -contains 'POSTGRES_HOST_AUTH_METHOD=trust'
if (!$passwordEntry -and !$trustConfigured) { throw 'Retained local database has no bootstrap credential or trust mode.' }
$localUser = if ($userEntry) { $userEntry.Substring('POSTGRES_USER='.Length) } else { 'postgres' }
$localPassword = if ($passwordEntry) { $passwordEntry.Substring('POSTGRES_PASSWORD='.Length) } else { '' }
$env:DATABASE_URL = 'postgresql://{0}:{1}@127.0.0.1:58617/{2}' -f [Uri]::EscapeDataString($localUser), [Uri]::EscapeDataString($localPassword), $database
$env:DIRECT_DATABASE_URL = $env:DATABASE_URL
$env:NODE_ENV = 'test'
$env:TORCHIKO_LOCAL_CRM_RESEARCH_ENABLED = '1'
$env:TORCHIKO_LOCAL_CRM_SALES_ENABLED = '1'
$env:TORCHIKO_LOCAL_CRM_REHEARSAL = '1'
$env:TORCHIKO_CRM_VAULT = 'C:\Users\tomsc\Downloads\AwesomeVault'
$env:TORCHIKO_CRM_SALES_BRIDGE = Join-Path $root 'scripts\crm-sales\component_bridge.py'
$env:RAILWAY_ENVIRONMENT = 'preview'
$env:REDIS_URL = 'redis://127.0.0.1:58619'
# Inert schema sentinels only. The verifier blocks all auth/provider HTTP.
$env:CLERK_SECRET_KEY = 'synthetic-unused-no-auth'
$env:CLERK_PUBLISHABLE_KEY = 'synthetic-unused-no-auth'
$env:NEXT_PUBLIC_WEB_URL = 'https://guide.example.invalid'
$localPassword = $null
$passwordEntry = $null
$containerEnvironment = $null
Push-Location $root
try {
  if ($Mode -eq 'seed') {
    if ($Arguments.Count -ne 2 -or $Arguments[0] -notmatch '^r2[0-9]{2}$') { throw 'Seed requires a fresh r2xx revision and QA receipt path.' }
    & pnpm --dir packages/db exec tsx ../../scripts/accept-native-crm-first-send.ts --phase stage --fixture-revision $Arguments[0] --output $Arguments[1]
  } elseif ($Mode -eq 'stage') {
    if ($Arguments.Count -ne 2) { throw 'Stage requires revision r201+ and new QA receipt path.' }
    & pnpm --dir packages/db exec tsx ../../scripts/stage-venue-launch-queue.ts @Arguments
  } else {
    if ($Arguments.Count -ne 6) { throw 'Dispatch requires --mode, --outbox-id and --output arguments.' }
    & pnpm --dir packages/db exec tsx ../../scripts/verify-venue-launch-queue.ts @Arguments
  }
  $result = $LASTEXITCODE
} finally {
  Pop-Location
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:DIRECT_DATABASE_URL -ErrorAction SilentlyContinue
}
exit $result
