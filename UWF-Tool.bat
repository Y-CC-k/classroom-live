@echo off
rem ============================================================
rem  UWF-Tool.bat - Launcher for UWF-Tool.ps1 (double-click OK)
rem  Flow: elevate via UAC -> run UWF-Tool.ps1 (single menu tool)
rem ============================================================

rem -- Elevate: if not admin, relaunch this bat with UAC --------
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    exit /b
)

rem -- Run the integrated PowerShell menu tool -------------------
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0UWF-Tool.ps1"

rem -- Keep the window open if PowerShell exited with an error ---
if %errorlevel% neq 0 (
    echo.
    echo There was an error starting UWF-Tool.ps1.
    pause
)
