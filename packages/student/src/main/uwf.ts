/**
 * uwf.ts — 開機還原（UWF, Unified Write Filter）遙控的學生機端實作。
 *
 * 為什麼不直接執行 uwfmgr？
 *   UWF 指令需要 SYSTEM／管理員權限，而學生機平時以一般使用者（或未提權的
 *   進程）跑本程式，直接執行會被擋，跳 UAC 又沒人按。所以採用老牌的
 *   「最高權限排程任務」模式：
 *
 *     1. 「初始化」時在**學生機螢幕**跳一次 UAC → 建立 SYSTEM 任務
 *        ClassroomUWFTask（之後永遠免 UAC）。
 *     2. 平時動作：本程序把請求寫進工作資料夾 → `schtasks /Run` 觸發任務
 *        → 助手腳本（SYSTEM）執行 uwfmgr/dism → 結果寫回 JSON。
 *     3. 本程序輪詢結果檔交回 renderer，由 renderer 經 evt 通道回報教師。
 *
 * **重開機原則：本模組一律不自動重開機。** 安裝／移除／維護模式切換都需要
 * 重開機才生效，剛好這些動作效果都極長——重開的時機由教師端統一掌握
 * （「重開機全班」按鈕），學生端只回報「需要重開機」。
 *
 * 助手腳本刻意大部分 ASCII（uwfmgr 輸出本來就是英文；避免 code page 950 的坑）。
 */

import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 排程任務名稱 */
export const UWF_TASK_NAME = 'ClassroomUWFTask';
/** 教師機可下達的 UWF 動作 */
export type UwfAction =
  | 'setup' // 初始化排程任務（跳一次 UAC）
  | 'install' // 安裝/重設 UWF 開機還原（dism + uwfmgr，需重開機生效）
  | 'status' // 查狀態
  | 'maint-on' // 維護模式開（暫停還原，需重開機生效）
  | 'maint-off' // 維護模式關（恢復還原，需重開機生效）
  | 'remove' // 完全移除（兩階段，中間各重開機一次）
  | 'set-exclusion'; // 加入排除區資料夾（req.path）

/** 工作資料夾：ProgramData 預設允許 Users 建立子資料夾與檔案，不用提權即可寫 */
const WORK_DIR = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'ClassroomUWF');
const RUN_SCRIPT = path.join(WORK_DIR, 'uwf-run.ps1');
const REQUEST_FILE = path.join(WORK_DIR, 'request.json');
const TASK_VERSION_FILE = path.join(WORK_DIR, 'task-created.txt');

/** 等待結果檔的最久時間：install/status 會跑 dism（慢） */
const RESULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 500;

export interface UwfRequest {
  id: string;
  action: UwfAction;
  path?: string;
  ts: number;
}

export interface UwfResult {
  ok: boolean;
  text: string;
  rebooting?: boolean;
}

/* ─────────────────────────── 助手腳本（SYSTEM 執行） ─────────────────────────── */

/**
 * uwf-run.ps1 — 排程任務的 body。讀請求 JSON → 執行對應 uwfmgr/dism → 寫結果 JSON。
 * 注意：-split 用單引號正則 '\r\n'（不能用反引號 `r`n——那是雙引號字串的跳脫，
 * 會被 PowerShell 5.1 看得懂但與我們的腳本無關；這裡保持一致用 .NET 正則）。
 */
