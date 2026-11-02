@echo off
:: ============================================================
:: classroom-live Smoke Test 一鍵執行腳本
:: 用途：執行伺服器與 Wake-on-LAN 冒煙測試
:: 儲存位置：D:\classroom-live\test-smoke.bat
:: ============================================================

chcp 65001 >nul
setlocal enabledelayedexpansion

set ROOT_DIR=%~dp0
cd /d "%ROOT_DIR%"

echo ==================================================
echo  classroom-live Smoke Test (冒煙測試)
echo ==================================================
echo.

:: 檢查 npm.cmd
where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [錯誤] 找不到 npm.cmd，請確認已安裝 Node.js 並加入 PATH。
    pause
    exit /b 1
)

echo [執行] npm.cmd run smoke
echo.

npm.cmd run smoke
if errorlevel 1 (
    echo.
    echo [結果] Smoke 測試失敗，請檢查上方錯誤訊息。
) else (
    echo.
    echo [結果] Smoke 測試全部通過 ✅
)

echo.
pause
endlocal
