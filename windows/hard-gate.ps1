[CmdletBinding()]
param(
  [switch]$SkipInstall
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([System.Environment]::OSVersion.Platform -ne "Win32NT") {
  throw "Run this hard gate from Windows PowerShell or PowerShell 7 on Windows."
}

$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$gateStarted = [DateTime]::UtcNow

function Invoke-Checked {
  param(
    [Parameter(Mandatory = $true)][string]$Label,
    [Parameter(Mandatory = $true)][string]$Command,
    [Parameter()][string[]]$Arguments = @()
  )

  Write-Host ""
  Write-Host "==> $Label"
  & $Command @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "$Label failed with exit code $LASTEXITCODE."
  }
}

& (Join-Path $PSScriptRoot "check-windows-build-env.ps1")
if (-not $?) { throw "Windows build environment check failed." }

$npm = (Get-Command "npm.cmd" -ErrorAction Stop).Source
$cargo = (Get-Command "cargo.exe" -ErrorAction Stop).Source

if ([string]::IsNullOrWhiteSpace($env:TAURI_SIGNING_PRIVATE_KEY)) {
  throw "TAURI_SIGNING_PRIVATE_KEY is required because the hard gate verifies signed updater artifacts."
}

Push-Location $repoRoot
try {
  if (-not $SkipInstall) {
    Invoke-Checked -Label "Deterministic npm install" -Command $npm -Arguments @("ci")
  }
  Invoke-Checked -Label "Frontend tests" -Command $npm -Arguments @("test", "--", "--run")
  Invoke-Checked -Label "TypeScript and Vite production build" -Command $npm -Arguments @("run", "build")
  Invoke-Checked -Label "Rust formatting" -Command $cargo -Arguments @("fmt", "--manifest-path", "src-tauri\Cargo.toml", "--", "--check")
  Invoke-Checked -Label "Rust tests" -Command $cargo -Arguments @("test", "--manifest-path", "src-tauri\Cargo.toml")
  Invoke-Checked -Label "Rust clippy" -Command $cargo -Arguments @("clippy", "--manifest-path", "src-tauri\Cargo.toml", "--all-targets", "--", "-D", "warnings")

  & (Join-Path $PSScriptRoot "build-windows.ps1") -SkipEnvCheck
  if (-not $?) { throw "Signed Windows package build failed." }

  $releaseRoot = Join-Path $repoRoot "src-tauri\target\release"
  $required = @(
    Get-Item (Join-Path $releaseRoot "xshell.exe") -ErrorAction Stop
    Get-ChildItem (Join-Path $releaseRoot "bundle\msi") -Filter "*.msi" -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    Get-ChildItem (Join-Path $releaseRoot "bundle\msi") -Filter "*.msi.sig" -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    Get-ChildItem (Join-Path $releaseRoot "bundle\nsis") -Filter "*.exe" -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
    Get-ChildItem (Join-Path $releaseRoot "bundle\nsis") -Filter "*.exe.sig" -File | Sort-Object LastWriteTimeUtc -Descending | Select-Object -First 1
  )

  if ($required.Count -ne 5 -or $required -contains $null) {
    throw "Hard gate could not find every required EXE/MSI/NSIS/signature artifact."
  }
  foreach ($artifact in $required) {
    if ($artifact.Length -le 0) { throw "Artifact is empty: $($artifact.FullName)" }
    if ($artifact.LastWriteTimeUtc -lt $gateStarted) {
      throw "Artifact was not rebuilt by this gate: $($artifact.FullName)"
    }
  }

  $tauriConfig = Get-Content (Join-Path $repoRoot "src-tauri\tauri.conf.json") -Raw | ConvertFrom-Json
  $signaturePairs = @(
    [PSCustomObject]@{ Artifact = $required[1]; Signature = $required[2] }
    [PSCustomObject]@{ Artifact = $required[3]; Signature = $required[4] }
  )
  foreach ($pair in $signaturePairs) {
    Invoke-Checked -Label "Cryptographically verify $($pair.Artifact.Name)" -Command $cargo -Arguments @(
      "run", "--quiet", "--manifest-path", "src-tauri\Cargo.toml",
      "--example", "verify_updater_signature", "--",
      $tauriConfig.plugins.updater.pubkey, $pair.Artifact.FullName, $pair.Signature.FullName
    )
  }

  Write-Host ""
  Write-Host "HARD GATE PASSED"
  foreach ($artifact in $required) { Write-Host "  $($artifact.FullName)" }
}
finally {
  Pop-Location
}
