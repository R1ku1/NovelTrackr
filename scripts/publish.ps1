<#
.SYNOPSIS
Publishes the Noveltrackr Chrome extension through the Chrome Web Store API v2.

.DESCRIPTION
Validates extension/, builds a store-compatible zip, mints a short-lived access
token with gcloud service-account impersonation, uploads the package, waits for
Google to process it, asks for confirmation, and then submits it for publication.

No service-account JSON key or OAuth client is used. The machine must have the
Google Cloud CLI installed and authenticated as awesomeagent80@gmail.com.

.PARAMETER PackageOnly
Validate and build extension.zip in the repository root. No gcloud or network calls.

.PARAMETER StatusOnly
Validate gcloud auth and print the current store versions. No upload or publish.

.PARAMETER UploadOnly
Build and upload, then stop before publication. This is a write operation.

.PARAMETER KeepZip
Keep the temporary upload zip. -PackageOnly always keeps extension.zip.

.PARAMETER MaxWaitSeconds
How long to wait for Google to finish processing an upload. Default: 180.

.PARAMETER PollSeconds
Seconds between status checks while processing. Default: 3.

.EXAMPLE
.\scripts\publish.ps1 -PackageOnly

.EXAMPLE
.\scripts\publish.ps1 -StatusOnly

.EXAMPLE
.\scripts\publish.ps1