const RUN_SCRIPT_BODY = String.raw`
param([string] $RequestFile)

$ErrorActionPreference = 'Continue'
$Utf8 = [System.Text.Encoding]::UTF8
$Keep = 'C:\__KEEP'
$Flag = Join-Path $Keep 'UWF-Remove-Phase2.flag'
$UWFFeature = 'Client-UnifiedWriteFilter'

function Write-Result([string] $Path, [bool] $Ok, [string] $Text, [bool] $Rebooting) {
    $obj = [pscustomobject]@{ ok = $Ok; text = $Text; rebooting = $Rebooting }
    $json = $obj | ConvertTo-Json -Compress
    # 注意：static [Text.Encoding]::UTF8 寫檔「會帶 BOM」，Node 端 JSON.parse 會炸；
    # 這裡用不帶 BOM 的 UTF8Encoding($false)
    $utf8NoBom = New-Object System.Text.UTF8Encoding([bool]$false)
    [System.IO.File]::WriteAllText($Path, $json, $utf8NoBom)
}

if (-not (Test-Path $RequestFile)) { exit 1 }
$req = Get-Content -Raw $RequestFile | ConvertFrom-Json
$id = [string]$req.id
$action = [string]$req.action
$exclPath = [string]$req.path
$resultPath = Join-Path $PSScriptRoot ("result-" + $id + ".json")

function Get-FilterState {
    # 文字解析在繁中機會被連值一起翻譯成「開啟／關閉」而失敗（亂碼線索證實）。
    # 改用 UWF 的 WMI 供應商：CurrentSessionEnabled 直接是 bool，完全語系無關；
    # 文字路徑只當 WMI 拿不到時的備援。
    try {
        $f = Get-WmiObject -Namespace 'root\standardcimv2\embedded' -Class 'UWF_Filter' -ErrorAction Stop
        if ($null -ne $f) {
            if ($f.CurrentSessionEnabled) { return 'ON' }
            return 'OFF'
        }
    } catch { }
    $d = uwfmgr get-config 2>&1 | Out-String
    $m = [regex]::Match($d, '(Filter|篩選)[^\r\n]*[:：]\s*(ON|OFF|開啟|關閉|OPEN|CLOSE)', 'IgnoreCase')
    if ($m.Success) {
        $v = $m.Groups[2].Value.ToUpperInvariant()
        if ($v -eq '開啟' -or $v -eq 'OPEN') { return 'ON' }
        if ($v -eq '關閉' -or $v -eq 'CLOSE') { return 'OFF' }
        return $v
    }
    return $null
}

function Get-Snippet([string]$d) {
    # 解析失敗時帶得出線索的前兩行（壓空白）
    if (-not $d) { return '' }
    $head = ($d.Trim() -split '\r?\n') | Select-Object -First 2
    $s = ($head -join ' | ') -replace '\s+', ' '
    if ($s.Length -gt 90) { $s = $s.Substring(0, 90) }
    return $s
}

function Get-FeatureState {
    # dism 輸出英文是 "State : Enabled"，繁中機是「狀態 : 已啟用」；兩種都認。
    $d = dism /Online /Get-FeatureInfo /FeatureName:$UWFFeature 2>&1 | Out-String
    if ($d -match '(?:State|狀態)\s*[:：]\s*(\S+)') { return $Matches[1].ToUpperInvariant() }
    if ($d -match '已啟用|已安裝') { return 'ENABLED' }
    if ($d -match '已停用|未安裝|尚未安裝') { return 'DISABLED' }
    return $null
}

$feature = Get-FeatureState

switch ($action) {
    'status' {
        if (-not (Get-Command uwfmgr -ErrorAction SilentlyContinue)) {
            $t = 'feature=' + $(if ($feature) { $feature } else { 'MISSING' }) + '; uwfmgr not ready (reboot once after install)'
            Write-Result $resultPath ($null -ne $feature) $t $false
            exit 0
        }
        $filter = Get-FilterState
        $t = 'Filter=' + $(if ($filter) { $filter } else { 'UNKNOWN' }) + '; feature=' + $(if ($feature) { $feature } else { '?' })
        if (-not $filter -or -not $feature) {
            # 解析不到就把原始輸出片段帶回去（語系、狀態一眼可辨）
            $headU = ''
            try { $headU = Get-Snippet ((uwfmgr get-config 2>&1) | Out-String) } catch { }
            $t = $t + '（解析失敗線索：' + $headU + '）'
        }
        if ($filter -eq 'ON') {
            $cons = uwfmgr overlay get-consumption 2>&1 | Out-String
            # 輸出會被翻譯：抓第一個數字就對（格式如「目前使用量: 30 MB / 上限 16384 MB」）
            $num = [regex]::Match($cons, '\d+(?:[.,]\d+)?')
            if ($num.Success) {
                $t = $t + '; overlay=' + $num.Value
            }
        }
        if (Test-Path $Flag) { $t = $t + '; remove phase2 pending' }
        Write-Result $resultPath ($null -ne $filter) $t $false
        exit 0
    }
    'install' {
        # 安裝/重設 UWF 開機還原（等價單機版工具選項 1；**不**自動重開機）
        if (-not $feature) {
            Write-Result $resultPath $false 'this Windows edition has no UWF' $false
            exit 0
        }
        dism /Online /Enable-Feature /FeatureName:$UWFFeature /All /NoRestart 2>&1 | Out-Null
        if (-not (Get-Command uwfmgr -ErrorAction SilentlyContinue)) {
            Write-Result $resultPath $true 'feature enabled - REBOOT once, then run install again to finish setup' $true
            exit 0
        }
        uwfmgr overlay set-type disk | Out-Null
        uwfmgr overlay set-maximum 16384 | Out-Null
        uwfmgr volume protect C: | Out-Null
        if (-not (Test-Path $Keep)) { New-Item -ItemType Directory -Force -Path $Keep | Out-Null }
        uwfmgr file add-exclusion $Keep | Out-Null
        if (Test-Path $Flag) { Remove-Item $Flag -Force -ErrorAction SilentlyContinue }
        uwfmgr filter enable | Out-Null
        Write-Result $resultPath $true 'UWF installed: protect C:, keep C:\__KEEP, overlay max 16 GB - REBOOT to take effect' $true
        exit 0
    }
    'maint-on' {
        if (-not (Get-Command uwfmgr -ErrorAction SilentlyContinue)) {
            Write-Result $resultPath $false 'uwfmgr not installed; run install first' $false
            exit 0
        }
        $out = uwfmgr filter disable 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) {
            Write-Result $resultPath $true 'Maintenance ON - restore paused after reboot' $false
        } else {
            Write-Result $resultPath $false ('filter disable FAILED: ' + ($out.Trim() -split '\r\n')[0]) $false
        }
        exit 0
    }
    'maint-off' {
        if (-not (Get-Command uwfmgr -ErrorAction SilentlyContinue)) {
            Write-Result $resultPath $false 'uwfmgr not installed; run install first' $false
            exit 0
        }
        $out = uwfmgr filter enable 2>&1 | Out-String
        if ($LASTEXITCODE -eq 0) {
            Write-Result $resultPath $true 'Maintenance OFF - restore active after reboot' $false
        } else {
            Write-Result $resultPath $false ('filter enable FAILED: ' + ($out.Trim() -split '\r\n')[0]) $false
        }
        exit 0
    }
    'remove' {
        # 完全移除 UWF（等價單機版工具選項 5；兩階段，中間各重開機一次）
        if (-not $feature) {
            Write-Result $resultPath $true 'UWF feature not present - nothing to remove' $false
            exit 0
        }
        if (Test-Path $Flag) {
            # 第二階段：移除功能元件（dism /NoRestart）
            dism /Online /Disable-Feature /FeatureName:$UWFFeature /NoRestart 2>&1 | Out-Null
            Remove-Item $Flag -Force -ErrorAction SilentlyContinue
            Write-Result $resultPath $true 'Phase 2 done: feature removal scheduled - REBOOT once to finish' $true
            exit 0
        }
        if (-not (Get-Command uwfmgr -ErrorAction SilentlyContinue)) {
            Write-Result $resultPath $false 'uwfmgr not installed - nothing to remove' $false
            exit 0
        }
        # 第一階段：停過濾器 + 放旗標（旗標要放在 UWF 排除區才撐得過還原的重開機）
        uwfmgr filter disable | Out-Null
        uwfmgr volume unprotect C: 2>$null | Out-Null
        if (-not (Test-Path $Keep)) { New-Item -ItemType Directory -Force -Path $Keep | Out-Null }
        uwfmgr file add-exclusion $Keep | Out-Null
        Set-Content -Path $Flag -Value ('remove phase2 requested ' + (Get-Date -Format s)) -Encoding UTF8
        Write-Result $resultPath $true 'Phase 1 done: filter disabled - REBOOT, then run remove again for phase 2' $true
        exit 0
    }
    'set-exclusion' {
        if (-not (Get-Command uwfmgr -ErrorAction SilentlyContinue)) {
            Write-Result $resultPath $false 'uwfmgr not installed; run install first' $false
            exit 0
        }
        if ([string]::IsNullOrWhiteSpace($exclPath)) {
            Write-Result $resultPath $false 'no path given' $false
            exit 0
        }
        if (-not (Test-Path $exclPath)) {
            New-Item -ItemType Directory -Force -Path $exclPath | Out-Null
        }
        uwfmgr file add-exclusion $exclPath | Out-Null
        $ok = ($LASTEXITCODE -eq 0)
        if ($ok) {
            Write-Result $resultPath $true ('Exclusion added (after reboot takes effect): ' + $exclPath) $false
        } else {
            Write-Result $resultPath $false ('add-exclusion FAILED: ' + $exclPath) $false
        }
        exit 0
    }
    default {
        Write-Result $resultPath $false ('unknown action: ' + $action) $false
        exit 0
    }
}
`;

