@echo off
setlocal
cd /d "%~dp0.."

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0hard-gate.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo xshell hard gate failed with exit code %EXIT_CODE%.
  echo Read the first error above before retrying.
) else (
  echo xshell hard gate passed.
)
echo.
pause
exit /b %EXIT_CODE%
