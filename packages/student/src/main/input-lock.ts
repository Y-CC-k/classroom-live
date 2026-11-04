import { spawn, type ChildProcess } from 'node:child_process';

import { getNativeBinding } from './modules/native-control.js';

/**
 * 輸入鎖定（教師端「鎖定全班」）：
 *
 *   以低階鍵盤／滑鼠 hook（WH_KEYBOARD_LL／WH_MOUSE_LL）封鎖所有輸入。
 *   畫面刻意不動：正在廣播就繼續顯示廣播全螢幕，沒在廣播就維持原畫面，
 *   學生的視覺完全不打斷，只是按不出任何東西。
 *
 * 兩種實作，優先原生：
 *   1. native（首選）：classroom_input.node 內建 LL hook（專用執行緒泵訊息）。
 *      不依賴 PowerShell——學校電腦常見 CLM（Constrained Language Mode）會讓
 *      Add-Type 失敗，PS 路線在那些機器上整組失效。
 *   2. ps（fallback）：常駐 PowerShell 行程（內嵌 C#）。行程被砍掉 hook 即
 *      失效、輸入自動還原。
 *
 * Ctrl+Alt+Del 走安全桌面（winlogon），不受 hook 影響，是求援出口。
 */

const RESPAWN_INTERVAL_MS = 3_000;

/**
 * 輸入封鎖腳本。必須純 ASCII（PS 5.1 對無 BOM 檔按 ANSI 讀）、C# 5。
 * LL hook 的工作執行緒必須持續泵訊息（Application.Run）事件才會進來，
 * 行程結束（被 taskkill）時 hook 自動解除，輸入立即還原。
 */
const INPUT_BLOCKER_PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

