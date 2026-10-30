# =====================================================================
# UWF-Tool.ps1 — 教室機「開機還原」整合工具(方案 A:UWF 單檔版)
# 由 Setup-UWF.ps1 / Maintenance-ON.ps1 / Maintenance-OFF.ps1 / Remove-UWF.ps1
# 整合而成,並自動提權、自動接續「完全移除」的第二階段。
#
# 適用:Windows 10/11 Enterprise、Education、IoT Enterprise、LTSC(需含 UWF)
# 執行方式(需管理員;通常雙擊同目錄的 UWF-Tool.bat 即可):
#   powershell -ExecutionPolicy Bypass -File "本檔路徑\UWF-Tool.ps1"
# =====================================================================

# uwfmgr 只在 UWF 功能安裝後才存在,所以這裡刻意不用 $ErrorActionPreference='Stop'
# 也先不做全局嚴格要求;各動作內自行檢查環境,避免小錯炸掉整個工具。
$ErrorActionPreference = 'Continue'

# ---------------- 自我提權(不是管理員就重新以管理員啟動自己) ----------------
$id  = [Security.Principal.WindowsIdentity]::GetCurrent()
$pri = New-Object Security.Principal.WindowsPrincipal($id)
if (-not $pri.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    Start-Process powershell.exe -Verb RunAs -ArgumentList `
        '-NoProfile','-ExecutionPolicy','Bypass','-File',"`"$PSCommandPath`""
    exit
}

# ---------------- 常數與共用函式 ----------------
$Keep       = 'C:\__KEEP'
$Flag       = Join-Path $Keep 'UWF-Remove-Phase2.flag'
$UWFFeature = 'Client-UnifiedWriteFilter'

function Test-UwfCmd {
    # uwfmgr.exe 在 UWF 功能安裝後才出現在 System32;不存在回 $false
    return [bool](Get-Command uwfmgr -ErrorAction SilentlyContinue)
}

function Get-UWFFeatureState {
    # 回傳 dism 看到的功能狀態(Enabled / Disabled / EnablePending …);不支援則回 $null
    $d = dism /Online /Get-FeatureInfo /FeatureName:$UWFFeature 2>&1 | Out-String
    if ($d -match '(?:State|狀態)\s*:\s*(\S+)') { return $Matches[1] }
    return $null
}

function Get-UWFFilterState {
    # 從 uwfmgr get-config 抓目前過濾器狀態;uwfmgr 不存在或抓不到回 $null
    if (-not (Test-UwfCmd)) { return $null }
    $d = uwfmgr get-config 2>&1 | Out-String
    if ($d -match 'Filter state\s*:\s*(\S+)' -or $d -match '篩選狀態\s*:\s*(\S+)') { return $Matches[1] }
    return $null
}

function Confirm-Reboot {
    $ans = Read-Host '要現在立即重開機嗎?(Y/N)'
    if ($ans -match '^[Yy]') { Restart-Computer -Force }
}

function Pause-Enter {
    ''
    Read-Host '按 Enter 回到選單' | Out-Null
}

# ---------------- 1) 安裝 / 重設 UWF ----------------
function Do-Setup {
    ''
    '『1) 安裝 / 重設 UWF 開機還原』'
    ''

    '1) 檢查 UWF 功能是否存在 …'
    $state = Get-UWFFeatureState
    if (-not $state) {
        "  ✗ 這個 Windows 版本不包含 UWF($UWFFeature)。"
        '  請改用方案 B(VHD 差異磁碟開機),詳見上層目錄 README.md。'
        return
    }
    "  ✓ 功能存在(目前狀態:$state)"
    ''

    $mb = Read-Host '疊層上限 MB(一次開機期間最多可寫入量,直接 Enter = 16384)'
    if ([string]::IsNullOrWhiteSpace($mb)) { $mb = 16384 }
    while (-not ($mb -match '^\d+$' -and [int]$mb -ge 512)) {
        $mb = Read-Host '請輸入 ≥512 的整數(直接 Enter = 16384)'
        if ([string]::IsNullOrWhiteSpace($mb)) { $mb = 16384 }
    }
    $mb = [int]$mb

    "2) 啟用 UWF 功能(DISM)…"
    dism /Online /Enable-Feature /FeatureName:$UWFFeature /All /NoRestart | Out-String | Write-Host

    "3) 等待 uwfmgr 出現(功能安裝完成後才會有)…"
    if (-not (Test-UwfCmd)) {
        '  ✗ uwfmgr 仍不存在:功能可能已排定安裝但還沒就緒。'
        '  → 請重開機一次,再執行本選項完成其餘設定。'
        return
    }
    '  ✓ uwfmgr 就緒。'

    "4) 設定疊層:模式 disk、上限 {0} MB …" -f $mb
    uwfmgr overlay set-type disk
    uwfmgr overlay set-maximum $mb

    "5) 保護 C: 磁碟 …"
    uwfmgr volume protect C:

    "6) 建立並排除保留區 {0}(放教材/收作業,重開機不消失)…" -f $Keep
    New-Item -ItemType Directory -Force -Path $Keep | Out-Null
    uwfmgr file add-exclusion "$Keep"

    "7) 清掉先前未完成的移除旗標(若有)…"
    if (Test-Path $Flag) { Remove-Item $Flag -Force; '  已清除' } else { '  無' }

    "8) 啟用過濾器(下次重開機生效)…"
    uwfmgr filter enable

    ''
    '=' * 55
    '  安裝完成。重開機一次後生效:'
    '  ● 之後每次重開機,C: 回到乾淨狀態'
    "  ● $Keep 放進去的檔案永遠保留"
    '  ● 疊層寫滿 Windows 會強制重開機清空,請勿在 C: 大量寫入'
    '=' * 55
    Confirm-Reboot
}