.NOTES
Setup: docs/publishing.md
#>
[CmdletBinding()]
param(
  [switch]$PackageOnly,
  [switch]$StatusOnly,
  [switch]$UploadOnly,
  [switch]$KeepZip,
  [ValidateRange(1, 3600)][int]$MaxWaitSeconds = 180,
  [ValidateRange(1, 60)][int]$PollSeconds = 3
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Public identifiers for this listing. They are not secrets.
$PublisherId = "7357b543-b9dc-44f2-b761-d95e1dbb8175"
$ExtensionId = "fpopdhhcjefmejigbgnjeknkbloolcfb"
$ProjectId = "noveltrackr"
$ServiceAccount = "riku-796@noveltrackr.iam.gserviceaccount.com"
$ExpectedAccount = "awesomeagent80@gmail.com"
$Scope = "https://www.googleapis.com/auth/chromewebstore"
$ApiBase = "https://chromewebstore.googleapis.com"
$ItemName = "publishers/$PublisherId/items/$ExtensionId"

$RepoRoot = Split-Path -Parent $PSScriptRoot
$ExtensionDir = Join-Path $RepoRoot "extension"
$ManifestPath = Join-Path $ExtensionDir "manifest.json"
$PackagePath = Join-Path $RepoRoot "extension.zip"

$script:TempZip = $null
$script:ExitCode = 0

function Write-Step([string]$Text) {
  Write-Host ""
  Write-Host "== $Text ==" -ForegroundColor Cyan
}

function Get-Property {
  param($Object, [string]$Name, $Default = $null)
  if ($null -eq $Object) { return $Default }
  $property = $Object.PSObject.Properties[$Name]
  if ($null -eq $property) { return $Default }
  return $property.Value
}

function Read-Manifest {
  if (-not (Test-Path -LiteralPath $ManifestPath -PathType Leaf)) {
    throw "manifest.json was not found at $ManifestPath."
  }

  try {
    $manifest = Get-Content -LiteralPath $ManifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
  }
  catch {
    throw "manifest.json is not valid JSON: $($_.Exception.Message)"
  }

  if ($manifest.manifest_version -ne 3) {
    throw "manifest.json must use manifest_version 3."
  }
  if (-not $manifest.name) {
    throw "manifest.json has no name."
  }
  if (-not $manifest.version) {
    throw "manifest.json has no version."
  }

  $version = [string]$manifest.version
  if ($version -notmatch '^\d+(\.\d+){0,3}$') {
    throw "Extension version '$version' is invalid. Use one to four dot-separated numbers."
  }
  foreach ($part in $version.Split('.')) {
    $number = [int]$part
    if ($number -lt 0 -or $number -gt 65535) {
      throw "Version component '$part' must be between 0 and 65535."
    }
  }

  return $manifest
}

function Get-RuntimeFiles($Manifest) {
  $files = New-Object System.Collections.Generic.List[string]

  function Add-RuntimeFile([string]$Relative) {
    if ([string]::IsNullOrWhiteSpace($Relative)) { return }

    $name = $Relative.Replace('\', '/').TrimStart('/')
    if ($name.StartsWith("./")) { $name = $name.Substring(2) }
    if ($name -match '(^|/)\.\.(/|$)' -or [System.IO.Path]::IsPathRooted($name)) {
      throw "manifest.json references an unsafe path: $Relative"
    }
    if ($files -notcontains $name) { $files.Add($name) }
  }

  Add-RuntimeFile "manifest.json"

  $background = Get-Property $Manifest "background" $null
  Add-RuntimeFile (Get-Property $background "service_worker" "")

  $action = Get-Property $Manifest "action" $null
  Add-RuntimeFile (Get-Property $action "default_popup" "")
  $defaultIcon = Get-Property $action "default_icon" $null
  if ($defaultIcon) {
    foreach ($property in $defaultIcon.PSObject.Properties) {
      Add-RuntimeFile ([string]$property.Value)
    }
  }

  $icons = Get-Property $Manifest "icons" $null
  if ($icons) {
    foreach ($property in $icons.PSObject.Properties) {
      Add-RuntimeFile ([string]$property.Value)
    }
  }

  $contentScripts = @(Get-Property $Manifest "content_scripts" @())
  foreach ($contentScript in $contentScripts) {
    if (-not $contentScript) { continue }
    foreach ($file in @(Get-Property $contentScript "js" @())) {
      Add-RuntimeFile ([string]$file)
    }
    foreach ($file in @(Get-Property $contentScript "css" @())) {
      Add-RuntimeFile ([string]$file)
    }
  }

  # popup.js is loaded by popup.html, not named in the manifest.
  $popupPath = Join-Path $ExtensionDir (Get-Property $action "default_popup" "")
  if (Test-Path -LiteralPath $popupPath -PathType Leaf) {
    $popupHtml = Get-Content -LiteralPath $popupPath -Raw -Encoding UTF8
    foreach ($match in [regex]::Matches($popupHtml, '(?i)(?:src|href)\s*=\s*["'']([^"'']+)["'']')) {
      $reference = $match.Groups[1].Value
      if ($reference -match '^(?:[a-z]+:|//|#|/)') { continue }
      $reference = ($reference -split '[?#]')[0]
      Add-RuntimeFile $reference
    }
  }

  # Runtime files that are not referenced from the manifest or popup HTML.
  foreach ($extra in @("sites/generic.js")) {
    if (Test-Path -LiteralPath (Join-Path $ExtensionDir $extra) -PathType Leaf) {
      Add-RuntimeFile $extra
    }
  }

  $resolved = @()
  $prefix = $ExtensionDir + [System.IO.Path]::DirectorySeparatorChar
  foreach ($name in $files) {
    $fullPath = [System.IO.Path]::GetFullPath((Join-Path $ExtensionDir $name))
    if (-not $fullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to package a path outside extension/: $name"
    }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
      throw "The extension references a missing file: $name"
    }
    $resolved += $name
  }

  return $resolved | Sort-Object
}

function New-ExtensionZip {
  param([string[]]$Files, [string]$ZipPath)

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem

  if (Test-Path -LiteralPath $ZipPath) {
    Remove-Item -LiteralPath $ZipPath -Force
  }

  $stream = [System.IO.File]::Open(
    $ZipPath,
    [System.IO.FileMode]::CreateNew,
    [System.IO.FileAccess]::ReadWrite,
    [System.IO.FileShare]::None
  )

  try {
    $archive = New-Object System.IO.Compression.ZipArchive -ArgumentList @(
      $stream,
      [System.IO.Compression.ZipArchiveMode]::Create,
      $true
    )
    try {
      foreach ($relative in $Files) {
        $entry = $archive.CreateEntry(
          $relative.Replace('\', '/'),
          [System.IO.Compression.CompressionLevel]::Optimal
        )
        $entryStream = $entry.Open()
        try {
          $source = [System.IO.File]::OpenRead((Join-Path $ExtensionDir $relative))
          try {
            $source.CopyTo($entryStream)
          }
          finally {
            $source.Dispose()
          }
        }
        finally {
          $entryStream.Dispose()
        }
      }
    }
    finally {
      $archive.Dispose()
    }
  }
  finally {
    $stream.Dispose()
  }
}

function Test-ExtensionZip([string]$ZipPath) {
  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem

  $archive = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    $names = @($archive.Entries | ForEach-Object { $_.FullName })

    if ($names -notcontains "manifest.json") {
      throw "The package is invalid: manifest.json is not at the archive root."
    }

    foreach ($name in $names) {
      if ($name -match '\\') {
        throw "The package is invalid: entry '$name' uses backslashes."
      }
      if ($name -match '(^|/)(selfcheck\.mjs|node_modules|\.git)(/|$)') {
        throw "The package contains a development file: $name"
      }
    }

    Write-Host "Package verified: $($names.Count) files, manifest.json at the root."
    foreach ($name in $names) { Write-Host "  $name" -ForegroundColor DarkGray }
  }
  finally {
    $archive.Dispose()
  }
}

function Resolve-Gcloud {
  $command = Get-Command gcloud -ErrorAction SilentlyContinue
  if ($command) {
    if ($command.Source) { return $command.Source }
    return "gcloud"
  }

  $candidates = @(
    (Join-Path $env:LOCALAPPDATA "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd"),
    (Join-Path $env:ProgramFiles "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd")
  )
  if (${env:ProgramFiles(x86)}) {
    $candidates += (Join-Path ${env:ProgramFiles(x86)} "Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd")
  }

  foreach ($candidate in $candidates) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }

  throw "gcloud was not found. Install the Google Cloud CLI and sign in: https://cloud.google.com/sdk/docs/install"
}

