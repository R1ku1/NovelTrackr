<#
.SYNOPSIS
Builds the latest.json asset the desktop app checks for updates.

.DESCRIPTION
Hashes the chosen installer with SHA-256 and writes the small manifest the app
fetches from the latest GitHub release. The installer must be uploaded under the
matching v<version> tag before the app can download it.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][string]$Installer,
  [string]$Notes = "",
  [string]$Output = "latest.json"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($Version -notmatch '^\d+(\.\d+){0,3}$') {
  throw "Version '$Version' is invalid. Use one to four dot-separated numbers."
}
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) {
  throw "Installer not found: $Installer"
}

$installerPath = (Resolve-Path -LiteralPath $Installer).Path
$fileName = Split-Path -Leaf $installerPath
if ($fileName -notmatch '\.(exe|msi)$') {
  throw "The installer must be an .exe or .msi file."
}

$hash = (Get-FileHash -LiteralPath $installerPath -Algorithm SHA256).Hash.ToLowerInvariant()
$size = (Get-Item -LiteralPath $installerPath).Length
$encodedName = [System.Uri]::EscapeDataString($fileName)
$url = "https://github.com/R1ku1/NovelTrackr/releases/download/v$Version/$encodedName"

$manifest = [ordered]@{
  version       = $Version
  notes         = $Notes
  installer_url = $url
  sha256        = $hash
  size          = $size
  published_at  = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
}

$json = $manifest | ConvertTo-Json
$utf8 = New-Object System.Text.UTF8Encoding($false)
[System.IO.File]::WriteAllText(
  [System.IO.Path]::GetFullPath($Output),
  $json + [Environment]::NewLine,
  $utf8
)

Write-Host "Wrote $Output"
Write-Host "  version: $Version"
Write-Host "  sha256:  $hash"
Write-Host "  size:    $size"
Write-Host "  url:     $url"