public static class InputBlock
{
    public delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);
    private const int WH_KEYBOARD_LL = 13;
    private const int WH_MOUSE_LL = 14;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")]
    private static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetModuleHandle(string lpModuleName);

    private static IntPtr kbdHook = IntPtr.Zero;
    private static IntPtr mouseHook = IntPtr.Zero;

    private static IntPtr KbdProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0) return (IntPtr)1;
        return CallNextHookEx(kbdHook, nCode, wParam, lParam);
    }

    private static IntPtr MouseProc(int nCode, IntPtr wParam, IntPtr lParam)
    {
        if (nCode >= 0) return (IntPtr)1;
        return CallNextHookEx(mouseHook, nCode, wParam, lParam);
    }

    public static string Start()
    {
        IntPtr mod = GetModuleHandle(null);
        kbdHook = SetWindowsHookEx(WH_KEYBOARD_LL, KbdProc, mod, 0);
        mouseHook = SetWindowsHookEx(WH_MOUSE_LL, MouseProc, mod, 0);
        return (kbdHook != IntPtr.Zero ? "1" : "0") + "/" + (mouseHook != IntPtr.Zero ? "1" : "0");
    }
}
'@
Add-Type -AssemblyName System.Windows.Forms
Write-Output ("HOOK " + [InputBlock]::Start())
# Pump messages forever; the only intended exit is our Process.Kill().
[System.Windows.Forms.Application]::Run()
`.trim();

/** 鎖定實作模式：native＝原生模組 LL hook；ps＝PowerShell 行程（fallback） */
type LockMode = 'native' | 'ps';

interface LockLog {
  (line: string): void;
}

export class InputLocker {
  private active = false;
  private mode: LockMode | null = null;
  private blocker: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private log: LockLog;

  constructor(log?: LockLog) {
    this.log = log ?? (() => undefined);
  }

  isActive(): boolean {
    return this.active;
  }

  /** 目前使用的實作模式（診斷用；未啟用時為 null） */
  getMode(): LockMode | null {
    return this.mode;
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;

    if (on) {
      // 原生鉤子優先；native 模組沒載入／啟動失敗才退回 PowerShell
      this.mode = this.startNativeHook() ? 'native' : 'ps';
      if (this.mode === 'ps') this.ensureBlocker();
      this.timer = setInterval(() => {
        if (!this.active) return;
        if (this.mode === 'native') {
          // 鉤子執行緒若被系統移除（逾時／panic）會反映在 hookIsBlocking
          const native = getNativeBinding();
          if (native && native.hookIsBlocking() && native.hookIsActive()) return;
          this.log('[lock] 原生鉤子失去攔截，重新啟動');
          if (this.startNativeHook()) return;
          this.mode = 'ps';
        }
        // PS 模式：hook 行程被砍掉／自然結束 → 立刻重開，封鎖才不會出現空窗。
        if (!this.blocker || this.blocker.exitCode !== null) {
          this.log('[lock] 輸入封鎖行程已離開，重新啟動');
          this.ensureBlocker();
        }
      }, RESPAWN_INTERVAL_MS);
      this.timer.unref?.();
      this.log(`[lock] 輸入鎖定：鍵盤滑鼠封鎖（畫面不動，模式=${this.mode}）`);
    } else {
      this.stopTimer();
      this.stopNativeHook();
      this.killBlocker();
      this.mode = null;
      this.log('[lock] 解除輸入鎖定');
    }
  }

  /** 行程結束前的清理：絕不能讓 hook 行程孤兒化（input 永遠被封鎖） */
  dispose(): void {
    this.stopTimer();
    this.stopNativeHook();
    this.killBlocker();
    this.active = false;
    this.mode = null;
  }

  /**
   * 啟動原生模組的 LL hook 並開始攔截。
   * @returns true 表示原生鉤子已生效；false 表示應退回 PowerShell
   */
  private startNativeHook(): boolean {
    const native = getNativeBinding();
    if (!native) {
      this.log('[lock] 原生模組未載入，改用 PowerShell 鉤子');
      return false;
    }
    try {
      const started = native.hookStart();
      const blocking = started ? native.hookSetBlocking(true) : false;
      if (started && blocking) {
        this.log('[lock] 原生鉤子已安裝並開始攔截（HOOK 1/1 via native）');
        return true;
      }
      this.log(
        `[lock] 原生鉤子啟動失敗（start=${started ? 1 : 0}, blocking=${blocking ? 1 : 0}），改用 PowerShell 鉤子`
      );
      try {
        native.hookStop();
      } catch {
        // 沒裝成功就算了
      }
      return false;
    } catch (error) {
      this.log(`[lock] 原生鉤子例外：${error instanceof Error ? error.message : String(error)}，改用 PowerShell 鉤子`);
      return false;
    }
  }

  /** 解除原生鉤子（只在 native 模式有意義；重複呼叫無害） */
  private stopNativeHook(): void {
    if (this.mode !== 'native') return;
    const native = getNativeBinding();
    if (!native) return;
    try {
      native.hookSetBlocking(false);
      native.hookStop();
    } catch {
      // 已停止就算了
    }
  }

  private stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private ensureBlocker(): void {
    // 使用 -EncodedCommand 繞過 PowerShell 執行原則（MachinePolicy/UserPolicy 會擋 -File）。
    // 參考 applyUpdate 的做法：base64(UTF-16LE) 內嵌完整腳本，不寫 .ps1 檔案。
    const ps = INPUT_BLOCKER_PS_SCRIPT.replace(/'/g, "''");
    const enc = Buffer.from(ps, 'utf16le').toString('base64');
    try {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
        { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      child.once('exit', code => {
        if (this.active) this.log(`[lock] 輸入封鎖行程結束（code=${code ?? 'null'}）`);
      });
      // 診斷：PowerShell 錯誤（Add-Type 失敗等）會出現在 stderr——顯示到學生日誌
      child.stderr?.on('data', (chunk: Buffer) => {
        const t = String(chunk).trim();
        if (t) this.log(`[lock][ps] ${t.split('\n')[0]?.substring(0, 120) ?? ''}`);
      });
      // 開頭會印一列 HOOK 1/1，用來記錄兩個 hook 是否都安裝成功
      child.stdout?.once('data', (chunk: Buffer) => {
        this.log(`[lock] ${String(chunk).split('\n')[0]?.trim() ?? ''}`);
      });
      this.blocker = child;
    } catch (error) {
      this.log(`[lock] 無法啟動輸入封鎖行程：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private killBlocker(): void {
    const child = this.blocker;
    this.blocker = null;
    if (!child) return;
    try {
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.kill();
    } catch {
      // 已離開就算了
    }
  }
}
