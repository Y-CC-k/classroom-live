<#
.SYNOPSIS
    一鍵清理瀏覽器瀏覽資料（快取、歷史紀錄、Cookie、密碼、自動填入、下載紀錄、表單資料等）。

.DESCRIPTION
    自動偵測已安裝的瀏覽器（Chrome / Edge / Brave / Vivaldi / Opera / Firefox），
    關閉執行中的瀏覽器程序後，刪除各瀏覽器個人資料夾中的瀏覽資料檔案，
    保留書籤、擴充功能與瀏覽器設定（Firefox 的歷史紀錄與書籤同存於 places.sqlite，
    預設會先將其備份到資料夾再刪除）。

    集中設定檔（教師／IT 部署用）：腳本同資料夾的 Clear-BrowserData.settings.json，
    可用 -Settings 指定其他路徑。設定檔可控制：要清理的瀏覽器、保留項目
    （passwords / cookies / history）、執行前是否需輸入 YES 確認、是否寫執行記錄檔。
    命令列參數優先於設定檔。

.PARAMETER Browsers
    只清理指定的瀏覽器，例如 -Browsers Chrome,Firefox。省略時依設定檔，或自動偵測全部。

.PARAMETER Force
    不詢問直接強制關閉執行中的瀏覽器程序（不影響執行前的 YES 確認）。

.PARAMETER DryRun
    模擬模式：只報告將被刪除的項目與可釋出空間，不實際刪除。

.PARAMETER KeepFirefoxBookmarks
    清理 Firefox 時保留 places.sqlite（即保留書籤與歷史紀錄）。

.PARAMETER ClearPasswords
    連同儲存的密碼／登入資料一起清除（預設保留，避免學生忘記帳號）。

.PARAMETER Settings
    指定設定檔路徑；省略時使用腳本同資料夾的 Clear-BrowserData.settings.json。

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File .\Clear-BrowserData.ps1
.EXAMPLE
    .\Clear-BrowserData.ps1 -DryRun
.EXAMPLE
    .\Clear-BrowserData.ps1 -Browsers Chrome,Edge -Force
.EXAMPLE
    .\Clear-BrowserData.ps1 -Settings \\teacher\share\settings.json
#>
#Requires -Version 5.1
[CmdletBinding()]
param(
    [ValidateSet('Chrome', 'Edge', 'Brave', 'Vivaldi', 'Opera', 'Firefox')]
    [string[]]$Browsers,

    [switch]$Force,
    [switch]$DryRun,
    [switch]$KeepFirefoxBookmarks,
    [switch]$ClearPasswords,
    [string]$Settings
)

$ErrorActionPreference = 'SilentlyContinue'

# 統一使用 UTF-8 輸出，避免中文在主控台顯示成亂碼
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