function Assert-GcloudAuth([string]$Gcloud) {
  # Collect the native command output before filtering: piping it into
  # Select-Object -First 1 stops the native pipeline early and leaves
  # $LASTEXITCODE at -1 even when gcloud succeeded.
  $accounts = @(& $Gcloud auth list --filter=status:ACTIVE --format="value(account)" 2>$null)
  if ($LASTEXITCODE -ne 0 -or $accounts.Count -eq 0) {
    throw "gcloud is not authenticated. Run: gcloud auth login $ExpectedAccount"
  }

  $account = ([string]($accounts | Where-Object { $_ } | Select-Object -First 1)).Trim()
  if (-not $account) {
    throw "gcloud is not authenticated. Run: gcloud auth login $ExpectedAccount"
  }
  if ($account -ne $ExpectedAccount) {
    throw "gcloud is signed in as '$account', but this script expects '$ExpectedAccount'. Run: gcloud auth login $ExpectedAccount"
  }
  Write-Host "gcloud account: $account"

  $projects = @(& $Gcloud config get-value project 2>$null)
  $project = [string]($projects | Where-Object { $_ } | Select-Object -First 1)
  if ($project -and $project.Trim() -ne $ProjectId) {
    Write-Warning "gcloud project is '$($project.Trim())', not '$ProjectId'. The token command does not depend on it."
  }
}

function Get-AccessToken([string]$Gcloud) {
  $token = & $Gcloud auth print-access-token --impersonate-service-account=$ServiceAccount --scopes=$Scope
  if ($LASTEXITCODE -ne 0) {
    throw "gcloud could not mint a token. Confirm that $ExpectedAccount has Service Account Token Creator on $ServiceAccount."
  }

  $token = ($token | Out-String).Trim()
  if (-not $token -or $token -match '\s' -or $token.Length -lt 20) {
    throw "gcloud returned an unexpected token value."
  }

  Write-Host "Access token acquired (value not displayed)." -ForegroundColor DarkGray
  return $token
}

