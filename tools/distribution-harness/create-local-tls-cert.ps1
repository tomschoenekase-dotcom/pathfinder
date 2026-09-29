param(
  [Parameter(Mandatory = $true)]
  [string] $OutputPath,
  [string] $Password = 'distribution-fixture-only'
)

$ErrorActionPreference = 'Stop'
$resolvedOutput = [System.IO.Path]::GetFullPath($OutputPath)
$parent = [System.IO.Path]::GetDirectoryName($resolvedOutput)
New-Item -ItemType Directory -Force -Path $parent | Out-Null

$certificate = New-SelfSignedCertificate `
  -Subject 'CN=localhost' `
  -TextExtension @('2.5.29.17={text}DNS=localhost&IPAddress=127.0.0.1') `
  -CertStoreLocation 'Cert:\CurrentUser\My' `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -KeyExportPolicy Exportable `
  -NotAfter (Get-Date).AddDays(7) `
  -FriendlyName 'Torchiko Distribution RC-1 local HTTPS fixture'

# This is a synthetic, task-local test certificate. The file stays under the
# external task-root tmp directory and is never added to the repository.
$pfxPassword = ConvertTo-SecureString -String $Password -Force -AsPlainText
Export-PfxCertificate -Cert $certificate -FilePath $resolvedOutput -Password $pfxPassword | Out-Null
Write-Output "Created local test certificate at $resolvedOutput (thumbprint $($certificate.Thumbprint))."