# ---------------------------------------------------------------------------
# 執行安全檢查
# ---------------------------------------------------------------------------
# 清理動作只需要使用者自己的權限；以系統管理員執行時提醒，避免誤清其他使用者的資料
$isAdmin = ([System.Security.Principal.WindowsPrincipal][System.Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
    Write-Warning '目前以系統管理員權限執行。建議以一般使用者權限執行，避免清到其他使用者的瀏覽器資料。'
}

# ---------------------------------------------------------------------------
# 工具函式
# ---------------------------------------------------------------------------
function Format-Size {
    param([long]$Bytes)
    if ($Bytes -ge 1GB) { return ('{0:N2} GB' -f ($Bytes / 1GB)) }
    if ($Bytes -ge 1MB) { return ('{0:N1} MB' -f ($Bytes / 1MB)) }
    if ($Bytes -ge 1KB) { return ('{0:N1} KB' -f ($Bytes / 1KB)) }
    return "$Bytes B"
}

function Get-PathSize {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $item = Get-Item -LiteralPath $Path -Force -ErrorAction SilentlyContinue
    if ($null -eq $item) { return 0 }
    if (-not $item.PSIsContainer) { return [long]$item.Length }
    $sum = 0L
    Get-ChildItem -LiteralPath $Path -Recurse -Force -File -ErrorAction SilentlyContinue |
        ForEach-Object { $sum += $_.Length }
    return $sum
}

# script 層級計數器：本次瀏覽器已刪除（或模擬可刪除）的項目數
$script:ItemDeleted = 0

function Remove-DataItem {
    param([string]$Path, [bool]$DryRun)
    if (-not (Test-Path -LiteralPath $Path)) { return 0 }
    $size = Get-PathSize -Path $Path
    $script:ItemDeleted++
    if ($DryRun) { return $size }
    try {
        Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction Stop
    }
    catch {
        Write-Warning "無法刪除：$Path （$($_.Exception.Message)）"
    }
    return $size
}

# ---------------------------------------------------------------------------
# 集中設定檔（教師 / IT 部署用）
# ---------------------------------------------------------------------------
$ValidKeepItems    = @('passwords', 'cookies', 'history')
$ValidBrowserNames = @('Chrome', 'Edge', 'Brave', 'Vivaldi', 'Opera', 'Firefox')

# 內建預設值：保留密碼（避免學生忘記帳號）、執行前需輸入 YES 確認
$config = @{
    Browsers            = $null                                     # 空 = 自動偵測全部
    KeepItems           = @('passwords')
    RequireConfirmation = $true
    LogEnabled          = $false
    LogPath             = (Join-Path $PSScriptRoot 'Logs')
}

$settingsPath = if ($Settings) { $Settings } else { Join-Path $PSScriptRoot 'Clear-BrowserData.settings.json' }

if (Test-Path -LiteralPath $settingsPath) {
    Write-Host ("已載入集中設定檔：{0}" -f $settingsPath) -ForegroundColor DarkGray
    try {
        $json = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json -ErrorAction Stop

        # Browsers：只允許已支援的瀏覽器名稱，不明的值忽略並警告
        if ($null -ne $json.Browsers) {
            $names = @($json.Browsers | Where-Object { $_ -in $ValidBrowserNames })
            $bad   = @($json.Browsers | Where-Object { $_ -notin $ValidBrowserNames })
            if ($bad.Count -gt 0) { Write-Warning ("設定檔 Browsers 含不明名稱（已忽略）：{0}" -f ($bad -join '、')) }
            $config.Browsers = $names    # 空陣列 = 自動偵測全部
        }

        # KeepItems：要保留的資料類別，可用值 passwords / cookies / history（空陣列 = 全部清除）
        if ($null -ne $json.KeepItems) {
            $keeps  = @($json.KeepItems | ForEach-Object { ($_ -as [string]).ToLowerInvariant() } | Where-Object { $_ -in $ValidKeepItems })
            $badK = @($json.KeepItems | Where-Object { (($_ -as [string]).ToLowerInvariant()) -notin $ValidKeepItems })
            if ($badK.Count -gt 0) {
                $config.KeepItems = $keeps
                Write-Warning ("設定檔 KeepItems 含不明值（可用：{0}）：{1}" -f ($ValidKeepItems -join '、'), ($badK -join '、'))
            }
            else { $config.KeepItems = $keeps }
        }

        if ($null -ne $json.RequireConfirmation) { $config.RequireConfirmation = [bool]$json.RequireConfirmation }
        if ($null -ne $json.LogEnabled)          { $config.LogEnabled = [bool]$json.LogEnabled }
        if ($json.LogPath) {
            $config.LogPath = if ([System.IO.Path]::IsPathRooted($json.LogPath)) { [string]$json.LogPath }
                               else { Join-Path $PSScriptRoot ([string]$json.LogPath) }
        }
    }
    catch {
        Write-Warning ("設定檔讀取失敗，改用內建預設值：{0}" -f $_.Exception.Message)
    }
}

# ---------------------------------------------------------------------------
# 命令列參數合併（命令列優先於設定檔）
# ---------------------------------------------------------------------------
if ($Browsers) { $config.Browsers = $Browsers }
if ($ClearPasswords) {
    $config.KeepItems = @($config.KeepItems | Where-Object { $_ -ne 'passwords' })
}

$script:KeepPasswords = 'passwords' -in $config.KeepItems
$script:KeepCookies   = 'cookies'   -in $config.KeepItems
$script:KeepHistory   = 'history'   -in $config.KeepItems

# Firefox 的書籤與歷史紀錄同存於 places.sqlite：保留歷史時自然一併保留
if ($script:KeepHistory -or $KeepFirefoxBookmarks) { $script:KeepHistory = $true }

# 執行記錄檔（溯源用）：每次執行寫入 Logs\ ，失敗時靜默不影響清理
function Write-ExecutionLog {
    param([string]$Message)
    if (-not $config.LogEnabled) { return }
    try {
        if (-not (Test-Path -LiteralPath $config.LogPath)) {
            New-Item -ItemType Directory -Path $config.LogPath -Force -ErrorAction Stop | Out-Null
        }
        $logFile = Join-Path $config.LogPath ('Clear-BrowserData_{0}.log' -f (Get-Date -Format 'yyyyMMdd'))
        $line = '[{0}] [{1}\{2}] {3}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $env:COMPUTERNAME, $env:USERNAME, $Message
        Add-Content -LiteralPath $logFile -Value $line -Encoding UTF8 -ErrorAction Stop
    }
    catch { }
}

# ---------------------------------------------------------------------------
# 各刪除項目對應的「保留類別」
# 若項目被映射到某類別，且該類別在設定中要求保留，則跳過刪除
# ---------------------------------------------------------------------------
$script:ChromiumDirKeep = @{
    'Network' = 'cookies'      # 新版 Chromium 的 Cookies 存於 Network 資料夾
}

$script:ChromiumFileKeep = @{
    'Login Data*'             = 'passwords'
    'Login Data For Account*' = 'passwords'
    'Cookies*'                = 'cookies'
    'History*'                = 'history'
    'Top Sites*'              = 'history'
}

$script:FirefoxFileKeep = @{
    'cookies.sqlite*'     = 'cookies'
    'logins.json*'        = 'passwords'
    'logins-backup.json*' = 'passwords'
    'key3.db'             = 'passwords'
    'key4.db'             = 'passwords'
    'signons.sqlite*'     = 'passwords'
    'places.sqlite*'      = 'history'
}

# 判斷某刪除項目是否因「保留設定」而應跳過
function Test-KeepByCategory {
    param([string]$Category)
    if (-not $Category) { return $false }
    $flag = switch ($Category) {
        'passwords' { $script:KeepPasswords }
        'cookies'   { $script:KeepCookies }
        'history'   { $script:KeepHistory }
        default     { $false }
    }
    return [bool]$flag
}

# ---------------------------------------------------------------------------
# Chromium 系（Chrome / Edge / Brave / Vivaldi / Opera）
# ---------------------------------------------------------------------------
# 各個人資料夾內要刪除的「資料夾」
$ChromiumDirs = @(
    'Cache', 'Code Cache', 'GPUCache', 'GrShaderCache', 'ShaderCache',
    'DawnCache', 'DawnGraphiteCache', 'GraphiteDawnCache',
    'Service Worker', 'IndexedDB', 'Local Storage', 'Session Storage',
    'File System', 'Databases', 'Application Cache', 'Media Cache',
    'Blob_storage', 'Network', 'Sessions'
)

# 各個人資料夾內要刪除的「檔案」（萬用字元）
# 注意：刻意排除 Bookmarks*、Preferences、Secure Preferences 等設定檔
$ChromiumFiles = @(
    'History*', 'Cookies*', 'Login Data*', 'Login Data For Account*',
    'Web Data*', 'Top Sites*', 'Favicons*', 'Shortcuts*',
    'QuotaManager', 'TransportSecurity', 'Affiliation Database*',
    'Current Session*', 'Current Tabs*', 'Last Session*', 'Last Tabs*',
    'Network Action Predictor*'
)

function Clear-ChromiumTarget {
    param($Target, [bool]$DryRun)

    $freed = 0L
    # 根資料夾（Opera 的資料直接放在根目錄）＋ 各個人資料夾
    $profileRoots = @($Target.Data)
    Get-ChildItem -LiteralPath $Target.Data -Directory -Force -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -in @('Default', 'Guest Profile', 'System Profile') -or $_.Name -like 'Profile *' } |
        ForEach-Object { $profileRoots += $_.FullName }

    foreach ($profile in $profileRoots) {
        foreach ($dirName in $ChromiumDirs) {
            if (Test-KeepByCategory -Category $script:ChromiumDirKeep[$dirName]) { continue }
            $freed += Remove-DataItem -Path (Join-Path $profile $dirName) -DryRun $DryRun
        }
        foreach ($filePattern in $ChromiumFiles) {
            if (Test-KeepByCategory -Category $script:ChromiumFileKeep[$filePattern]) { continue }
            Get-ChildItem -LiteralPath $profile -Filter $filePattern -Force -File -ErrorAction SilentlyContinue |
                ForEach-Object { $freed += Remove-DataItem -Path $_.FullName -DryRun $DryRun }
        }
    }
    return $freed
}

