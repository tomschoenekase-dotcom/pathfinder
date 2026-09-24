param(
  [Parameter(Mandatory=$true)][ValidateSet('start','stop','status')][string]$Mode,
  [Parameter(Mandatory=$true)][string]$ReceiptDirectory,
  [switch]$EnableSyntheticRehearsal
)
$ErrorActionPreference = 'Stop'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$allowed = @('artifacts\crm-meaning-review-20260921-r001','artifacts\crm-evidence-admission-20260921-r001','artifacts\crm-first-send-20260921-r001') | ForEach-Object { [IO.Path]::GetFullPath((Join-Path $root $_)) + '\' }
$directory = [IO.Path]::GetFullPath($ReceiptDirectory)
if (-not @($allowed | Where-Object { ($directory + '\').StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }).Count) {
  throw 'Use a receipt directory inside this worktree meaning-review or evidence-admission artifacts.'
}
$receiptPath = Join-Path $directory 'preview-owner.json'
$launcher = Join-Path $root 'scripts\run-local-crm-research.ps1'
if ($Mode -eq 'start') {
  if (Test-Path $directory) { throw 'Use a new create-only preview receipt directory.' }
  if ((Get-PSDrive C).Free -lt 6.5GB) { throw 'Defer dev preview: retain the 5 GiB reserve plus compilation margin.' }
  if ((Get-CimInstance Win32_OperatingSystem).FreePhysicalMemory -lt 4MB) { throw 'Defer preview: retain at least 4 GiB available memory.' }
  if (Get-NetTCPConnection -State Listen -LocalPort 58618 -ErrorAction SilentlyContinue) {
    throw 'Port 58618 already has an owner. Do not replace or close it.'
  }
  New-Item -ItemType Directory -Path $directory | Out-Null
  Copy-Item -LiteralPath (Join-Path $root 'apps\dashboard\next-env.d.ts') -Destination (Join-Path $directory 'next-env.before.txt')
  Copy-Item -LiteralPath (Join-Path $root 'apps\dashboard\tsconfig.json') -Destination (Join-Path $directory 'tsconfig.before.txt')
  $startArgs = @('-NoProfile','-File',$launcher,'-Mode','preview','-EnableSalesPreparation')
  if ($EnableSyntheticRehearsal) { $startArgs += '-EnableSyntheticRehearsal' }
  $process = Start-Process powershell.exe -ArgumentList $startArgs `
    -WorkingDirectory $root -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $directory 'preview.stdout.log') `
    -RedirectStandardError (Join-Path $directory 'preview.stderr.log')
  $process.Refresh()
  $receipt = [ordered]@{ schema='torchiko.owned-meaning-preview/1'; rootPid=$process.Id;
    startFileTimeUtc=[string]$process.StartTime.ToFileTimeUtc(); worktree=$root; launcher=$launcher;
    createdAt=(Get-Date).ToUniversalTime().ToString('o'); syntheticRehearsal=[bool]$EnableSyntheticRehearsal;
    freeDiskGiB=[math]::Round((Get-PSDrive C).Free/1GB,3); SEND_AUTHORIZED=$false }
  $receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $receiptPath -Encoding UTF8
  $receipt | ConvertTo-Json -Compress
  exit 0
}
if (-not (Test-Path $receiptPath)) { throw 'No owned preview receipt exists; do not infer process ownership.' }
$receipt = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
if ($receipt.schema -ne 'torchiko.owned-meaning-preview/1' -or $receipt.worktree -ne $root -or $receipt.launcher -ne $launcher) {
  throw 'Receipt does not identify this exact owned worktree preview.'
}
$process = Get-Process -Id $receipt.rootPid -ErrorAction SilentlyContinue
if (-not $process) {
  [pscustomobject]@{rootPid=$receipt.rootPid;rootRunning=$false;action='NO_PROCESS_CLOSED';SEND_AUTHORIZED=$false}|ConvertTo-Json -Compress
  exit 0
}
if ([string]$process.StartTime.ToFileTimeUtc() -ne [string]$receipt.startFileTimeUtc) {
  throw 'PID was reused. No process will be closed.'
}
$rootInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$($receipt.rootPid)"
if ($rootInfo.CommandLine -notlike "*$launcher*" -or $rootInfo.CommandLine -notlike '*-EnableSalesPreparation*') {
  throw 'Current command does not match the recorded preview. No process will be closed.'
}
$all = @(Get-CimInstance Win32_Process)
$byId = @{}
foreach ($entry in $all) { $byId[[int]$entry.ProcessId] = $entry }
$ids = New-Object 'System.Collections.Generic.HashSet[int]'
[void]$ids.Add([int]$receipt.rootPid)
do {
  $changed = $false
  foreach ($entry in $all) {
    # ParentProcessId can refer to a recycled PID. An older process is not a
    # descendant of this new preview, even when its stale parent number matches.
    $parent = $byId[[int]$entry.ParentProcessId]
    if ($parent -and $ids.Contains([int]$entry.ParentProcessId) -and
        $entry.CreationDate -ge $parent.CreationDate -and
        $entry.CreationDate -ge $rootInfo.CreationDate -and
        $ids.Add([int]$entry.ProcessId)) { $changed=$true }
  }
} while ($changed)
$owned = @($all | Where-Object {$ids.Contains([int]$_.ProcessId)} | Select-Object ProcessId,ParentProcessId,Name,CreationDate)
if ($Mode -eq 'status') {
  [pscustomobject]@{rootPid=$receipt.rootPid;rootRunning=$true;owned=$owned;freeDiskGiB=[math]::Round((Get-PSDrive C).Free/1GB,3)} | ConvertTo-Json -Depth 5
  exit 0
}
$stopReceipt = Join-Path $directory 'preview-stopped.json'
if (Test-Path $stopReceipt) { throw 'A stop receipt is already retained. Do not overwrite it.' }
# Only the exact PID/start-time/command verified above and its current descendants.
$closed = & taskkill.exe /PID $receipt.rootPid /T /F 2>&1
if ($LASTEXITCODE -ne 0) { throw "Owned preview stop failed: $closed" }
$left = @(Get-NetTCPConnection -State Listen -LocalPort 58618 -ErrorAction SilentlyContinue | Select-Object LocalAddress,LocalPort,OwningProcess)
$result = [ordered]@{ schema='torchiko.owned-meaning-preview-stop/1'; stoppedAt=(Get-Date).ToUniversalTime().ToString('o');
  rootPid=$receipt.rootPid;verifiedStartFileTimeUtc=$receipt.startFileTimeUtc;ownedProcesses=$owned;
  commandOutput=@($closed | ForEach-Object {"$_"});remainingPort58618=$left;
  freeDiskGiB=[math]::Round((Get-PSDrive C).Free/1GB,3);databaseIntentionallyLeftRunning=$true;SEND_AUTHORIZED=$false }
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $stopReceipt -Encoding UTF8
$result | ConvertTo-Json -Depth 6
if ($left.Count) { throw 'Port remains occupied after owned stop; do not close an unverified owner.' }
