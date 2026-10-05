<#
.SYNOPSIS  Copy the sidecar jar and vetted drivers into src-tauri/resources/sidecar, verifying manifest checksums.
#>
[CmdletBinding()]
param(
  [string]$Jar = (Join-Path $PSScriptRoot '..\..\..\services\jdbc\target\tabledb-jdbc.jar'),
  [string]$DriversDir = (Join-Path $PSScriptRoot '..\..\..\services\jdbc\drivers'),
  [string]$Output = (Join-Path $PSScriptRoot '..\src-tauri\resources\sidecar')
)
$ErrorActionPreference = 'Stop'
if (-not (Test-Path $Jar)) { throw "Sidecar jar not found: $Jar (build services/jdbc first)" }
$manifestPath = Join-Path $DriversDir 'manifest.json'
if (-not (Test-Path $manifestPath)) { throw "drivers/manifest.json not found in $DriversDir" }

$manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
$entries = if ($manifest -is [array]) { $manifest } elseif ($manifest.drivers) { $manifest.drivers } else { throw 'unrecognised manifest.json shape' }
foreach ($e in $entries) {
  $f = Join-Path $DriversDir $e.file
  if (-not (Test-Path $f)) { throw "Driver file missing: $($e.file)" }
  $h = (Get-FileHash $f -Algorithm SHA256).Hash.ToLower()
  if ($h -ne ([string]$e.sha256).ToLower()) { throw "SHA-256 mismatch for $($e.file): manifest $($e.sha256) actual $h" }
  Write-Host "ok  $($e.type) $($e.file)"
}

Get-ChildItem $Output -Force -ErrorAction SilentlyContinue | Where-Object Name -ne '.gitkeep' | Remove-Item -Recurse -Force
New-Item -ItemType Directory -Force -Path (Join-Path $Output 'drivers') | Out-Null
Copy-Item $Jar (Join-Path $Output 'tabledb-jdbc.jar')
Copy-Item (Join-Path $DriversDir '*') (Join-Path $Output 'drivers') -Recurse
Write-Host "Staged sidecar into $Output"