# ---------------------------------------------------------------------------
# Firefox
# ---------------------------------------------------------------------------
$FirefoxDirs = @(
    'cache2', 'startupCache', 'thumbnails', 'sessionstore-backups',
    'storage', 'offlineapps', 'Cache', 'jumpListCache'
)

$FirefoxFiles = @(
    'cookies.sqlite*', 'formhistory.sqlite*', 'logins.json*', 'logins-backup.json*',
    'key3.db', 'key4.db', 'signons.sqlite*', 'permissions.sqlite*',
    'content-prefs.sqlite*', 'favicons.sqlite*', 'webappsstore.sqlite*',
    'sessionstore.*', 'downloads.json', 'history.json'
)

function Clear-FirefoxTarget {
    param($Target, [bool]$DryRun, [bool]$KeepBookmarks)

    $freed = 0L
    $profilesRoot = Join-Path $Target.Data 'Profiles'
    $profiles = @(Get-ChildItem -LiteralPath $profilesRoot -Directory -Force -ErrorAction SilentlyContinue)

    foreach ($profile in $profiles) {
        foreach ($dirName in $FirefoxDirs) {
            $freed += Remove-DataItem -Path (Join-Path $profile.FullName $dirName) -DryRun $DryRun
        }
        foreach ($filePattern in $FirefoxFiles) {
            if (Test-KeepByCategory -Category $script:FirefoxFileKeep[$filePattern]) { continue }
            Get-ChildItem -LiteralPath $profile.FullName -Filter $filePattern -Force -File -ErrorAction SilentlyContinue |
                ForEach-Object { $freed += Remove-DataItem -Path $_.FullName -DryRun $DryRun }
        }

        # places.sqlite 同時存放書籤與歷史紀錄，預設先備份再刪除
        $places = @(Get-ChildItem -LiteralPath $profile.FullName -Filter 'places.sqlite*' -Force -File -ErrorAction SilentlyContinue)
        if ($places.Count -gt 0 -and -not $KeepBookmarks) {
            if ($DryRun) {
                $freed += ($places | Measure-Object -Property Length -Sum).Sum
                $script:ItemDeleted += $places.Count
            }
            else {
                $backupDir = Join-Path $profile.FullName ('BookmarkBackup_' + (Get-Date -Format 'yyyyMMdd_HHmmss'))
                try {
                    New-Item -ItemType Directory -Path $backupDir -Force -ErrorAction Stop | Out-Null
                    $places | Copy-Item -Destination $backupDir -Force -ErrorAction Stop
                    $places | Remove-Item -Force -ErrorAction Stop
                    Write-Host ("    ⚠ Firefox 書籤/歷史紀錄已刪除，原 places.sqlite 已備份至：{0}" -f $backupDir) -ForegroundColor Yellow
                }
                catch {
                    Write-Warning "Firefox places.sqlite 清理失敗：$($_.Exception.Message)"
                }
            }
        }
    }
    return $freed
}