function Invoke-WebStore {
  param(
    [Parameter(Mandatory = $true)][string]$Method,
    [Parameter(Mandatory = $true)][string]$Uri,
    [Parameter(Mandatory = $true)][string]$Token,
    [string]$InFile,
    [string]$JsonBody,
    [int]$TimeoutSec = 120
  )

  $parameters = @{
    Method = $Method
    Uri = $Uri
    Headers = @{ Authorization = "Bearer $Token" }
    TimeoutSec = $TimeoutSec
    UseBasicParsing = $true
  }
  if ($InFile) {
    $parameters.InFile = $InFile
    $parameters.ContentType = "application/zip"
  }
  elseif ($JsonBody) {
    $parameters.Body = $JsonBody
    $parameters.ContentType = "application/json"
  }

  try {
    return Invoke-RestMethod @parameters
  }
  catch {
    $statusCode = $null
    if ($_.Exception.Response) {
      try { $statusCode = [int]$_.Exception.Response.StatusCode } catch { }
    }

    $detail = $_.ErrorDetails.Message
    if (-not $detail) { $detail = $_.Exception.Message }

    $hint = ""
    if ($statusCode -eq 401) {
      $hint = " The access token was rejected. Check the gcloud account and impersonation permission."
    }
    elseif ($statusCode -eq 403) {
      $hint = " Permission denied. Confirm $ServiceAccount is added under Account in the Chrome Web Store Developer Dashboard, and that it owns $ExtensionId."
    }
    elseif ($statusCode -eq 404) {
      $hint = " The publisher ID or extension ID was not found."
    }

    throw "Chrome Web Store API $Method failed (HTTP $statusCode): $detail$hint"
  }
}

function Get-StoreStatus([string]$Token) {
  return Invoke-WebStore -Method Get -Uri "$ApiBase/v2/$($ItemName):fetchStatus" -Token $Token -TimeoutSec 60
}

function Show-StoreStatus($Status) {
  $published = Get-Property $Status "publishedItemRevisionStatus" $null
  $submitted = Get-Property $Status "submittedItemRevisionStatus" $null

  $publishedVersion = "none"
  $publishedState = "unknown"
  $publishedChannels = @(Get-Property $published "distributionChannels" @())
  if ($publishedChannels.Count -gt 0) {
    $publishedVersion = [string](Get-Property $publishedChannels[0] "crxVersion" "unknown")
    $publishedState = [string](Get-Property $published "state" "unknown")
  }

  $submittedVersion = "none"
  $submittedState = "unknown"
  $submittedChannels = @(Get-Property $submitted "distributionChannels" @())
  if ($submittedChannels.Count -gt 0) {
    $submittedVersion = [string](Get-Property $submittedChannels[0] "crxVersion" "unknown")
    $submittedState = [string](Get-Property $submitted "state" "unknown")
  }

  Write-Host "Published version: $publishedVersion ($publishedState)"
  Write-Host "Submitted version: $submittedVersion ($submittedState)"
  Write-Host "Last upload state: $(Get-Property $Status 'lastAsyncUploadState' 'unknown')"

  if (Get-Property $Status "takenDown" $false) {
    Write-Warning "The Chrome Web Store item is taken down."
  }
  if (Get-Property $Status "warned" $false) {
    Write-Warning "The Chrome Web Store item has warnings."
  }

  return [pscustomobject]@{
    Published = $publishedVersion
    Submitted = $submittedVersion
  }
}

function Try-ParseVersion([string]$Text) {
  if (-not $Text -or $Text -eq "none") { return $null }
  try {
    return [version]$Text
  }
  catch {
    return $null
  }
}

