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

function New-DeployZip {
    $unpack = Get-StudentUnpack
    if (-not $unpack) { Show-Warn "找不到學生機 win-unpacked"; return }
    $zipOut = Join-Path $PSScriptRoot "學生機部署包.zip"
    try {
        if (Test-Path $zipOut) { Remove-Item $zipOut -Force }
        Write-Host "  使用 $($unpack.FullName)（整包壓縮，速度較慢）" -ForegroundColor Gray
        Compress-Archive -Path (Join-Path $unpack.FullName "*") -DestinationPath $zipOut -CompressionLevel Optimal -Force -ErrorAction Stop
        if (Test-Path $deployDir) {
            Copy-Item $zipOut -Destination (Join-Path $deployDir "學生機部署包.zip") -Force -ErrorAction Stop
        }
        $mb = [math]::Round((Get-Item $zipOut).Length / 1MB, 2)
        Show-Ok "學生機部署包.zip 完成（$mb MB）"
    } catch {
        Show-Warn "學生機部署包.zip 失敗：$($_.Exception.Message)"
    }
}

function New-UpgradeZip {
    $unpack = Get-StudentUnpack
    if (-not $unpack) { Show-Warn "找不到學生機 win-unpacked"; return }
    $zipOut = Join-Path $PSScriptRoot "學生機升級包.zip"
    $resDir = Join-Path $unpack.FullName "resources"
    $asarPath = Join-Path $resDir "app.asar"
    $appDirPath = Join-Path $resDir "app"
    try {
        if (Test-Path $zipOut) { Remove-Item $zipOut -Force }
        if (Test-Path $asarPath) {
            Write-Host "  使用 resources\app.asar（熱更新結構）" -ForegroundColor Gray
            Compress-Archive -LiteralPath $asarPath -DestinationPath $zipOut -CompressionLevel Optimal -Force -ErrorAction Stop
        } elseif (Test-Path $appDirPath) {
            Write-Host "  使用 resources\app 資料夾（熱更新結構，排除 config.json）" -ForegroundColor Gray
            # 部署層 config.json 是各校自己的設定（serverUrl/classId 等），
            # 熱更新包覆蓋會把設定洗掉，所以一律排除（與 make-upgrade-pack.ps1 同規則）。
            $stage = Join-Path ([System.IO.Path]::GetTempPath()) ("classroom-upgrade-" + [guid]::NewGuid().ToString("N"))
            New-Item -ItemType Directory -Path $stage -Force | Out-Null
            Get-ChildItem -Path $appDirPath -Force | Where-Object { $_.Name -ne "config.json" } | ForEach-Object {
                Copy-Item $_.FullName -Destination (Join-Path $stage $_.Name) -Recurse -Force
            }
            # 附上原生模組（遠端接管用）
            $nativeSrc = Join-Path $PSScriptRoot "packages\native\bin\win32-x64-130\classroom_input.node"
            if (Test-Path $nativeSrc) {
                $nativeDir = Join-Path $stage "native"
                New-Item -ItemType Directory -Path $nativeDir -Force | Out-Null
                Copy-Item $nativeSrc -Destination (Join-Path $nativeDir "classroom_input.node") -Force
                Write-Host "  已附上原生模組（classroom_input.node）" -ForegroundColor Gray
            } else {
                Write-Host "  [提醒] 找不到原生模組，此升級包不含遠端接管" -ForegroundColor Yellow
            }
            Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zipOut -CompressionLevel Optimal -Force -ErrorAction Stop
            Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
        } else {
            Show-Warn "找不到 resources\app.asar 或 resources\app"
            return
        }
        if (Test-Path $deployDir) {
            Copy-Item $zipOut -Destination (Join-Path $deployDir "學生機升級包.zip") -Force -ErrorAction Stop
        }
        $mb = [math]::Round((Get-Item $zipOut).Length / 1MB, 2)
        Show-Ok "學生機升級包.zip 完成（$mb MB，不含 config.json）"
    } catch {
        Show-Warn "學生機升級包.zip 失敗：$($_.Exception.Message)"
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
    Write-Host "  [1] 全套打包 + 更新 deploy（pack:all + 安裝包 + 部署包.zip + 升級包.zip）" -ForegroundColor White
    Write-Host "  [2] 只打包教師機 + 更新 deploy" -ForegroundColor White
    Write-Host "  [3] 只打包學生機 + 更新 deploy（含部署包.zip / 升級包.zip）" -ForegroundColor White
    Write-Host "  [4] 只打包伺服器 + 伺服器GUI + 更新 deploy" -ForegroundColor White
    Write-Host "  [5] 不重新打包，把現有結果更新到 deploy（安裝包 + 兩個 zip）" -ForegroundColor White
    Write-Host "  [6] 只產生 學生機升級包.zip（熱更新用，不打包）" -ForegroundColor White
    Write-Host "  [7] 只產生 學生機部署包.zip（整包，不打包）" -ForegroundColor White
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
                Copy-SetupsByFolder -Folders @("teacher", "student", "server", "server-gui")
                Copy-Alias -Folder "teacher" -AliasName "教師機部署包.exe"
                Copy-Alias -Folder "student" -AliasName "學生機部署包.exe"
                New-DeployZip
                New-UpgradeZip
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
                New-DeployZip
                New-UpgradeZip
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
                Copy-SetupsByFolder -Folders @("teacher", "student", "server", "server-gui")
                Copy-Alias -Folder "teacher" -AliasName "教師機部署包.exe"
                Copy-Alias -Folder "student" -AliasName "學生機部署包.exe"
                New-DeployZip
                New-UpgradeZip
                Show-DeployList
            } catch {
                Show-Fail $_.Exception.Message
            }
            pause
        }
        "6" {
            try { New-UpgradeZip } catch { Show-Fail $_.Exception.Message }
            pause
        }
        "7" {
            try { New-DeployZip } catch { Show-Fail $_.Exception.Message }
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
