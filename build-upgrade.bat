@echo off
:: ============================================================
:: classroom-live 學生機建置 + 升級包製作腳本
:: 用途：建置 student dist 並製作 .zip 升級包
:: 儲存位置：D:\classroom-live\build-upgrade.bat
:: ============================================================

chcp 65001 >nul
setlocal enabledelayedexpansion

set ROOT_DIR=%~dp0
cd /d "%ROOT_DIR%"

echo ==================================================
echo  classroom-live 學生機建置 + 升級包製作
echo ==================================================
echo.

:: 檢查 npm.cmd
where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [錯誤] 找不到 npm.cmd，請確認已安裝 Node.js 並加入 PATH。
    pause
    exit /b 1
)

:: 檢查 student 套件
if not exist "%ROOT_DIR%packages\student\package.json" (
    echo [錯誤] 找不到 packages\student，請確認在正確的專案目錄執行。
    pause
    exit /b 1
)

:: 步驟 1：建置 student
echo [1/2] 建置學生機 (packages/student)...
npm.cmd run build:student
if errorlevel 1 (
    echo.
    echo [錯誤] 學生機建置失敗，請檢查上方錯誤訊息。
    pause
    exit /b 1
)
echo [OK] 學生機建置完成。
echo.

:: 步驟 2：製作升級包
echo [2/2] 製作升級包 (.zip)...
node scripts/make-upgrade-pack.mjs
if errorlevel 1 (
    echo.
    echo [錯誤] 升級包製作失敗，請檢查上方錯誤訊息。
    pause
    exit /b 1
)

echo.
echo ==================================================
echo  全部完成！
echo ==================================================
echo.
echo 升級包已產出，可在教師機「選擇檔案…」選擇此檔案，
echo 然後按「送檔／升級」傳送給學生機。
echo.
echo 提示：升級包檔名建議包含「升級包」二字（例如 學生機升級包 0.1.0.zip）
echo       教師端才會自動識別為升級並觸發學生端重啟。
echo.
pause
endlocal