function Assert-VersionCanPublish([string]$Version, $StatusInfo) {
  $next = [version]$Version

  $published = Try-ParseVersion $StatusInfo.Published
  if ($published) {
    $comparison = $next.CompareTo($published)
    if ($comparison -eq 0) {
      throw "Version $Version is already published. Bump extension/manifest.json before publishing."
    }
    if ($comparison -lt 0) {
      throw "Version $Version is lower than the published version $($StatusInfo.Published)."
    }
  }

  $submitted = Try-ParseVersion $StatusInfo.Submitted
  if ($submitted) {
    $comparison = $next.CompareTo($submitted)
    if ($comparison -eq 0) {
      throw "Version $Version is already submitted for review. Bump extension/manifest.json before submitting again."
    }
    if ($comparison -lt 0) {
      throw "Version $Version is lower than the submitted version $($StatusInfo.Submitted)."
    }
  }
}

function Wait-ForUpload {
  param([string]$Token, $Upload, [string]$Version)

  $state = [string](Get-Property $Upload "uploadState" "unknown")
  $reportedVersion = [string](Get-Property $Upload "crxVersion" "")
  if ($reportedVersion -and $reportedVersion -ne $Version) {
    throw "Google reported uploaded version '$reportedVersion', but the manifest says '$Version'."
  }
  if ($state -eq "UPLOAD_FAILED") {
    throw "Google reported the upload as failed. Nothing was published."
  }
  if ($state -ne "UPLOAD_IN_PROGRESS") {
    return
  }

  Write-Host "Google is still processing the upload; waiting up to $MaxWaitSeconds seconds..."
  $deadline = (Get-Date).AddSeconds($MaxWaitSeconds)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds $PollSeconds
    $status = Get-StoreStatus $Token
    $lastState = [string](Get-Property $status "lastAsyncUploadState" "")

    if ($lastState -eq "UPLOAD_FAILED") {
      throw "Google reported the upload as failed. Nothing was published."
    }
    if ($lastState -and $lastState -ne "UPLOAD_IN_PROGRESS") {
      Write-Host "Upload finished: $lastState"
      return
    }

    $submitted = Get-Property $status "submittedItemRevisionStatus" $null
    $channels = @(Get-Property $submitted "distributionChannels" @())
    if ($channels.Count -gt 0) {
      $submittedVersion = [string](Get-Property $channels[0] "crxVersion" "")
      if ($submittedVersion -eq $Version) {
        Write-Host "Upload processed (version $Version)."
        return
      }
    }
  }

  throw "The upload is still processing after $MaxWaitSeconds seconds. Nothing was published; check the Developer Dashboard."
}