# ---------------- 2) 查看目前狀態 ----------------
function Do-Status {
    ''
    '『2) 目前 UWF 狀態』'
    ''
    "OS`t`t: " + (Get-CimInstance Win32_OperatingSystem).Caption
    $st = Get-UWFFeatureState
    "UWF 功能`t: " + $(if ($st) { $st } else { '不存在(此版本無 UWF)' })
    $fs = Get-UWFFilterState
    "過濾器`t: " + $(if ($null -ne $fs) { $fs } else { '未知(uwfmgr 尚未安裝)' })
    ''
    if (Test-UwfCmd) {
        '--- uwfmgr get-config ---'
        uwfmgr get-config 2>&1 | Out-String | Write-Host
        if ($fs -match '^on$') {
            '--- 本次開機疊層使用量 ---'
            uwfmgr overlay get-consumption 2>&1 | Out-String | Write-Host
        }
    } else {
        'uwfmgr 尚未安裝,無法顯示詳細設定。'
        '→ 若 UWF 功能存在(見上),執行選項 1 即會安裝功能並完成設定。'
    }
    ''
    $keep  = if (Test-Path $Keep) { '存在' } else { '不存在' }
    $flagf = if (Test-Path $Flag) { '有 → 選項 5 會自動接續第二階段(移除功能元件)' } else { '無' }
    "保留區 $Keep : $keep"
    "未完成移除的旗標: $flagf"
}

# ---------------- 3) 進入維護模式 ----------------
function Do-MaintOn {
    ''
    '『3) 進入維護模式(暫停開機還原)』'
    if (-not (Test-UwfCmd)) {
        '✗ uwfmgr 尚未安裝(UWF 還沒安裝)。請先執行選項 1。'
        return
    }
    '用途:安裝新程式、Windows Update、改系統設定──這些你想「永久保留」的事。'
    ''
    '正在送出 UWF filter disable …'
    uwfmgr filter disable
    ''
    '=' * 55
    '  已送出暫停指令。下一步:重開機一次 →'
    '  本次開機起 C: 完全可寫,任何修改都會永久保留(成為新基準)。'
    '  改完後務必用選項 4 結束維護模式,否則教室機會一直保留變更!'
    '=' * 55
    Confirm-Reboot
}

# ---------------- 4) 結束維護模式 ----------------
function Do-MaintOff {
    ''
    '『4) 結束維護模式(恢復開機還原)』'
    if (-not (Test-UwfCmd)) {
        '✗ uwfmgr 尚未安裝(UWF 還沒安裝)。請先執行選項 1。'
        return
    }
    ''
    '正在送出 UWF filter enable …'
    uwfmgr filter enable
    ''
    '=' * 55
    '  已送出恢復指令。重開機後生效:'
    '  ● 每次重開機 → C: 回到「現在這個狀態」(含你剛裝的新程式)'
    "  ● $Keep 例外:裡面的檔案永遠保留"
    '=' * 55
    Confirm-Reboot
}

