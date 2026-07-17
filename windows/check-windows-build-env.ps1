[CmdletBinding()]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Find-CommandPath {
  param([Parameter(Mandatory = $true)][string[]]$Names)

  foreach ($name in $Names) {
    $cmd = Get-Command $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Source }
  }

  return $null
}

function Get-VersionText {
  param(
    [Parameter(Mandatory = $true)][string]$CommandPath,
    [Parameter(Mandatory = $true)][string[]]$Arguments
  )

  $output = & $CommandPath @Arguments 2>&1
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to run '$CommandPath $($Arguments -join ' ')'."
  }
  return ($output | Select-Object -First 1).ToString().Trim()
}

if ([System.Environment]::OSVersion.Platform -ne "Win32NT") {
  throw "Run this script from Windows PowerShell or PowerShell 7 on Windows. It cannot validate a Windows .exe build from WSL/Linux."
}

$problems = New-Object System.Collections.Generic.List[string]
$warnings = New-Object System.Collections.Generic.List[string]

$nodePath = Find-CommandPath -Names @("node.exe", "node")
$npmPath = Find-CommandPath -Names @("npm.cmd", "npm.exe", "npm")
$cargoPath = Find-CommandPath -Names @("cargo.exe", "cargo")
$rustcPath = Find-CommandPath -Names @("rustc.exe", "rustc")
$rustupPath = Find-CommandPath -Names @("rustup.exe", "rustup")

if (-not $nodePath) {
  $problems.Add("Node.js was not found on PATH. Install Node.js 22+.")
} else {
  $nodeVersion = Get-VersionText -CommandPath $nodePath -Arguments @("-v")
  $nodeMajor = 0
  if ($nodeVersion -match '^v(?<major>\d+)\.') {
    $nodeMajor = [int]$Matches["major"]
  }
  if ($nodeMajor -lt 22) {
    $problems.Add("Node.js $nodeVersion found. This repo currently needs Node.js 22+ for its frontend toolchain.")
  }
}

if (-not $npmPath) {
  $problems.Add("npm was not found on PATH.")
}

if (-not $cargoPath) {
  $problems.Add("cargo was not found on PATH. Install Rust via rustup.")
}

if (-not $rustcPath) {
  $problems.Add("rustc was not found on PATH. Install Rust via rustup.")
}

if ($rustcPath) {
  $rustVersion = Get-VersionText -CommandPath $rustcPath -Arguments @("--version")
}

if ($cargoPath) {
  $cargoVersion = Get-VersionText -CommandPath $cargoPath -Arguments @("--version")
}

if ($rustupPath) {
  $installedTargets = & $rustupPath target list --installed 2>&1
  if ($LASTEXITCODE -ne 0) {
    $warnings.Add("rustup is installed, but the target list could not be read.")
  } elseif (-not ($installedTargets -contains "x86_64-pc-windows-msvc")) {
    $problems.Add("Rust target 'x86_64-pc-windows-msvc' is missing. Run: rustup target add x86_64-pc-windows-msvc")
  }
} else {
  $warnings.Add("rustup was not found, so the Windows MSVC target could not be verified.")
}

$vsWherePath = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
$vsInstallPath = $null
if (Test-Path $vsWherePath) {
  $vsInstallPath = (& $vsWherePath -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null | Select-Object -First 1)
  if (-not $vsInstallPath) {
    $problems.Add("Visual Studio Build Tools with the C++ toolchain were not found.")
  }
} else {
  $problems.Add("Visual Studio Build Tools could not be verified because vswhere.exe was not found.")
}

Write-Host ""
Write-Host "Windows build environment check"
Write-Host "Repo: $((Resolve-Path (Join-Path $PSScriptRoot '..')).Path)"
if ($nodePath)  { Write-Host "Node : $nodeVersion ($nodePath)" }
if ($npmPath)   { Write-Host "npm  : $npmPath" }
if ($rustcPath) { Write-Host "rustc: $rustVersion ($rustcPath)" }
if ($cargoPath) { Write-Host "cargo: $cargoVersion ($cargoPath)" }
if ($vsInstallPath) { Write-Host "MSVC : $vsInstallPath" }

if ($warnings.Count -gt 0) {
  Write-Host ""
  Write-Host "Warnings:"
  foreach ($warning in $warnings) {
    Write-Host "  - $warning"
  }
}

if ($problems.Count -gt 0) {
  Write-Host ""
  Write-Host "Missing or incompatible prerequisites:"
  foreach ($problem in $problems) {
    Write-Host "  - $problem"
  }

  Write-Host ""
  Write-Host "Suggested install commands:"
  Write-Host "  winget install OpenJS.NodeJS.LTS"
  Write-Host "  winget install Rustlang.Rustup"
  Write-Host '  winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"'
  Write-Host "  rustup target add x86_64-pc-windows-msvc"
  Write-Host ""
  Write-Host "After installing, close and reopen PowerShell, then run this script again."
  exit 1
}

Write-Host ""
Write-Host "Environment looks ready for a Windows Tauri build."
