<#
.SYNOPSIS  Full Windows desktop build: JRE (jlink) -> stage sidecar -> web dist -> tauri build (NSIS).
.DESCRIPTION
  Produces src-tauri\target\release\bundle\nsis\*.exe (+ .sig / latest.json inputs when updater signing is configured).
  The CSP in tauri.conf.json is static, so the API origin is injected here via a generated --config override.
.PARAMETER ApiOrigin        API base URL, e.g. https://10.23.5.40:8080/c/ (optional deployment path prefix)
.PARAMETER UpdaterPubkey    Public key from `tauri signer generate` (contents of the .pub file). Enables updater artifacts together with
                            $env:TAURI_SIGNING_PRIVATE_KEY (+ TAURI_SIGNING_PRIVATE_KEY_PASSWORD).
.PARAMETER UpdaterEndpoint  https URL template of the update manifest, e.g. https://updates.vnpay.vn/tabledb/{{target}}-{{arch}}/{{current_version}}
.PARAMETER CertThumbprint   SHA-1 thumbprint of a code-signing cert already imported in the Windows cert store. Omit = unsigned installer.
.PARAMETER TimestampUrl     RFC 3161 timestamp server used with signing.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ApiOrigin,
  [string]$UpdaterPubkey,
  [string]$UpdaterEndpoint,
  [string]$CertThumbprint,
  [string]$TimestampUrl = 'http://timestamp.digicert.com',
  [switch]$SkipJre, [switch]$SkipSidecar, [switch]$SkipWeb
)
$ErrorActionPreference = 'Stop'
$desk = Resolve-Path (Join-Path $PSScriptRoot '..')
$web = Resolve-Path (Join-Path $desk '..\web')
$apiUri = $null
if (-not [Uri]::TryCreate($ApiOrigin, [UriKind]::Absolute, [ref]$apiUri) -or
    $apiUri.Scheme -notin @('http', 'https') -or -not $apiUri.Host -or
    $apiUri.UserInfo -or $apiUri.Query -or $apiUri.Fragment -or $ApiOrigin -match '[\s;''"<>\\]') {
  throw 'ApiOrigin must be an HTTP(S) API base URL without credentials, query or fragment'
}
if ($apiUri.Scheme -eq 'http') {
  $apiIp = $null
  $privateIp = $false
  if ([Net.IPAddress]::TryParse($apiUri.Host, [ref]$apiIp) -and $apiIp.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork) {
    $octets = $apiIp.GetAddressBytes()
    $privateIp = $octets[0] -eq 10 -or ($octets[0] -eq 172 -and $octets[1] -ge 16 -and $octets[1] -le 31) -or ($octets[0] -eq 192 -and $octets[1] -eq 168)
  }
  if (-not $apiUri.IsLoopback -and -not $privateIp) { throw 'HTTP API base URL must use loopback or a private IP' }
}
$apiCspOrigin = $apiUri.GetLeftPart([UriPartial]::Authority)
# Pin the same deployment base into native code; never write addresses to local config.json.
$deploymentPath = Join-Path $desk 'src-tauri\deployment.json'
$deployment = Get-Content -Raw $deploymentPath | ConvertFrom-Json
$deployment.apiBaseUrl = $ApiOrigin
$deploymentJson = $deployment | ConvertTo-Json -Depth 10
[IO.File]::WriteAllText($deploymentPath, $deploymentJson, [Text.UTF8Encoding]::new($false))


if (-not $SkipJre)     { & (Join-Path $PSScriptRoot 'build-jre.ps1') }
if (-not $SkipSidecar) { & (Join-Path $PSScriptRoot 'stage-sidecar.ps1') }
if (-not $SkipWeb) {
  Push-Location $web
  try { npm ci; if ($LASTEXITCODE) { throw 'npm ci failed' }; npm run build:desktop; if ($LASTEXITCODE) { throw 'desktop frontend build failed' } } finally { Pop-Location }
}
if (-not (Test-Path (Join-Path $web 'dist\index.html'))) { throw 'apps/web/dist/index.html missing' }

$csp = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ipc: http://ipc.localhost $apiCspOrigin; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
$override = @{ app = @{ security = @{ csp = $csp } }; bundle = @{ windows = @{} } }
if ($CertThumbprint) {
  $override.bundle.windows = @{ certificateThumbprint = $CertThumbprint; digestAlgorithm = 'sha256'; timestampUrl = $TimestampUrl }
}
if ($UpdaterPubkey -and $env:TAURI_SIGNING_PRIVATE_KEY) {
  if (-not $UpdaterEndpoint -or $UpdaterEndpoint -notmatch '^https://') { throw 'UpdaterEndpoint (https) required with UpdaterPubkey' }
  $override.bundle.createUpdaterArtifacts = $true
  $override.plugins = @{ updater = @{ pubkey = $UpdaterPubkey; endpoints = @($UpdaterEndpoint); windows = @{ installMode = 'passive' } } }
} else {
  Write-Warning 'Updater artifacts NOT produced (need -UpdaterPubkey and TAURI_SIGNING_PRIVATE_KEY). The placeholder pubkey in tauri.conf.json is inert.'
}
$cfgFile = Join-Path ([IO.Path]::GetTempPath()) "tabledb-tauri-$([guid]::NewGuid().ToString('N')).json"
$override | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 $cfgFile

Push-Location $desk
try {
  if (-not (Test-Path 'node_modules\.bin\tauri.cmd')) { npm install; if ($LASTEXITCODE) { throw 'npm install failed' } }
  npx tauri build --bundles nsis --config $cfgFile
  if ($LASTEXITCODE) { throw 'tauri build failed' }
} finally { Pop-Location; Remove-Item $cfgFile -ErrorAction SilentlyContinue }
Get-ChildItem (Join-Path $desk 'src-tauri\target\release\bundle\nsis') | Format-Table Name, Length
