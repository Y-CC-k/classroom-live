[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location $PSScriptRoot

$deployDir = "C:\deploy"
$distElectron = Join-Path $PSScriptRoot "dist-electron"

function Show-Ok($msg)   { Write-Host "  [OK] $msg" -ForegroundColor Green }
function Show-Warn($msg) { Write-Host "  [提醒] $msg" -ForegroundColor Yellow }
function Show-Fail($msg) { Write-Host "  [錯誤] $msg" -ForegroundColor Red }
function Show-Info($msg) { Write-Host $msg -ForegroundColor Cyan }

function Ensure-DeployDir {
    if (-not (Test-Path $deployDir)) {
        try {
            New-Item -ItemType Directory -Path $deployDir -Force | Out-Null
            Show-Ok "已建立 $deployDir"
        } catch {
            Show-Fail "無法建立 $deployDir：$($_.Exception.Message)"
            Write-Host "  請以系統管理員身分執行" -ForegroundColor Yellow
            return $false
        }
    }
    return $true
}

function Get-SetupExes {
    if (-not (Test-Path $distElectron)) { return @() }
    return Get-ChildItem -Path $distElectron -File -Recurse -Depth 2 -ErrorAction SilentlyContinue |
        Where-Object { $_.Extension -eq ".exe" -and $_.Name -match "Setup" -and $_.FullName -notmatch "deploy-" } |
        Sort-Object LastWriteTime -Descending
}

function Copy-SetupsByFolder {
    param([string[]]$Folders)
    $exes = Get-SetupExes | Where-Object { $Folders -contains $_.Directory.Name }
    if ($exes.Count -eq 0) { Show-Warn "沒有找到符合的 Setup.exe（$($Folders -join ", " )）"; return }
    foreach ($f in $exes) {
        Write-Host "  複製 $($f.Name)" -ForegroundColor Gray
        Copy-Item $f.FullName -Destination (Join-Path $deployDir $f.Name) -Force -ErrorAction Stop
    }
    Show-Ok "已複製 $($exes.Count) 個安裝包到 C:\deploy"
}

function Copy-Alias {
    param([string]$Folder, [string]$AliasName)
    $f = Get-SetupExes | Where-Object { $_.Directory.Name -eq $Folder } | Select-Object -First 1
    if ($f) {
        Copy-Item $f.FullName -Destination (Join-Path $deployDir $AliasName) -Force -ErrorAction Stop
        Show-Ok "$AliasName 已更新（$($f.Name)）"
    } else {
        Show-Warn "找不到 $Folder 子資料夾的 Setup.exe，略過 $AliasName"
    }
}

function Get-StudentUnpack {
    if (-not (Test-Path $distElectron)) { return $null }
    $cands = Get-ChildItem -Path $distElectron -Directory -Recurse -Depth 2 -ErrorAction SilentlyContinue | Where-Object { $_.Name -match "unpacked" }
    $unpack = $cands | Where-Object { $_.FullName -match "student|學生" -and $_.FullName -notmatch "deploy-" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if (-not $unpack) { $unpack = $cands | Where-Object { $_.FullName -notmatch "deploy-" } | Sort-Object LastWriteTime -Descending | Select-Object -First 1 }
    return $unpack
}


function Invoke-UpgradePack {
    Invoke-Pack -ScriptName "make-upgrade-pack" -Label "學生機升級包（含 native 模組）"
    $src = Get-ChildItem -Path $PSScriptRoot -Filter "學生機升級包 *.zip" -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($src -and (Test-Path $deployDir)) {
        Copy-Item $src.FullName -Destination (Join-Path $deployDir $src.Name) -Force -ErrorAction SilentlyContinue
    }
}


function Invoke-Pack {
    param([string]$ScriptName, [string]$Label)
    Write-Host ""
    Write-Host "→ 執行 npm run $ScriptName（$Label）..." -ForegroundColor Cyan
    Write-Host "  可能需要數分鐘，請耐心等候..." -ForegroundColor Gray
    & npm run $ScriptName
    if ($LASTEXITCODE -ne 0) { throw "$ScriptName 失敗（結束代碼 $LASTEXITCODE）" }
    Show-Ok "$Label 打包完成"
}

function Show-DeployList {
    Write-Host ""
    Show-Info "  ---- C:\deploy 目前內容 ----"
    if (Test-Path $deployDir) {
        Get-ChildItem $deployDir -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending |
            ForEach-Object {
                $t = $_.LastWriteTime.ToString("yyyy-MM-dd HH:mm")
                $kb = [math]::Round($_.Length / 1KB)
                Write-Host "    $t  $kb KB  $($_.Name)" -ForegroundColor Gray
            }
    } else {
        Show-Warn "C:\deploy 不存在"
    }
}

function Show-Menu {
    Clear-Host
    Show-Info "==================================================="
    Show-Info "   Classroom Live - 打包部署選單"
    Show-Info "==================================================="
    Write-Host ""
    Write-Host "  [1] 全套打包 + 更新 deploy（pack:all + 安裝包 + 升級包.zip）" -ForegroundColor White
    Write-Host "  [2] 只打包教師機 + 更新 deploy" -ForegroundColor White
    Write-Host "  [3] 只打包學生機 + 更新 deploy（含升級包.zip）" -ForegroundColor White
    Write-Host "  [4] 只打包伺服器 + 伺服器GUI + 更新 deploy" -ForegroundColor White
    Write-Host "  [5] 不重新打包，把現有結果更新到 deploy（安裝包 + 兩個 zip）" -ForegroundColor White
    Write-Host "  [6] 只產生 學生機升級包（make-upgrade-pack，含 native）" -ForegroundColor White
    Write-Host "  [8] 只打包教師機（簡易版）+ 更新 deploy" -ForegroundColor White
    Write-Host "  [0] 結束" -ForegroundColor DarkGray
    Write-Host ""
}

# ── 主迴圈 ──
do {
    Show-Menu
    $choice = Read-Host "  請輸入選項"
    Write-Host ""
    switch ($choice) {
        "1" {
            try {
                if (-not (Ensure-DeployDir)) { throw "無法使用 C:\deploy" }
                Invoke-Pack -ScriptName "pack:all" -Label "全部（教師機/學生機/伺服器/伺服器GUI）"
                Copy-SetupsByFolder -Folders @("teacher", "student", "server", "server-gui", "teacher-lite")
                Copy-Alias -Folder "teacher" -AliasName "教師機部署包.exe"
                Copy-Alias -Folder "student" -AliasName "學生機部署包.exe"
                Copy-Alias -Folder "teacher-lite" -AliasName "教師機簡易版部署包.exe"
                Invoke-UpgradePack
                Show-DeployList
            } catch {
                Show-Fail $_.Exception.Message
                Write-Host "  請查看上方輸出訊息" -ForegroundColor Yellow
            }
            pause
        }
        "2" {
            try {
                if (-not (Ensure-DeployDir)) { throw "無法使用 C:\deploy" }
                Invoke-Pack -ScriptName "pack:teacher" -Label "教師機"
                Copy-SetupsByFolder -Folders @("teacher")
                Copy-Alias -Folder "teacher" -AliasName "教師機部署包.exe"
                Show-DeployList
            } catch {
                Show-Fail $_.Exception.Message
            }
            pause
        }
        "3" {
            try {
                if (-not (Ensure-DeployDir)) { throw "無法使用 C:\deploy" }
                Invoke-Pack -ScriptName "pack:student" -Label "學生機"
                Copy-SetupsByFolder -Folders @("student")
                Copy-Alias -Folder "student" -AliasName "學生機部署包.exe"
                Invoke-UpgradePack
                Show-DeployList
            } catch {
                Show-Fail $_.Exception.Message
            }
            pause
        }
        "4" {
            try {
                if (-not (Ensure-DeployDir)) { throw "無法使用 C:\deploy" }
                Invoke-Pack -ScriptName "pack:server" -Label "伺服器"
                Invoke-Pack -ScriptName "pack:server-gui" -Label "伺服器GUI"
                Copy-SetupsByFolder -Folders @("server", "server-gui")
                Show-DeployList
            } catch {
                Show-Fail $_.Exception.Message
            }
            pause
        }
        "5" {
            try {
                if (-not (Ensure-DeployDir)) { throw "無法使用 C:\deploy" }
                Copy-SetupsByFolder -Folders @("teacher", "student", "server", "server-gui", "teacher-lite")
                Copy-Alias -Folder "teacher" -AliasName "教師機部署包.exe"
                Copy-Alias -Folder "student" -AliasName "學生機部署包.exe"
                Copy-Alias -Folder "teacher-lite" -AliasName "教師機簡易版部署包.exe"
                Invoke-UpgradePack
                Show-DeployList
            } catch {
                Show-Fail $_.Exception.Message
            }
            pause
        }
        "6" {
            try {
                Invoke-UpgradePack
            } catch {
                Show-Fail $_.Exception.Message
            }
            pause
        }
        "8" {
            try {
                if (-not (Ensure-DeployDir)) { throw "無法使用 C:\deploy" }
                Invoke-Pack -ScriptName "pack:teacher-lite" -Label "教師機（簡易版）"
                Copy-SetupsByFolder -Folders @("teacher-lite")
                Copy-Alias -Folder "teacher-lite" -AliasName "教師機簡易版部署包.exe"
                Show-DeployList
            } catch {
                Show-Fail $_.Exception.Message
            }
            pause
        }
        "0" {
            Write-Host "  結束。" -ForegroundColor DarkGray
        }
        default {
            Show-Warn "無效選項：$choice"
        }
    }
} while ($choice -ne "0")
