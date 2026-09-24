param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('import', 'readback', 'api-check', 'preview', 'sales-migrate', 'sales-check', 'meaning-check', 'evidence-check', 'first-send-check', 'connected-queue-stage', 'connected-queue-dispatch', 'connected-enqueue-check', 'connected-reply-check', 'selected-reply-check')]
  [string] $Mode,
  [switch] $EnableSalesPreparation,
  [switch] $EnableSyntheticRehearsal,
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]] $Arguments
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$container = 'torchiko-crm-research-db-20260919'
$database = 'pathfinder_disposable_crm_research_20260919'
$state = (& docker inspect --format '{{.State.Status}}' $container)
if ($LASTEXITCODE -ne 0 -or $state -ne 'running') { throw 'The retained CRM container must already be running. Do not recreate it.' }
$ports = (& docker inspect --format '{{json .NetworkSettings.Ports}}' $container | ConvertFrom-Json)
$binding = @($ports.'5432/tcp')
if ($binding.Count -ne 1 -or $binding[0].HostIp -ne '127.0.0.1' -or $binding[0].HostPort -ne '58617') {
  throw 'The retained CRM loopback port identity does not match.'
}
# Read only this disposable container's credentials into process memory. Never
# print them, write .env files, or load a production/deployment environment file.
$containerEnvironment = (& docker inspect --format '{{json .Config.Env}}' $container | ConvertFrom-Json)
$passwordEntry = $containerEnvironment | Where-Object { $_.StartsWith('POSTGRES_PASSWORD=') } | Select-Object -First 1
$userEntry = $containerEnvironment | Where-Object { $_.StartsWith('POSTGRES_USER=') } | Select-Object -First 1
$trustConfigured = $containerEnvironment -contains 'POSTGRES_HOST_AUTH_METHOD=trust'
if (!$passwordEntry -and !$trustConfigured) { throw 'The retained container has neither a local bootstrap credential nor explicit trust authentication.' }
$localUser = if ($userEntry) { $userEntry.Substring('POSTGRES_USER='.Length) } else { 'postgres' }
$localPassword = if ($passwordEntry) { $passwordEntry.Substring('POSTGRES_PASSWORD='.Length) } else { '' }
$env:DATABASE_URL = 'postgresql://{0}:{1}@127.0.0.1:58617/{2}' -f [Uri]::EscapeDataString($localUser), [Uri]::EscapeDataString($localPassword), $database
$env:DIRECT_DATABASE_URL = $env:DATABASE_URL
$env:NODE_ENV = if ($Mode -eq 'preview' -or $Mode -eq 'api-check') { 'development' } else { 'test' }
$env:TORCHIKO_LOCAL_CRM_RESEARCH_ENABLED = '1'
if ($Mode -in @('sales-check','meaning-check','evidence-check','first-send-check','connected-queue-stage','connected-queue-dispatch','connected-enqueue-check','connected-reply-check','selected-reply-check') -or ($Mode -eq 'preview' -and $EnableSalesPreparation)) {
  $env:TORCHIKO_LOCAL_CRM_SALES_ENABLED = '1'
  $env:TORCHIKO_CRM_VAULT = 'C:\Users\tomsc\Downloads\AwesomeVault'
  $env:TORCHIKO_CRM_SALES_BRIDGE = Join-Path $root 'scripts\crm-sales\component_bridge.py'
} else {
  Remove-Item Env:TORCHIKO_LOCAL_CRM_SALES_ENABLED -ErrorAction SilentlyContinue
}
if ($Mode -in @('first-send-check','connected-queue-stage','connected-queue-dispatch','connected-enqueue-check','connected-reply-check','selected-reply-check') -or ($Mode -eq 'preview' -and $EnableSyntheticRehearsal -and $EnableSalesPreparation)) {
  $env:TORCHIKO_LOCAL_CRM_REHEARSAL = '1'
} else { Remove-Item Env:TORCHIKO_LOCAL_CRM_REHEARSAL -ErrorAction SilentlyContinue }
if ($Mode -eq 'preview') {
  $env:TORCHIKO_VISUAL_FIXTURES_ENABLED = '1'
  $env:NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = ''
  $env:NEXT_DIST_DIR = '.next-crm-research'
  $env:NEXT_TELEMETRY_DISABLED = '1'
}
if ($Mode -eq 'connected-enqueue-check') {
  if (($env:REDIS_URL -and $env:REDIS_URL -ne 'redis://127.0.0.1:58619') -or
      ($env:RAILWAY_ENVIRONMENT -and $env:RAILWAY_ENVIRONMENT -ne 'preview')) {
    throw 'Use a dedicated proof process with no unrelated Redis or deployment environment configured.'
  }
  $env:RAILWAY_ENVIRONMENT = 'preview'
  $env:REDIS_URL = 'redis://127.0.0.1:58619'
}
$localPassword = $null
$passwordEntry = $null
$containerEnvironment = $null
Push-Location $root
try {
  switch ($Mode) {
    'import' { & pnpm --dir packages/db exec tsx ../../scripts/import-prospect-workbook.ts @Arguments }
    'readback' { & pnpm --dir packages/db exec tsx ../../scripts/verify-prospect-workbook-import.ts @Arguments }
    'api-check' { & pnpm --dir packages/db exec tsx ../../scripts/verify-prospect-crm-api.ts @Arguments }
    'sales-check' { & pnpm --dir packages/db exec tsx ../../scripts/accept-native-crm-sales.ts @Arguments }
    'meaning-check' {
      if ((Get-PSDrive C).Free -lt 5GB) { throw 'Defer meaning acceptance: preserve the 5 GiB overnight disk reserve.' }
      & pnpm --dir packages/db exec tsx ../../scripts/accept-native-crm-meaning.ts @Arguments
    }
    'evidence-check' {
      if ((Get-PSDrive C).Free -lt 5GB) { throw 'Defer evidence acceptance: preserve 5 GiB reserve.' }
      & pnpm --dir packages/db exec tsx ../../scripts/accept-native-crm-evidence.ts @Arguments
    }
    'first-send-check' {
      if ((Get-PSDrive C).Free -lt 5GB -or (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory -lt 4MB) { throw 'Defer: retain 5 GiB disk and 4 GiB available RAM.' }
      & pnpm --dir packages/db exec tsx ../../scripts/accept-native-crm-first-send.ts @Arguments
    }
    'connected-queue-stage' {
      if ((Get-PSDrive C).Free -lt 5GB -or (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory -lt 4MB) { throw 'Defer: retain 5 GiB disk and 4 GiB available RAM.' }
      if ($Arguments.Count -ne 2) { throw 'Fixture revision and external QA receipt path are required.' }
      & pnpm --dir packages/db exec tsx ../../scripts/stage-connected-send-queue.ts @Arguments
    }
    'connected-queue-dispatch' {
      if ((Get-PSDrive C).Free -lt 5GB -or (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory -lt 4MB) { throw 'Defer: retain 5 GiB disk and 4 GiB available RAM.' }
      if ($Arguments.Count -ne 6) { throw 'Exact mode, outbox and external QA receipt arguments are required.' }
      & pnpm --dir packages/db exec tsx ../../scripts/verify-connected-send-queue.ts @Arguments
    }
    'connected-enqueue-check' {
      if ((Get-PSDrive C).Free -lt 5GB -or (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory -lt 4MB) { throw 'Defer: retain 5 GiB disk and 4 GiB available RAM.' }
      if ($Arguments.Count -ne 6) { throw 'Exact mode, outbox and external QA receipt arguments are required.' }
      & pnpm --dir packages/db exec tsx ../../scripts/verify-connected-queue-enqueue.ts @Arguments
    }
    'selected-reply-check' {
      if ((Get-PSDrive C).Free -lt 5GB -or (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory -lt 4MB) { throw 'Defer: retain 5 GiB disk and 4 GiB available RAM.' }
      if ($Arguments.Count -ne 4) { throw 'Exact db/full mode and new external QA receipt path are required.' }
      & pnpm --dir packages/db exec tsx ../../scripts/verify-selected-reply-content.ts @Arguments
    }
    'connected-reply-check' {
      if ((Get-PSDrive C).Free -lt 5GB -or (Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory -lt 4MB) { throw 'Defer: retain 5 GiB disk and 4 GiB available RAM.' }
      if ($Arguments.Count -ne 2) { throw 'External QA receipt path and run suffix are required.' }
      & pnpm --dir packages/db exec tsx ../../scripts/verify-connected-reply-roundtrip.ts @Arguments
    }
    'sales-migrate' {
      if ($Arguments.Count) { throw 'Sales migration arguments are fixed.' }
      if ((Get-PSDrive C).Free -lt 1GB) { throw 'Insufficient local disk headroom for Prisma generation.' }
      $applied = @(& docker exec $container psql -U $localUser -d $database --no-psqlrc -t -A -c 'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL')
      if ($LASTEXITCODE -ne 0) { throw 'Could not read the retained local migration ledger.' }
      $pending = @(Get-ChildItem (Join-Path $root 'packages\db\prisma\migrations') -Directory | Where-Object { $applied -notcontains $_.Name })
      if ($pending.Count -gt 1 -or ($pending.Count -eq 1 -and $pending[0].Name -ne '20260921050000_native_sales_no_send')) {
        throw 'Unexpected pending migrations. This run may apply only the owned NO-SEND extension.'
      }
      & pnpm --dir packages/db exec prisma migrate deploy
      if ($LASTEXITCODE -ne 0) { throw 'Local NO-SEND migration failed; retain evidence and do not reset.' }
      & pnpm --dir packages/db exec prisma generate
    }
    'preview' {
      if ($Arguments.Count) { throw 'Preview arguments are fixed to the owned loopback endpoint.' }
      if ((Get-PSDrive C).Free -lt 5GB) { throw 'Defer preview: preserve the 5 GiB overnight disk reserve.' }
      & pnpm --dir apps/dashboard exec next dev --hostname 127.0.0.1 --port 58618
    }
  }
  $result = $LASTEXITCODE
} finally {
  Pop-Location
  Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:DIRECT_DATABASE_URL -ErrorAction SilentlyContinue
}
exit $result
