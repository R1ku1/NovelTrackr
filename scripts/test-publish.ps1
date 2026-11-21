<#
.SYNOPSIS
Tests scripts/publish.ps1 without gcloud or network access.

.DESCRIPTION
Runs the packaging and validation paths in a temporary copy of the repository:
valid packaging, invalid versions, missing referenced files, and unsafe manifest paths.
#>
[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$SourceScript = Join-Path $PSScriptRoot "publish.ps1"
$SourceExtension = Join-Path $RepoRoot "extension"
$TempRoot = Join-Path ([IO.Path]::GetTempPath()) ("noveltrackr-publish-tests-" + [guid]::NewGuid().ToString("N"))

$tempExtension = ""
$manifestPath = ""
$originalManifest = ""

function Assert-True([bool]$Condition, [string]$Message) {
  if (-not $Condition) { throw $Message }
}

function Assert-Match([string]$Text, [string]$Pattern, [string]$Message) {
  if ($Text -notmatch $Pattern) {
    throw "$Message`nActual output:`n$Text"
  }
}

function Invoke-Publish([string[]]$Arguments) {
  $output = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $TempRoot "scripts\publish.ps1") @Arguments 2>&1
  $code = $LASTEXITCODE
  return [pscustomobject]@{
    ExitCode = $code
    Output = ($output | Out-String)
  }
}

function Reset-Manifest {
  Set-Content -LiteralPath $manifestPath -Value $originalManifest -Encoding UTF8
}

function Copy-RuntimeFile([string]$Name) {
  Copy-Item -LiteralPath (Join-Path $SourceExtension $Name) -Destination (Join-Path $tempExtension $Name) -Force
}

try {
  New-Item -ItemType Directory -Path (Join-Path $TempRoot "scripts") -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $TempRoot "extension") -Force | Out-Null
  Copy-Item -LiteralPath $SourceScript -Destination (Join-Path $TempRoot "scripts\publish.ps1") -Force
  Copy-Item -Path (Join-Path $SourceExtension "*") -Destination (Join-Path $TempRoot "extension") -Recurse -Force

  $tempExtension = Join-Path $TempRoot "extension"
  $manifestPath = Join-Path $tempExtension "manifest.json"
  $originalManifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8

  # 1. Packaging succeeds and produces the expected archive.
  $result = Invoke-Publish @("-PackageOnly")
  Assert-True ($result.ExitCode -eq 0) "PackageOnly failed:`n$($result.Output)"

  $zipPath = Join-Path $TempRoot "extension.zip"
  Assert-True (Test-Path -LiteralPath $zipPath -PathType Leaf) "extension.zip was not created."

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $archive = [System.IO.Compression.ZipFile]::OpenRead($zipPath)
  try {
    $names = @($archive.Entries | ForEach-Object { $_.FullName })
  }
  finally {
    $archive.Dispose()
  }

  Assert-True ($names -contains "manifest.json") "manifest.json is not at the archive root."
  Assert-True (-not ($names | Where-Object { $_ -match '\\' })) "The archive contains backslash entry names."
  Assert-True (-not ($names -contains "selfcheck.mjs")) "selfcheck.mjs leaked into the package."
  Assert-True ($names -contains "popup.js") "popup.js is missing from the package."
  Assert-True ($names -contains "icons/icon128.png") "icons/icon128.png is missing from the package."
  Write-Host "ok  package layout"

  # 2. An invalid version is rejected before packaging.
  $manifest = $originalManifest | ConvertFrom-Json
  $manifest.version = "1.4.x"
  $manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  $result = Invoke-Publish @("-PackageOnly")
  Assert-True ($result.ExitCode -ne 0) "An invalid version was accepted."
  Assert-Match $result.Output "invalid" "The invalid-version error was not reported."
  Reset-Manifest
  Write-Host "ok  invalid version rejected"

  # 3. A missing referenced file is rejected.
  Remove-Item -LiteralPath (Join-Path $tempExtension "background.js") -Force
  $result = Invoke-Publish @("-PackageOnly")
  Assert-True ($result.ExitCode -ne 0) "A missing referenced file was accepted."
  Assert-Match $result.Output "missing file" "The missing-file error was not reported."
  Copy-RuntimeFile "background.js"
  Reset-Manifest
  Write-Host "ok  missing file rejected"

  # 4. A path outside extension/ is rejected.
  $manifest = $originalManifest | ConvertFrom-Json
  $manifest.content_scripts[0].js = @("../outside.js")
  $manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  $result = Invoke-Publish @("-PackageOnly")
  Assert-True ($result.ExitCode -ne 0) "An unsafe path was accepted."
  Assert-Match $result.Output "unsafe path" "The unsafe-path error was not reported."
  Reset-Manifest
  Write-Host "ok  unsafe path rejected"

  # 5. The unmodified extension still packages after the test mutations.
  Reset-Manifest
  Copy-RuntimeFile "background.js"
  $result = Invoke-Publish @("-PackageOnly")
  Assert-True ($result.ExitCode -eq 0) "Packaging the unmodified extension failed:`n$($result.Output)"
  Write-Host "ok  unmodified extension still packages"

  Write-Host ""
  Write-Host "All publish-script checks passed."
}
finally {
  if (Test-Path -LiteralPath $TempRoot) {
    Remove-Item -LiteralPath $TempRoot -Recurse -Force -ErrorAction SilentlyContinue
  }
}