/**
 * uwf-setup.ps1 — 初始化用的提權腳本（只跑一次、跳一次 UAC）：
 *   1) 建工作資料夾並給 Users 讀寫（請求/結果 JSON 要放這裡）
 *   2) 用 Register-ScheduledTask 建 SYSTEM 任務
 *   3) **允許所有使用者觸發**（SetSecurityDescriptor 給 WD 讀+執行），
 *      之後不論學生機登入哪個帳號都能 schtasks /Run。
 *   4) 寫 task-created.txt 標記，重跑會更新（冪等）。
 */
const SETUP_SCRIPT_BODY = String.raw`
$ErrorActionPreference = 'Stop'
$WorkDir = 'PLACEHOLDER_WORKDIR'
$TaskName = 'PLACEHOLDER_TASKNAME'
$RunScript = Join-Path $WorkDir 'uwf-run.ps1'
$logPath = Join-Path $WorkDir 'setup-result.txt'

try {
    if (-not (Test-Path $WorkDir)) { New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null }
    # Users 需要能讀結果檔、寫請求檔（ProgramData 子資料夾預設即可，明示更保險）
    icacls $WorkDir /grant 'Users:(OI)(CI)M' /Q | Out-Null

    $ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $args = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $RunScript + '" -RequestFile "' + $WorkDir + '\request.json"'
    $act = New-ScheduledTaskAction -Execute $ps -Argument $args -WorkingDirectory $WorkDir
    $trg = New-ScheduledTaskTrigger -Once -At (Get-Date).AddDays(365)
    $set = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $act -Trigger $trg -Settings $set -User 'SYSTEM' -RunLevel Highest -Force | Out-Null

    # 讓任何使用者都能「執行」這個任務（預設只有擁有者）。
    # 機型差異：PS 5.1 的 Get-ScheduledTask 物件上不見得有注入 SetSecurityDescriptor
    # 方法（會出現 CimInstance 不包含 SetSecurityDescriptor 的錯誤）。
    # 所以先試 direct，不成改走 COM Task Scheduler API（永遠存在）。
    $sddl = 'D:P(A;;FA;;;BA)(A;;FA;;;SY)(A;;FRFX;;;WD)'
    $sdDone = $false
    try {
        $task = Get-ScheduledTask -TaskName $TaskName
        $task.SetSecurityDescriptor($sddl, 0) | Out-Null
        $sdDone = $true
    } catch { Write-Host ('direct SetSecurityDescriptor 不可用，改走 COM：' + $_.Exception.Message) }
    if (-not $sdDone) {
        $svc = New-Object -ComObject Schedule.Service
        $svc.Connect()
        $registered = $svc.GetFolder('\').GetTask($TaskName)
        $registered.SetSecurityDescriptor($sddl, 0)
    }

    'task-created ' + (Get-Date -Format s) | Out-File -FilePath (Join-Path $WorkDir 'task-created.txt') -Encoding ascii
    'Setup OK: task ' + $TaskName + ' created as SYSTEM' | Out-File -FilePath $logPath -Encoding ascii
    exit 0
} catch {
    ('Setup FAILED: ' + $_.Exception.Message) | Out-File -FilePath $logPath -Encoding ascii
    exit 1
}
`;

