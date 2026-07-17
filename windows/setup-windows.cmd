@echo off
setlocal EnableExtensions
title xshell Windows setup and build
set "XSHELL_BOOTSTRAP=%~f0"

fltmc >nul 2>&1
if not "%errorlevel%"=="0" (
  echo Requesting Administrator permission...
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "Start-Process -FilePath $env:XSHELL_BOOTSTRAP -Verb RunAs"
  if not "%errorlevel%"=="0" (
    echo.
    echo Could not request Administrator permission.
    pause
  )
  exit /b
)

echo.
echo ============================================================
echo   xshell Windows toolchain setup and build
echo ============================================================
echo.
echo This can take a while. Keep this window open.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$raw = [IO.File]::ReadAllText($env:XSHELL_BOOTSTRAP); $marker = '#__XSHELL_POWERSHELL_PAYLOAD__'; $index = $raw.LastIndexOf($marker); if ($index -lt 0) { throw 'Embedded PowerShell payload was not found.' }; Invoke-Expression $raw.Substring($index + $marker.Length)"
set "XSHELL_RESULT=%errorlevel%"

echo.
if "%XSHELL_RESULT%"=="0" (
  echo xshell setup and build completed successfully.
) else (
  echo xshell setup or build failed with exit code %XSHELL_RESULT%.
  echo Read the error above. If Windows requested a reboot, reboot and run this file again.
)
echo.
pause
exit /b %XSHELL_RESULT%

#__XSHELL_POWERSHELL_PAYLOAD__
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
  param([Parameter(Mandatory = $true)][string]$Message)
  Write-Host ""
  Write-Host "==> $Message" -ForegroundColor Cyan
}

function Refresh-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $pathParts = @($machinePath, $userPath) | Where-Object { $_ }
  $env:Path = $pathParts -join ";"

  $cargoBin = Join-Path $env:USERPROFILE ".cargo\bin"
  if ((Test-Path $cargoBin) -and (($env:Path -split ";") -notcontains $cargoBin)) {
    $env:Path = "$env:Path;$cargoBin"
  }
}

function Invoke-WingetPackage {
  param(
    [Parameter(Mandatory = $true)][string]$Id,
    [string]$Override,
    [switch]$Force
  )

  $wingetArgs = @(
    "install", "--id", $Id, "--exact", "--source", "winget",
    "--accept-source-agreements", "--accept-package-agreements",
    "--disable-interactivity"
  )
  if ($Force) { $wingetArgs += "--force" }
  if ($Override) {
    $wingetArgs += @("--override", $Override)
  } else {
    $wingetArgs += "--silent"
  }

  & $script:WingetPath @wingetArgs
  if ($LASTEXITCODE -ne 0) {
    Write-Warning "winget returned exit code $LASTEXITCODE for $Id. Validation will determine whether the package is usable."
  }
  Refresh-ProcessPath
}

function Get-NodeMajorVersion {
  $node = Get-Command "node.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $node) { return 0 }
  $version = (& $node.Source --version 2>$null | Select-Object -First 1)
  if ($version -match '^v(?<major>\d+)\.') { return [int]$Matches["major"] }
  return 0
}

function Test-VcTools {
  $vsWhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio\Installer\vswhere.exe"
  if (-not (Test-Path $vsWhere)) { return $false }
  $installPath = (& $vsWhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null | Select-Object -First 1)
  return -not [string]::IsNullOrWhiteSpace($installPath)
}

function Test-WingetPackage {
  param([Parameter(Mandatory = $true)][string]$Id)
  & $script:WingetPath list --id $Id --exact --source winget --accept-source-agreements --disable-interactivity *> $null
  return $LASTEXITCODE -eq 0
}

try {
  if ([System.Environment]::OSVersion.Platform -ne "Win32NT") {
    throw "This launcher must run on Windows, not inside WSL."
  }

  $windowsRoot = Split-Path -Parent $env:XSHELL_BOOTSTRAP
  $repoRoot = (Resolve-Path (Join-Path $windowsRoot "..")).Path
  $checkScript = Join-Path $windowsRoot "check-windows-build-env.ps1"
  $buildScript = Join-Path $windowsRoot "build-windows.ps1"
  if (-not (Test-Path $checkScript) -or -not (Test-Path $buildScript)) {
    throw "Keep setup-windows.cmd and its PowerShell helpers together in the windows folder."
  }

  $winget = Get-Command "winget.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $winget) {
    throw "winget was not found. Install or update 'App Installer' from Microsoft Store, then run this file again."
  }
  $script:WingetPath = $winget.Source
  Refresh-ProcessPath

  Write-Step "Checking Node.js 22 or newer"
  $nodeMajor = Get-NodeMajorVersion
  if ($nodeMajor -ge 22) {
    Write-Host "Node.js is already compatible."
  } else {
    Invoke-WingetPackage -Id "OpenJS.NodeJS.LTS"
  }
  if ((Get-NodeMajorVersion) -lt 22) {
    throw "Node.js 22 or newer was not found after installation. Reboot Windows and run this file again."
  }

  Write-Step "Checking Visual Studio 2022 C++ Build Tools"
  if (Test-VcTools) {
    Write-Host "The MSVC x64/x86 toolchain is already installed."
  } else {
    Invoke-WingetPackage `
      -Id "Microsoft.VisualStudio.2022.BuildTools" `
      -Force `
      -Override "--wait --passive --norestart --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
  }
  if (-not (Test-VcTools)) {
    throw "The MSVC C++ toolchain could not be verified after installation. Reboot Windows and run this file again."
  }

  Write-Step "Checking Microsoft Edge WebView2 Runtime"
  if (Test-WingetPackage -Id "Microsoft.EdgeWebView2Runtime") {
    Write-Host "WebView2 Runtime is already installed."
  } else {
    Invoke-WingetPackage -Id "Microsoft.EdgeWebView2Runtime"
  }

  Write-Step "Checking Rust and the Windows MSVC toolchain"
  $rustup = Get-Command "rustup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $rustup) {
    Invoke-WingetPackage -Id "Rustlang.Rustup"
    $rustup = Get-Command "rustup.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  }
  if (-not $rustup) {
    $rustupFallback = Join-Path $env:USERPROFILE ".cargo\bin\rustup.exe"
    if (Test-Path $rustupFallback) {
      $rustup = Get-Command $rustupFallback -ErrorAction SilentlyContinue | Select-Object -First 1
    }
  }
  if (-not $rustup) {
    throw "rustup was installed but could not be found. Reboot Windows and run this file again."
  }

  & $rustup.Source default stable-msvc
  if ($LASTEXITCODE -ne 0) { throw "Failed to select the stable MSVC Rust toolchain." }
  & $rustup.Source target add x86_64-pc-windows-msvc
  if ($LASTEXITCODE -ne 0) { throw "Failed to install the x86_64-pc-windows-msvc Rust target." }
  Refresh-ProcessPath

  Write-Step "Validating the Windows build environment"
  $windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  & $windowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $checkScript
  if ($LASTEXITCODE -ne 0) {
    throw "The environment check failed. Reboot Windows, then run setup-windows.cmd again."
  }

  Write-Step "Installing dependencies and building xshell"
  & $windowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $buildScript -InstallNodeModules
  if ($LASTEXITCODE -ne 0) { throw "The xshell build failed." }

  Write-Host ""
  Write-Host "Setup and build finished." -ForegroundColor Green
  exit 0
} catch {
  Write-Host ""
  Write-Host "Setup failed: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
