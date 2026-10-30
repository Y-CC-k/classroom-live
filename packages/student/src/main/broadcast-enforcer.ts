import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { BrowserWindow } from 'electron';

/**
 * 廣播強制模式（教師按下「開始廣播」時的收攏動作）：
 *
 *   1. 接收視窗永遠在最上層（screen-saver 級別，壓過 Chrome／Edge／工作列提示）
 *   2. 保持全螢幕（定期重新 asserted，學生按 ESC 也會被拉回）
 *
 *  靜音與「關 Chrome/Edge」已改為教師端可單獨下指令的管理功能：
 *   - setMuted(true/false)：持續維持靜音／還原（學生按音量鍵解靜音也會被蓋掉）
 *   - closeBrowsers()：閉一次 Chrome／Edge（不持續）
 * 教師端按鈕觸發，跟強制模式互不綁定。
 *
 * renderer 重新載入時（did-start-loading）一律解除本模式——
 * 畫面斷線就不該再鎖著學生；教師重新廣播時 renderer 會再次打開。
 */

const ENFORCE_INTERVAL_MS = 3_000;

/**
 * 靜音腳本：PowerShell 內嵌 C# 存取 Core Audio 的 IAudioEndpointVolume。
 * 使用預設播放裝置。必須純 ASCII（PS 5.1 對無 BOM 檔按 ANSI 讀），
 * 且只能用 C# 5 語法（out 變數要先宣告）、out 參數直接型別化為介面。
 */
const MUTE_PS_SCRIPT = `
param([string]$Action = 'get', [string]$Value = 'false')
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;

// IAudioEndpointVolume vtable order per mmdeviceapi.h; f/g/h/i/j/k/l/m/n are slot placeholders.
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume
{
    int f(); int g(); int h(); int i();
    int SetMasterVolumeLevelScalar(float fLevel, Guid pguidEventContext);
    int j();
    int GetMasterVolumeLevelScalar(out float pfLevel);
    int k(); int l(); int m(); int n();
    int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, Guid pguidEventContext);
    int GetMute(out bool pbMute);
}

[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
    // out param must be typed as the interface; out object makes Activate return E_NOINTERFACE
    int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev);
}

[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
    int f(); // EnumAudioEndpoints placeholder
    int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumeratorComObject { }

public static class AudioMuteUtil
{
    // PS 5.1 Add-Type = C# 5: out variables need a prior declaration (no out var)
    private static IAudioEndpointVolume Vol()
    {
        var enumerator = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator;
        IMMDevice dev = null;
        Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0, 1, out dev));
        IAudioEndpointVolume epv = null;
        var epvid = typeof(IAudioEndpointVolume).GUID;
        Marshal.ThrowExceptionForHR(dev.Activate(ref epvid, 23, 0, out epv));
        return epv;
    }

    public static bool Get()
    {
        bool mute = false;
        Marshal.ThrowExceptionForHR(Vol().GetMute(out mute));
        return mute;
    }

    public static void Set(bool mute)
    {
        Guid none = Guid.Empty;
        Marshal.ThrowExceptionForHR(Vol().SetMute(mute, none));
    }
}
'@
if ($Action -eq 'get') { [string][AudioMuteUtil]::Get(); exit 0 }
[AudioMuteUtil]::Set($Value -eq 'true')
Write-Output $Value
`.trim();

interface EnforceLog {
  (line: string): void;
}

export class BroadcastEnforcer {
  private active = false;
  private window: BrowserWindow | null = null;
  private log: EnforceLog = () => undefined;
  private muteScriptPath: string | null = null;

  configure(window: BrowserWindow, log: EnforceLog): void {
    this.window = window;
    this.log = log;
  }

  /** renderer 重新載入 → 一律解除 */
  reset(): void {
    if (this.active) this.setActive(false);
  }

  isActive(): boolean {
    return this.active;
  }

  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;

