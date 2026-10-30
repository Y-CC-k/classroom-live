@echo off
chcp 65001 >nul
title Classroom Live - Signal Server

cd /d D:\classroom-live
echo ==========================================
echo  教室直播 - 信令伺服器
echo  Port: 8787
echo ==========================================
echo.

REM 檢查 port 是否被佔用
netstat -ano | findstr :8787 >nul
if %errorlevel% equ 0 (
    echo [警告] Port 8787 已被佔用，嘗試終止舊程序...
    for /f "tokens=5" %%a in ('netstat -ano ^| findstr :8787') do (
        taskkill /F /PID %%a >nul 2>&1
    )
    timeout /t 2 /nobreak >nul
)

echo [啟動中] 正在啟動信令伺服器...
npm.cmd run start --workspace @classroom/server

echo.
echo 伺服器已停止。
pause