function Invoke-Main {
  Write-Step "Validating extension"
  $manifest = Read-Manifest
  $version = [string]$manifest.version
  $runtimeFiles = @(Get-RuntimeFiles $manifest)

  if ($runtimeFiles.Count -eq 0) {
    throw "No runtime files were found to package."
  }
  Write-Host "Extension version: $version"
  Write-Host "Runtime files: $($runtimeFiles.Count)"

  if ($PackageOnly) {
    New-ExtensionZip -Files $runtimeFiles -ZipPath $PackagePath
    Test-ExtensionZip $PackagePath
    Write-Host "Package written to $PackagePath" -ForegroundColor Green
    return
  }

  Write-Step "Checking gcloud"
  $gcloud = Resolve-Gcloud
  Assert-GcloudAuth $gcloud
  $token = Get-AccessToken $gcloud

  Write-Step "Current store status"
  $status = Get-StoreStatus $token
  $statusInfo = Show-StoreStatus $status

  if ($StatusOnly) {
    return
  }

  Assert-VersionCanPublish $version $statusInfo

  Write-Step "Packaging"
  $script:TempZip = Join-Path ([System.IO.Path]::GetTempPath()) (
    "noveltrackr-extension-" + $version + "-" + [guid]::NewGuid().ToString("N") + ".zip"
  )
  New-ExtensionZip -Files $runtimeFiles -ZipPath $script:TempZip
  Test-ExtensionZip $script:TempZip

  Write-Step "Uploading version $version"
  $upload = Invoke-WebStore `
    -Method Post `
    -Uri "$ApiBase/upload/v2/$($ItemName):upload" `
    -Token $token `
    -InFile $script:TempZip `
    -TimeoutSec 300

  $reportedVersion = [string](Get-Property $upload "crxVersion" "")
  $uploadState = [string](Get-Property $upload "uploadState" "unknown")
  $versionLabel = "not reported yet"
  if ($reportedVersion) { $versionLabel = $reportedVersion }
  Write-Host "Upload response: version '$versionLabel', state '$uploadState'"

  Wait-ForUpload -Token $token -Upload $upload -Version $version

  Write-Step "Post-upload status"
  $status = Get-StoreStatus $token
  Show-StoreStatus $status | Out-Null

  if ($UploadOnly) {
    Write-Host ""
    Write-Host "Upload-only mode: the new revision was not published." -ForegroundColor Yellow
    return
  }

  Write-Step "Confirm publication"
  Write-Host "Version $version is uploaded and processed."
  Write-Host "Publishing submits it to Google for review. Approval is not guaranteed."
  $answer = Read-Host "Type 'publish' to submit version $version (anything else cancels)"
  if (-not $answer -or $answer.Trim() -ne "publish") {
    Write-Host "Cancelled. The upload remains, but nothing was published." -ForegroundColor Yellow
    return
  }

  Write-Step "Submitting for publication"
  $result = Invoke-WebStore `
    -Method Post `
    -Uri "$ApiBase/v2/$($ItemName):publish" `
    -Token $token `
    -JsonBody '{"publishType":"DEFAULT_PUBLISH"}' `
    -TimeoutSec 120

  $state = [string](Get-Property $result "state" "unknown")
  Write-Host "Submission accepted. State: $state" -ForegroundColor Green

  $warningInfo = Get-Property $result "warningInfo" $null
  foreach ($warning in @(Get-Property $warningInfo "warnings" @())) {
    if ($warning) {
      Write-Warning ("{0}: {1}" -f (Get-Property $warning "reason" "warning"), (Get-Property $warning "description" ""))
    }
  }

  Write-Step "Final status"
  $finalStatus = Get-StoreStatus $token
  Show-StoreStatus $finalStatus | Out-Null
  Write-Host ""
  Write-Host "The submission was accepted; this is not approval. Google may review it before it goes live." -ForegroundColor Yellow
  Write-Host "Check the Chrome Web Store Developer Dashboard for the review result."
}

$oldPrompts = $env:CLOUDSDK_CORE_DISABLE_PROMPTS
$env:CLOUDSDK_CORE_DISABLE_PROMPTS = "1"

try {
  $modeCount = 0
  if ($PackageOnly) { $modeCount++ }
  if ($StatusOnly) { $modeCount++ }
  if ($UploadOnly) { $modeCount++ }
  if ($modeCount -gt 1) {
    throw "Choose only one of -PackageOnly, -StatusOnly, or -UploadOnly."
  }

  Invoke-Main
}
catch {
  Write-Host ""
  Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
  $script:ExitCode = 1
}
finally {
  if ($script:TempZip -and (Test-Path -LiteralPath $script:TempZip)) {
    if ($KeepZip) {
      Write-Host "Kept temporary package: $script:TempZip" -ForegroundColor DarkGray
    }
    else {
      Remove-Item -LiteralPath $script:TempZip -Force -ErrorAction SilentlyContinue
    }
  }

  if ($null -eq $oldPrompts) {
    Remove-Item Env:\CLOUDSDK_CORE_DISABLE_PROMPTS -ErrorAction SilentlyContinue
  }
  else {
    $env:CLOUDSDK_CORE_DISABLE_PROMPTS = $oldPrompts
  }
}

exit $script:ExitCode