    if (on) {
      this.assertWindow();
      this.startEnforcement();
      this.log('[broadcast] 廣播強制模式：置頂＋全螢幕（靜音／關網頁改由教師個別按鍵）');
    } else {
      this.stopEnforcement();
      if (this.window) {
        this.window.setAlwaysOnTop(false);
        this.window.setFullScreen(false);
      }
      this.log('[broadcast] 廣播強制模式解除：取消置頂');
    }
  }

  // ───────── 教師端可單獨下指令的管理功能（不隨廣播開關） ─────────

  /** 目前是否處於「教師要求持續靜音」狀態（心跳自解會用它） */
  isMuted(): boolean {
    return this.muteOn;
  }

  /**
   * 持續靜音／解除：開啟後每 3 秒重設一次（學生按音量鍵解靜音會被蓋掉）；
   * 解除時直接還原聲音。語義是「教師的明確指令」，不做廣播前狀態的還原。
   */
  async setMuted(on: boolean): Promise<boolean> {
    if (on === this.muteOn) return true;
    this.muteOn = on;
    if (on) {
      await this.runMuteScript('set', 'true');
      this.startMuteLoop();
      this.log('[broadcast] 教師指令：持續靜音（每 3 秒重設）');
    } else {
      this.stopMuteLoop();
      await this.runMuteScript('set', 'false');
      this.log('[broadcast] 教師指令：解除靜音');
    }
    return true;
  }

  /** 教師指令：關閉 Chrome／Edge（一次動作，持續效能不是本機負責） */
  async closeBrowsers(): Promise<boolean> {
    await this.killInternetBrowsers();
    this.log('[broadcast] 教師指令：關閉 Chrome／Edge');
    return true;
  }

  private muteOn = false;
  private muteTimer: NodeJS.Timeout | null = null;

  private startMuteLoop(): void {
    this.stopMuteLoop();
    this.muteTimer = setInterval(() => {
      if (!this.muteOn) return;
      void this.runMuteScript('set', 'true');
    }, ENFORCE_INTERVAL_MS);
    this.muteTimer.unref?.();
  }

  private stopMuteLoop(): void {
    if (this.muteTimer) {
      clearInterval(this.muteTimer);
      this.muteTimer = null;
    }
  }

  /** 還原並顯示視窗＋置頂＋全螢幕（含定期重新 asserted） */
  private assertWindow(): void {
    if (!this.window) return;
    try {
      // 學生機可能正縮在系統匣或最小化：先還原顯示再設定狀態
      if (this.window.isMinimized()) this.window.restore();
      this.window.show();
      this.window.setAlwaysOnTop(true, 'screen-saver');
      this.window.setFullScreen(true);
      this.window.focus();
    } catch (error) {
      this.log(`[broadcast] 視窗置頂設定失敗：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private enforceTimer: NodeJS.Timeout | null = null;

  private startEnforcement(): void {
    this.stopTimers();
    this.enforceTimer = setInterval(() => {
      if (!this.active) return;
      this.assertWindow();
    }, ENFORCE_INTERVAL_MS);
    // unref：控制台關閉時不留尾巴
    this.enforceTimer.unref?.();
  }

  private stopEnforcement(): void {
    this.stopTimers();
  }

  private stopTimers(): void {
    if (this.enforceTimer) {
      clearInterval(this.enforceTimer);
      this.enforceTimer = null;
    }
  }

  /** 關閉 Chrome 與 Edge（/T 連子行程、不區分是否為系統管理員開的） */
  private killInternetBrowsers(): Promise<void> {
    return new Promise(resolvePromise => {
      execFile(
        'taskkill.exe',
        ['/F', '/T', '/IM', 'chrome.exe', '/IM', 'msedge.exe'],
        { windowsHide: true, timeout: 8000 },
        (error, stdout) => {
          if (error && typeof (error as { code?: unknown }).code !== 'number') {
            // 非「找不到行程」類錯誤才值得記錄
            this.log(`[broadcast] 關閉瀏覽器失敗：${error.message}`);
          } else if (stdout && stdout.includes('成功')) {
            this.log('[broadcast] 已關閉 Chrome／Edge');
          }
          resolvePromise();
        }
      );
    });
  }

  /** 靜音控制；回傳執行前的靜音狀態（僅 set 時有意義） */
  private async requestMute(mute: boolean): Promise<boolean> {
    const previous = await this.runMuteScript('get', 'false');
    await this.runMuteScript('set', String(mute));
    return previous === 'True' || previous === 'true' || previous === '1';
  }

  private async runMuteScript(action: 'get' | 'set', value: string): Promise<string> {
    return new Promise(resolvePromise => {
      const file = this.ensureMuteScript();
      if (!file) {
        resolvePromise('');
        return;
      }
      execFile(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          file,
          '-Action',
          action,
          '-Value',
          value,
        ],
        { windowsHide: true, timeout: 10_000 },
        (error, stdout) => {
          if (error) {
            this.log(`[broadcast] 靜音腳本失敗：${error.message.split('\n')[0] ?? ''}`);
          }
          resolvePromise(String(stdout ?? '').trim());
        }
      );
    });
  }

  private ensureMuteScript(): string | null {
    if (this.muteScriptPath && existsSync(this.muteScriptPath)) return this.muteScriptPath;
    try {
      // 動態 import 避免頂層依賴：userData 目錄一定存在
      const electron = require('electron') as { app: { getPath: (name: string) => string } };
      const dir = electron.app.getPath('userData');
      mkdirSync(dir, { recursive: true });
      this.muteScriptPath = path.join(dir, 'mute-audio.ps1');
      writeFileSync(this.muteScriptPath, MUTE_PS_SCRIPT, 'utf8');
      return this.muteScriptPath;
    } catch (error) {
      this.log(`[broadcast] 無法準備靜音腳本：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}