/* ─────────────────────────────── 工具函式 ─────────────────────────────── */

function exec(cmd: string, args: string[], timeoutMs = 15_000): Promise<{ code: number; out: string }> {
  return new Promise(resolve => {
    execFile(cmd, args, { windowsHide: true, timeout: timeoutMs }, (error, stdout, stderr) => {
      const code = error
        ? typeof (error as { code?: number | string }).code === 'number'
          ? (error as { code: number }).code
          : ((error as { status?: number }).status ?? 1)
        : 0;
      resolve({
        code,
        out: `${stdout ?? ''}${stderr ?? ''}`.trim(),
      });
    });
  });
}

function newId(): string {
  return `u${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 工作資料夾 + 助手腳本是否已落地（PS1 一律加 BOM：PS 5.1 才會當 UTF-8 讀） */
function ensureWorkFiles(): void {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  fs.writeFileSync(RUN_SCRIPT, '\uFEFF' + RUN_SCRIPT_BODY.trimStart() + '\n', 'utf8');
}

/** 排程任務是否存在（初始化過一次）；檔案說有但系統查不到時清掉檔案自我修復 */
async function taskExists(): Promise<boolean> {
  if (fs.existsSync(TASK_VERSION_FILE)) {
    const r = await exec('schtasks', ['/Query', '/TN', UWF_TASK_NAME], 10_000);
    if (r.code === 0) return true;
    try {
      fs.unlinkSync(TASK_VERSION_FILE);
    } catch {
      /* 刪不掉就算了 */
    }
    // 確認失敗原因有沒有留下（任務被手動刪掉時 setup-result.txt 仍是舊的成功訊息，也清掉）
    try {
      fs.unlinkSync(path.join(WORK_DIR, 'setup-result.txt'));
    } catch {
      /* 同上 */
    }
    return false;
  }
  const r = await exec('schtasks', ['/Query', '/TN', UWF_TASK_NAME], 10_000);
  return r.code === 0;
}

/**
 * 一次性初始化：寫好工作檔 → 若任務不存在，跳一次 UAC 建任務。
 * 學生機螢幕會出現 UAC 視窗，由部署者（資訊組）按一次。
 */
function runElevatedSetup(): void {
  ensureWorkFiles();
  const setupScript = path.join(WORK_DIR, 'uwf-setup.ps1');
  const body = SETUP_SCRIPT_BODY.replaceAll('PLACEHOLDER_WORKDIR', WORK_DIR.replace(/'/g, "''")).replaceAll(
    'PLACEHOLDER_TASKNAME',
    UWF_TASK_NAME
  );
  fs.writeFileSync(setupScript, '\uFEFF' + body, 'utf8');

  // -Verb RunAs 會在學生機目前的使用者桌面跳 UAC；使用者按「是」才會開始
  const child = spawn(
    'powershell.exe',
    [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Start-Process -FilePath 'powershell.exe' -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile -ExecutionPolicy Bypass -File "${setupScript}"'`,
    ],
    { windowsHide: true, detached: false, stdio: 'ignore' }
  );
  child.unref();
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