# ---------------------------------------------------------------------------
# 偵測瀏覽器
# ---------------------------------------------------------------------------
$targets = @(
    [pscustomobject]@{ Name = 'Chrome';  Kind = 'chromium'; Proc = 'chrome';  Data = (Join-Path $env:LOCALAPPDATA 'Google\Chrome\User Data') },
    [pscustomobject]@{ Name = 'Edge';    Kind = 'chromium'; Proc = 'msedge';  Data = (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\User Data') },
    [pscustomobject]@{ Name = 'Brave';   Kind = 'chromium'; Proc = 'brave';   Data = (Join-Path $env:LOCALAPPDATA 'BraveSoftware\Brave-Browser\User Data') },
    [pscustomobject]@{ Name = 'Vivaldi'; Kind = 'chromium'; Proc = 'vivaldi'; Data = (Join-Path $env:LOCALAPPDATA 'Vivaldi\User Data') },
    [pscustomobject]@{ Name = 'Opera';   Kind = 'chromium'; Proc = 'opera';   Data = (Join-Path $env:APPDATA 'Opera Software\Opera Stable') },
    [pscustomobject]@{ Name = 'Firefox'; Kind = 'firefox';  Proc = 'firefox'; Data = (Join-Path $env:APPDATA 'Mozilla\Firefox') }
)

if ($config.Browsers) {
    $targets = @($targets | Where-Object { $_.Name -in $config.Browsers })
}

$existing = @($targets | Where-Object { Test-Path -LiteralPath $_.Data })

Write-Host ''
if ($existing.Count -eq 0) {
    Write-Host '未偵測到任何已建立資料的瀏覽器。' -ForegroundColor Yellow
    exit 0
}

Write-Host ('偵測到瀏覽器：' + (($existing | ForEach-Object { $_.Name }) -join '、')) -ForegroundColor Cyan

# 顯示本次的保留設定，讓使用者（學生）清楚知道哪些資料不會被清除
$keptDesc = @()
if ($script:KeepPasswords) { $keptDesc += '密碼/登入資料' }
if ($script:KeepCookies)   { $keptDesc += 'Cookie' }
if ($script:KeepHistory)   { $keptDesc += '歷史紀錄' }
$keepMsg = if ($keptDesc.Count -gt 0) { ($keptDesc -join '、') } else { '（無保留，全部清除）' }
Write-Host ("保留設定：書籤、擴充功能、瀏覽器設定；{0}" -f $keepMsg) -ForegroundColor DarkGray

if ($DryRun) {
    Write-Host '【模擬模式】不會實際刪除任何檔案。' -ForegroundColor Yellow
    Write-Host ''
}

# ---------------------------------------------------------------------------
# 執行記錄：開始
# ---------------------------------------------------------------------------
Write-ExecutionLog ("開始：模式={0}，瀏覽器={1}，保留={2}" -f `
    ($(if ($DryRun) { 'DryRun' } else { '實際清理' })), `
    (($existing | ForEach-Object { $_.Name }) -join '/'), `
    ($(if ($keptDesc.Count -gt 0) { $keptDesc -join '/' } else { '無' })))

# ---------------------------------------------------------------------------
# 執行前確認（防呆：避免學生亂按 Enter 通過；需明確輸入 YES）
# 設定檔 RequireConfirmation=false 或 -DryRun 時不觸發
# ---------------------------------------------------------------------------
if (-not $DryRun -and $config.RequireConfirmation) {
    Write-Host ''
    Write-Host '▸ 即將實際清除：快取、歷史紀錄、Cookie（需重新登入網站）、下載紀錄、表單資料' -ForegroundColor Yellow
    if ($script:KeepPasswords) {
        Write-Host '▸ 已依設定保留儲存的密碼/登入資料' -ForegroundColor Green
    }
    else {
        Write-Host '▸ 連儲存的密碼/登入資料也會一併清除！' -ForegroundColor Yellow
    }
    Write-Host ''
    $answer = Read-Host '此操作清除後無法復原。確定要執行？輸入 YES 繼續，其他輸入則取消'
    if ($answer -cne 'YES') {
        Write-Host '已取消清理。' -ForegroundColor Yellow
        Write-ExecutionLog '取消：使用者未輸入 YES'
        exit 1
    }
    Write-ExecutionLog '已確認（使用者輸入 YES）'
}

# ---------------------------------------------------------------------------
# 關閉執行中的瀏覽器
# ---------------------------------------------------------------------------
$procNames = @($existing | ForEach-Object { $_.Proc })
$running = @(Get-Process -Name $procNames -ErrorAction SilentlyContinue)

if ($running.Count -gt 0) {
    $names = (($running | Select-Object -ExpandProperty ProcessName | Sort-Object -Unique) -join '、')
    if ($DryRun) {
        Write-Warning "瀏覽器正在執行中：$names（模擬模式不會關閉程式）"
    }
    elseif ($Force) {
        Write-Host "正在關閉執行中的瀏覽器：$names ..." -ForegroundColor Yellow
        Write-ExecutionLog "強制關閉瀏覽器程序：$names"
        $running | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
    else {
        $answer = Read-Host "偵測到瀏覽器正在執行（$names）。清理前必須先關閉，是否自動關閉並繼續？[Y/n]"
        if ($answer -and $answer -notmatch '^[yY]') {
            Write-Host '已取消清理。' -ForegroundColor Yellow
            Write-ExecutionLog '取消：使用者選擇不關閉瀏覽器'
            exit 1
        }
        Write-ExecutionLog "關閉瀏覽器程序：$names"
        $running | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
    }
}

# ---------------------------------------------------------------------------
# 執行清理
# ---------------------------------------------------------------------------
$summary = @()
$totalFreed = 0L

foreach ($target in $existing) {
    $script:ItemDeleted = 0
    $label = if ($DryRun) { '分析' } else { '清理' }
    Write-Host ("▸ {0} {1} ..." -f $label, $target.Name) -ForegroundColor Green

    $freed = 0L
    if ($target.Kind -eq 'chromium') {
        $freed = Clear-ChromiumTarget -Target $target -DryRun ([bool]$DryRun)
    }
    else {
        $freed = Clear-FirefoxTarget -Target $target -DryRun ([bool]$DryRun) -KeepBookmarks ([bool]$script:KeepHistory)
    }

    $totalFreed += $freed
    $summary += [pscustomobject]@{
        瀏覽器   = $target.Name
        項目數   = $script:ItemDeleted
        釋出空間 = Format-Size -Bytes $freed
        狀態     = if ($DryRun) { '模擬' } else { '已清理' }
    }
    Write-ExecutionLog ("{0} {1}：項目={2}，釋出={3}" -f $target.Name, $label, $script:ItemDeleted, (Format-Size -Bytes $freed))
}

# ---------------------------------------------------------------------------
# 報表
# ---------------------------------------------------------------------------
Write-Host ''
$summary | Format-Table -AutoSize | Out-String | Write-Host
Write-Host ("合計釋出空間：{0}" -f (Format-Size -Bytes $totalFreed)) -ForegroundColor Cyan

if ($DryRun) {
    Write-Host '（以上為模擬結果，未刪除任何檔案。加 -Force 可執行實際清理。）' -ForegroundColor Yellow
    Write-ExecutionLog ("完成（模擬）：合計釋出={0}" -f (Format-Size -Bytes $totalFreed))
}
else {
    if ($script:KeepPasswords) {
        Write-Host '清理完成。儲存的密碼已依設定保留，但 Cookie 已清除，下次開啟瀏覽器時需重新登入網站，分頁將重新載入。' -ForegroundColor Cyan
    }
    else {
        Write-Host '清理完成。下次開啟瀏覽器時需重新登入網站，分頁將重新載入。' -ForegroundColor Cyan
    }
    Write-ExecutionLog ("完成（實際）：合計釋出={0}" -f (Format-Size -Bytes $totalFreed))
}
Write-Host ''
