param(
  [Parameter(Mandatory = $true)][string]$Source,
  [Parameter(Mandatory = $true)][string]$Destination
)

# Builds the store zip with manifest.json at the root. Compress-Archive writes
# backslashes into entry names on Windows, which the Web Store does not expect,
# so entries are created explicitly with forward slashes.
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$source = (Resolve-Path -LiteralPath $Source).Path
$destination = [System.IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $destination) {
  Remove-Item -LiteralPath $destination -Force
}

$zip = [System.IO.Compression.ZipFile]::Open(
  $destination,
  [System.IO.Compression.ZipArchiveMode]::Create
)

try {
  Get-ChildItem -LiteralPath $source -Recurse -File |
    Where-Object { $_.Name -ne 'selfcheck.mjs' } |
    Sort-Object FullName |
    ForEach-Object {
      $name = $_.FullName.Substring($source.Length + 1).Replace('\', '/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $zip,
        $_.FullName,
        $name,
        [System.IO.Compression.CompressionLevel]::Optimal
      ) | Out-Null
    }
}
finally {
  $zip.Dispose()
}

Write-Host "Wrote $destination"