/** 設定腳本寫的結果檔（成功：Setup OK…／失敗：Setup FAILED…） */
function readSetupLog(): string | null {
  try {
    return fs.readFileSync(path.join(WORK_DIR, 'setup-result.txt'), 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * 等初始化收尾：UAC 按「是」→ 設定腳本執行完會留 task-created.txt 與 setup-result.txt。
 * 每 2 秒檢查一次，最多等 setupTimeout 秒；回報「成功／失敗原因／沒按」。
 */
async function waitForSetupResult(setupTimeout = 150_000): Promise<UwfResult> {
  const deadline = Date.now() + setupTimeout;
  while (Date.now() < deadline) {
    if (fs.existsSync(TASK_VERSION_FILE)) {
      return { ok: true, text: '初始化成功：排程任務 ClassroomUWFTask 已建立' };
    }
    const log = readSetupLog();
    if (log?.startsWith('Setup FAILED')) {
      return { ok: false, text: `初始化失敗：${log.replace(/^Setup FAILED:\s*/, '')}` };
    }
    if (log?.startsWith('Setup OK')) {
      return { ok: true, text: '初始化成功：排程任務已建立' };
    }
    await sleep(2000);
  }
  return {
    ok: false,
    text: '初始化沒有完成（等了約 3 分鐘）：UAC 可能還沒按「是」、被按掉，或這台機器目前登入的使用者不是系統管理員（UAC 沒跳出來／要帳密）。請在學生機螢幕確認 UAC 視窗後再按一次「初始化還原」',
  };
}

/* ─────────────────────────────── 對外 API ─────────────────────────────── */

/**
 * 執行一個 UWF 動作，回傳給 renderer 的結果（renderer 再回報教師）。
 * - setup：跳 UAC 建任務，並等到結果落地才回報（成功／失敗原因／沒按會明說）
 * - 其他：經排程任務執行並等結果檔。本函式**永不主動重開機**——
 *   結果裡 `rebooting` 只代表「這個動作需要重開機才生效」，
 *   由教師端用「重開機全班」統一處理。
 */
export async function uwfAction(action: UwfAction, exclPath?: string): Promise<UwfResult> {
  ensureWorkFiles();

  if (action === 'setup') {
    if (await taskExists()) {
      return { ok: true, text: '已初始化（排程任務存在）' };
    }
    // 上次初始化留下的痕跡先清掉，確保這次拿到的結果是當下的
    try {
      fs.unlinkSync(TASK_VERSION_FILE);
    } catch {
      /* 不存在就算了 */
    }
    try {
      fs.unlinkSync(path.join(WORK_DIR, 'setup-result.txt'));
    } catch {
      /* 同上 */
    }
    runElevatedSetup();
    // 等 UAC 按下去、設定腳本跑完，直接回報真實結果（成功／失敗原因），
    // 不再像以前「送出後就算了」，教師端要自己按查狀態瞎猜。
    return await waitForSetupResult();
  }

  if (!(await taskExists())) {
    // 之前有初始化失敗過的話，直接把原因帶出來，教師端不用再猜
    const failLog = readSetupLog();
    const reason = failLog?.startsWith('Setup FAILED')
      ? `上次初始化失敗：${failLog.replace(/^Setup FAILED:\s*/, '')}`
      : undefined;
    return {
      ok: false,
      text: reason
        ? `${reason}；請在這台再按一次「初始化還原」並在 UAC 按「是」`
        : '尚未初始化：教師機先按「初始化還原」，在學生機螢幕上的 UAC 按「是」後再試',
    };
  }

  const id = newId();
  const req: UwfRequest = { id, action, ts: Date.now() };
  if (action === 'set-exclusion' && exclPath && exclPath.trim()) {
    req.path = exclPath.trim();
  }
  fs.writeFileSync(REQUEST_FILE, JSON.stringify(req), 'utf8');

  const run = await exec('schtasks', ['/Run', '/TN', UWF_TASK_NAME], 15_000);
  if (run.code !== 0) {
    return {
      ok: false,
      text: `無法觸發排程任務（schtasks /Run 退出碼 ${run.code}）：${run.out.slice(0, 120) || '不明原因'}`,
    };
  }

  // 等結果檔（dism 慢；本模組不重開機，結果一定會落地）
  const resultPath = path.join(WORK_DIR, `result-${id}.json`);
  const deadline = Date.now() + RESULT_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(resultPath)) {
      try {
        const raw = fs.readFileSync(resultPath, 'utf8');
        // 舊版助手腳本用 [Text.Encoding]::UTF8 寫檔會帶 BOM；剝掉再解析
        const body = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
        const parsed = JSON.parse(body) as UwfResult;
        return parsed;
      } catch (error) {
        // 帶上原始內容開頭，排版／編碼問題一眼可辨
        let head = '';
        try {
          head = fs.readFileSync(resultPath, 'utf8').slice(0, 160).replace(/\s+/g, ' ');
        } catch {
          /* 讀不到就空著 */
        }
        return {
          ok: false,
          text: `結果檔格式錯誤（${error instanceof Error ? error.message : String(error)}）內容前段：${head || '（空或讀不到）'}`,
        };
      }
    }
    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  return { ok: false, text: '等待結果逾時（排程任務可能未執行；請先「初始化」一次）' };
}
