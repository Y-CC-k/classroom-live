@echo off
chcp 65001 >nul
title Classroom Live - One Click Start (Server + Teacher + Student)

REM ============================================================
REM  Auto start: Server (8787) -> Teacher (9222) -> Student (9223)
REM  Requires: npm install done, node_modules\electron exists
REM ============================================================

set PROJECT_ROOT=%~dp0
cd /d "%PROJECT_ROOT%"

echo.
echo ==========================================
echo  Classroom Live - One Click Start
echo  Project root: %PROJECT_ROOT%
echo ==========================================
echo.

REM ------------------------------------------------------------
REM  1. Check required files
REM ------------------------------------------------------------
if not exist "node_modules\electron\dist\electron.exe" (
    echo [ERROR] electron.exe not found
    echo Please run: npm install
    pause
    exit /b 1
)

REM Server uses tsx directly, no build step needed

REM ------------------------------------------------------------
REM  2. Start Server (port 8787) - background
REM ------------------------------------------------------------
echo [1/3] Starting Signal Server (ws://127.0.0.1:8787) ...
start "Classroom-Server" /B cmd /c "cd /d "%PROJECT_ROOT%" && npm.cmd run start --workspace @classroom/server"

REM Wait for Server to be ready
echo      Waiting for Server...
:WAIT_SERVER
timeout /t 2 /nobreak >nul
curl -s -m 2 http://127.0.0.1:8787/healthz >nul 2>&1
if errorlevel 1 goto WAIT_SERVER
echo      [OK] Server listening on port 8787
echo.

REM ------------------------------------------------------------
REM  3. Start Teacher (port 9222)
REM ------------------------------------------------------------
echo [2/3] Starting Teacher (DevTools port 9222) ...
start "Classroom-Teacher" /D "%PROJECT_ROOT%\packages\teacher" "%PROJECT_ROOT%\node_modules\electron\dist\electron.exe" --remote-debugging-port=9222 .

timeout /t 3 /nobreak >nul
echo.

REM ------------------------------------------------------------
REM  4. Start Student (port 9223)
REM ------------------------------------------------------------
echo [3/3] Starting Student (DevTools port 9223) ...
start "Classroom-Student" /D "%PROJECT_ROOT%\packages\student" "%PROJECT_ROOT%\node_modules\electron\dist\electron.exe" --remote-debugging-port=9223 .

echo.
echo ==========================================
echo  All three processes started!
echo  - Server  : http://127.0.0.1:8787
echo  - Teacher : DevTools http://127.0.0.1:9222
echo  - Student : DevTools http://127.0.0.1:9223
echo ==========================================
echo.
echo Tips:
echo   - Close window to stop corresponding process
echo   - To stop all, close the three "Classroom-*" windows
echo   - Or kill electron.exe in Task Manager
echo.
pause