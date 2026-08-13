[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$OutputDirectory
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$projectRef = 'zpacmfkomonxeqdiadtz'
$databaseHost = 'aws-1-us-east-2.pooler.supabase.com'
$databaseUser = "postgres.$projectRef"
$databaseName = 'postgres'
$clientImage = 'pgvector/pgvector:0.8.0-pg17'
$containerBackupDirectory = '/backup'

$resolvedOutputDirectory = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Path $resolvedOutputDirectory -Force | Out-Null

$timestamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddTHHmmssZ')
$archiveName = "pathfinder-$projectRef-$timestamp.dump"
$archivePath = Join-Path $resolvedOutputDirectory $archiveName
$listingPath = "$archivePath.list.txt"
$manifestPath = "$archivePath.manifest.json"

if (Test-Path -LiteralPath $archivePath) {
  throw "Refusing to overwrite existing backup: $archivePath"
}

$imageId = (& docker image inspect $clientImage --format '{{.Id}}').Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($imageId)) {
  throw "Required PostgreSQL 17/vector 0.8 client image is unavailable: $clientImage"
}

Write-Host 'A database-password prompt will appear next.'
Write-Host 'Enter the existing Supabase database password in this window; do not paste it into chat.'
Write-Host "Creating a read-only logical archive for project $projectRef..."

& docker run --rm -it `
  --mount "type=bind,source=$resolvedOutputDirectory,target=$containerBackupDirectory" `
  --env PGSSLMODE=require `
  $clientImage `
  pg_dump `
  --host=$databaseHost `
  --port=5432 `
  --username=$databaseUser `
  --dbname=$databaseName `
  --format=custom `
  --compress=9 `
  --serializable-deferrable `
  --lock-wait-timeout=10s `
  --verbose `
  --file="$containerBackupDirectory/$archiveName"

if ($LASTEXITCODE -ne 0) {
  throw 'pg_dump failed. No reset or other production-side change was attempted.'
}

$archive = Get-Item -LiteralPath $archivePath
if ($archive.Length -le 0) {
  throw 'pg_dump returned success but the archive is empty.'
}

$listing = & docker run --rm `
  --mount "type=bind,source=$resolvedOutputDirectory,target=$containerBackupDirectory,readonly" `
  $clientImage `
  pg_restore --list "$containerBackupDirectory/$archiveName"
if ($LASTEXITCODE -ne 0 -or $listing.Count -eq 0) {
  throw 'pg_restore could not read the completed archive.'
}
$listing | Set-Content -LiteralPath $listingPath -Encoding utf8

$hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
$manifest = [ordered]@{
  project_ref = $projectRef
  source_host = $databaseHost
  source_database = $databaseName
  source_user = $databaseUser
  created_at_utc = (Get-Date).ToUniversalTime().ToString('o')
  archive_file = $archive.Name
  archive_bytes = $archive.Length
  archive_sha256 = $hash
  archive_format = 'PostgreSQL custom'
  pg_client_image = $clientImage
  pg_client_image_id = $imageId
  ssl_required = $true
  consistent_snapshot = 'serializable-deferrable'
  lock_wait_timeout = '10s'
  archive_listing_file = (Split-Path -Leaf $listingPath)
  archive_listing_verified = $true
  production_mutations_performed = $false
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding utf8

Write-Host ''
Write-Host 'Logical backup completed and verified.'
Write-Host "Archive: $archivePath"
Write-Host "SHA-256: $hash"
Write-Host "Manifest: $manifestPath"
Write-Host 'Treat the archive as production-sensitive data.'