# ---------------- 5) 完全移除 UWF(自動兩階段) ----------------
function Do-Remove {
    ''
    '『5) 完全移除 UWF,回到一般可寫入的 C:』'
    ''
    $st = Get-UWFFeatureState
    if (-not $st) { '  UWF 功能本來就不存在,沒有東西可移除。'; return }

    if (Test-Path $Flag) {
        # 第一階段已做過(過濾器已於重開機後停止)→ 這裡做第二階段
        '第二階段:移除 UWF 功能元件(DISM)…'
        dism /Online /Disable-Feature /FeatureName:$UWFFeature /NoRestart
        Remove-Item $Flag -Force -ErrorAction SilentlyContinue
        ''
        '=' * 55
        '  已送出移除指令。重開機一次即完全移除。'
        '  收尾提醒(手動清理):'
        "  - $Keep 不需要就自行刪除。"
        '  - 如需恢復休眠/快速啟動:powercfg /h on'
        '=' * 55
        Confirm-Reboot
        return
    }

    if (-not (Test-UwfCmd)) {
        '✗ uwfmgr 尚未安裝(UWF 還沒安裝),不需要移除。'
        return
    }

    '第一階段:關閉過濾器 …'
    uwfmgr filter disable
    uwfmgr volume unprotect C: 2>$null
    ''
    "確保 {0} 存在並被排除(旗標要放這裡才撐得過還原的重開機)…" -f $Keep
    New-Item -ItemType Directory -Force -Path $Keep | Out-Null
    uwfmgr file add-exclusion "$Keep"
    Set-Content -Path $Flag -Value "remove-phase2 requested at $(Get-Date -Format s)" -Encoding UTF8

    ''
    '=' * 55
    '  第一階段完成。'
    '  → 重開機後,C: 恢復正常寫入(UWF 停止作用)。'
    '  → 重開機後再執行本工具的「選項 5」一次,'
    '     會自動偵測旗標並接續第二階段(移除功能元件)。'
    '  ※ 注意:若 C:\__KEEP 是這次才新建立的,重開機後旗標可能被還原清掉;'
    '    屆時用選項 2 查看旗標,若顯示「無」,請重跑一次選項 5。'
    '=' * 55
    Confirm-Reboot
}

# ---------------- 6) 新增保留資料夾(排除區) ----------------
function Do-Exclusion {
    ''
    '『6) 新增保留資料夾(排除區)』'
    if (-not (Test-UwfCmd)) {
        '✗ uwfmgr 尚未安裝(UWF 還沒安裝)。請先執行選項 1。'
        return
    }
    '排除區內的檔案重開機不消失;變更下次重開機後生效。'
    '※ 目前僅保護 C:,所以只要填 C: 內的路徑就有意義;'
    '  D: 等未受保護的磁碟本來就不會被還原。'
    ''
    $p = Read-Host '要永久保留的資料夾(例:C:\__KEEP\教材,直接 Enter 取消)'
    if ([string]::IsNullOrWhiteSpace($p)) { return }
    if (-not (Test-Path $p)) {
        $mk = Read-Host '資料夾不存在,要順便建立嗎?(Y/N)'
        if ($mk -match '^[Yy]') { New-Item -ItemType Directory -Force -Path $p | Out-Null }
    }
    uwfmgr file add-exclusion "$p"
    ''
    '已加入排除區(下次重開機生效)。用選項 2 可確認。'
}

# ---------------- 主選單 ----------------
$running = $true
while ($running) {
    Clear-Host
    Write-Host '╔═══════════════════════════════════════════════╗'
    Write-Host '║  教室機開機還原工具(UWF 單檔整合版)          ║'
    Write-Host '╠═══════════════════════════════════════════════╣'
    $fstate = Get-UWFFeatureState
    $hint = if (-not $fstate) {
                '此版 Windows 無 UWF → 請用方案 B(VHD)'
            } elseif (-not (Test-UwfCmd)) {
                'UWF 功能尚未安裝 → 執行選項 1 即可'
            } else {
                $fs = Get-UWFFilterState
                if ($fs -match '^on$') { '目前:還原「開啟中」' }
                elseif ($fs) { "目前:還原「停用中」($fs)" }
                else { '目前:過濾器狀態未知' }
            }
    Write-Host ("║  {0,-41}  ║" -f $hint)
    if (Test-Path $Flag) {
        Write-Host '║  ※ 偵測到未完成的移除程序,選項 5 會自動接續  ║'
    }
    Write-Host '╠═══════════════════════════════════════════════╣'
    Write-Host '║  1) 安裝 / 重設 UWF 開機還原                  ║'
    Write-Host '║  2) 查看目前 UWF 狀態                         ║'
    Write-Host '║  3) 進入維護模式(暫停還原,重開機後可修改)  ║'
    Write-Host '║  4) 結束維護模式(恢復開機還原)              ║'
    Write-Host '║  5) 完全移除 UWF(自動兩階段)                ║'
    Write-Host '║  6) 新增保留資料夾(排除區)                  ║'
    Write-Host '║  0) 離開                                      ║'
    Write-Host '╚═══════════════════════════════════════════════╝'

    $choice = Read-Host '請選擇'
    if ($choice -match '^[1-6]$') {
        try {
            switch ($choice) {
                '1' { Do-Setup }
                '2' { Do-Status }
                '3' { Do-MaintOn }
                '4' { Do-MaintOff }
                '5' { Do-Remove }
                '6' { Do-Exclusion }
            }
        } catch {
            ''
            Write-Host ('發生錯誤:' + $_.Exception.Message) -ForegroundColor Red
            '動作已中止,系統沒有被改壞;可回選單重試或先選 2 看狀態。'
        }
        Pause-Enter
    } elseif ($choice -eq '0') {
        $running = $false
    }
}
