<#
.SYNOPSIS  Build a minimal JRE with jlink for the JDBC sidecar -> src-tauri/resources/jre
.PARAMETER JdkHome  JDK 21 home (default: $env:JAVA_HOME). Must contain bin\jlink(.exe) and jmods.
.PARAMETER Jar      Sidecar jar; if present its required modules are computed with jdeps and merged into the base set.
.PARAMETER Output   Output dir (default src-tauri\resources\jre). Deleted first.
#>
[CmdletBinding()]
param(
  [string]$JdkHome = $env:JAVA_HOME,
  [string]$Jar = (Join-Path $PSScriptRoot '..\..\..\services\jdbc\target\tabledb-jdbc.jar'),
  [string]$Output = (Join-Path $PSScriptRoot '..\src-tauri\resources\jre')
)
$ErrorActionPreference = 'Stop'
if (-not $JdkHome) { throw 'Set -JdkHome or JAVA_HOME to a JDK 21' }
$exe = if ($IsLinux -or $IsMacOS) { '' } else { '.exe' }
$jlink = Join-Path $JdkHome "bin/jlink$exe"; $jdeps = Join-Path $JdkHome "bin/jdeps$exe"; $java = Join-Path $JdkHome "bin/java$exe"
foreach ($t in @($jlink, $java)) { if (-not (Test-Path $t)) { throw "Missing $t" } }

# Base set (documented in README). Verified against the jar with jdeps when the jar exists.
$modules = [System.Collections.Generic.HashSet[string]]::new()
'java.base','java.logging','java.sql','java.naming','java.net.http','java.management','java.security.jgss',
'java.security.sasl','java.xml','jdk.unsupported','jdk.httpserver','jdk.crypto.ec','jdk.naming.dns' | ForEach-Object { [void]$modules.Add($_) }

if (Test-Path $Jar) {
  $drv = Join-Path (Split-Path $Jar) 'drivers'
  $found = & $jdeps --multi-release 21 --ignore-missing-deps --print-module-deps $Jar 2>$null
  if ($LASTEXITCODE -eq 0 -and $found) {
    Write-Host "jdeps modules for $Jar : $found"
    $found -split ',' | ForEach-Object { [void]$modules.Add($_.Trim()) }
  } else { Write-Warning 'jdeps failed; using base set only' }
} else {
  Write-Warning "Sidecar jar not found at $Jar - using base module set (re-run after building services/jdbc to verify with jdeps)."
}
# JDBC drivers are loaded reflectively, so jdeps cannot see their needs (Oracle: java.sql/naming/security; Trino: net.http via okhttp).
$available = (& $java --list-modules) | ForEach-Object { ($_ -split '@')[0] }
$final = $modules | Where-Object { $available -contains $_ } | Sort-Object
$missing = $modules | Where-Object { $available -notcontains $_ }
if ($missing) { Write-Host "Skipping modules not present in this JDK: $($missing -join ', ')" }

if (Test-Path $Output) { Remove-Item -Recurse -Force $Output }
& $jlink --add-modules ($final -join ',') --strip-debug --no-header-files --no-man-pages --compress zip-6 --output $Output
if ($LASTEXITCODE -ne 0) { throw 'jlink failed' }
& (Join-Path $Output "bin/java$exe") -version
Write-Host ("JRE ready: {0} ({1:N1} MB)" -f $Output, ((Get-ChildItem $Output -Recurse | Measure-Object Length -Sum).Sum / 1MB))
