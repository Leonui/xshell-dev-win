[CmdletBinding()]
param(
  [switch]$InstallNodeModules,
  [switch]$SkipEnvCheck,
  [switch]$Clean
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne "Win32NT") {
  throw "Run this script from Windows PowerShell or PowerShell 7 on Windows."
}

$scriptRoot = $PSScriptRoot
$repoRoot = (Resolve-Path (Join-Path $scriptRoot "..")).Path
$envCheckScript = Join-Path $scriptRoot "check-windows-build-env.ps1"
$npmCommand = Get-Command "npm.cmd" -ErrorAction SilentlyContinue | Select-Object -First 1
$npmPath = if ($npmCommand) { $npmCommand.Source } else { $null }
$localBuildConfigPath = $null

if (-not $npmPath) {
  throw "npm.cmd was not found on PATH."
}

if (-not $SkipEnvCheck) {
  & $envCheckScript
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
}

Push-Location $repoRoot
try {
  if ($Clean) {
    Write-Host "Cleaning old build output..."
    Remove-Item -Recurse -Force "dist" -ErrorAction SilentlyContinue
    Remove-Item -Recurse -Force "src-tauri\target" -ErrorAction SilentlyContinue
  }

  if ($InstallNodeModules -or -not (Test-Path "node_modules")) {
    Write-Host "Installing frontend dependencies with npm ci..."
    & $npmPath ci
    if ($LASTEXITCODE -ne 0) {
      throw "npm ci failed."
    }
  }

  $env:CARGO_TERM_COLOR = "always"

  $buildArguments = @("run", "tauri", "build")
  if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)) {
    $localBuildConfigPath = Join-Path ([System.IO.Path]::GetTempPath()) "xshell-local-build-$PID.json"
    '{"bundle":{"createUpdaterArtifacts":false}}' |
      Set-Content -LiteralPath $localBuildConfigPath -Encoding Ascii
    $buildArguments += @("--", "--config", $localBuildConfigPath)

    Write-Host "TAURI_SIGNING_PRIVATE_KEY is not set."
    Write-Host "Building installers without signed updater artifacts."
  }

  Write-Host "Building xshell for Windows..."
  & $npmPath @buildArguments
  if ($LASTEXITCODE -ne 0) {
    throw "npm run tauri build failed."
  }

  $portableExe = Join-Path $repoRoot "src-tauri\target\release\xshell.exe"
  $bundleRoot = Join-Path $repoRoot "src-tauri\target\release\bundle"

  Write-Host ""
  Write-Host "Build complete."
  if (Test-Path $portableExe) {
    Write-Host "Portable EXE:"
    Write-Host "  $portableExe"
  }

  if (Test-Path $bundleRoot) {
    Write-Host "Installer artifacts:"
    $artifacts = @(Get-ChildItem -Path $bundleRoot -Recurse -File |
      Where-Object { $_.Extension -in @(".exe", ".msi") } |
      Sort-Object FullName)

    if ($artifacts.Count -eq 0) {
      Write-Host "  No .exe or .msi files were found under $bundleRoot"
    } else {
      foreach ($artifact in $artifacts) {
        Write-Host "  $($artifact.FullName)"
      }
    }
  } else {
    Write-Host "Bundle directory not found:"
    Write-Host "  $bundleRoot"
  }
}
finally {
  if ($localBuildConfigPath -and (Test-Path -LiteralPath $localBuildConfigPath)) {
    Remove-Item -LiteralPath $localBuildConfigPath -Force -ErrorAction SilentlyContinue
  }
  Pop-Location
}
