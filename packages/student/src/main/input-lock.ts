import { spawn, type ChildProcess } from 'node:child_process';

/**
 * 輸入鎖定（教師端「鎖定全班」）：
 *
 *   以低階鍵盤／滑鼠 hook（WH_KEYBOARD_LL／WH_MOUSE_LL）封鎖所有輸入。
 *   畫面刻意不動：正在廣播就繼續顯示廣播全螢幕，沒在廣播就維持原畫面，
 *   學生的視覺完全不打斷，只是按不出任何東西。
 *
 * hook 由一個常駐的 PowerShell 行程執行（內嵌 C#，不吃 native 模組）；
 * 行程被砍掉 hook 即失效、輸入自動還原，所以解鎖最安全。
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

interface LockLog {
  (line: string): void;
}

export class InputLocker {
  private active = false;
  private blocker: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private log: LockLog;

  constructor(log?: LockLog) {
    this.log = log ?? (() => undefined);
  }

  isActive(): boolean {
    return this.active;
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;

    if (on) {
      this.ensureBlocker();
      this.timer = setInterval(() => {
        if (!this.active) return;
        // hook 行程被砍掉／自然結束 → 立刻重開，封鎖才不會出現空窗。
        if (!this.blocker || this.blocker.exitCode !== null) {
          this.log('[lock] 輸入封鎖行程已離開，重新啟動');
          this.ensureBlocker();
        }
      }, RESPAWN_INTERVAL_MS);
      this.timer.unref?.();
      this.log('[lock] 輸入鎖定：鍵盤滑鼠封鎖（畫面不動）');
    } else {
      this.stopTimer();
      this.killBlocker();
      this.log('[lock] 解除輸入鎖定');
    }
  }

  /** 行程結束前的清理：絕不能讓 hook 行程孤兒化（input 永遠被封鎖） */
  dispose(): void {
    this.stopTimer();
    this.killBlocker();
    this.active = false;
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
