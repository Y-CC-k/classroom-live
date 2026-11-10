import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { app, ipcMain } from 'electron';

import { shell } from 'electron';

import { IPC } from '../../shared/ipc.js';
import { getConfig } from '../store.js';
import { detectNetworkInfo } from '../local-ip.js';

export function registerSystemCommandsIpc(): void {
  let shutdownPending = false;

  ipcMain.handle(IPC.requestShutdown, (_event, delaySec: unknown) => {
    const delay =
      typeof delaySec === 'number' && Number.isFinite(delaySec) && delaySec >= 0
        ? Math.min(Math.round(delaySec), 600)
        : 30;

    const cancel = delaySec === -1;
    if (cancel) {
      execFile('shutdown.exe', ['/a'], { windowsHide: true, timeout: 10_000 }, error => {
        if (error) console.error('[shutdown] 取消關機失敗（可能沒有待排定的關機）');
        else console.log('[shutdown] 已取消排定的關機');
      });
      return true;
    }

    if (shutdownPending) return true;
    execFile('shutdown.exe', ['/s', '/t', String(delay)], { windowsHide: true, timeout: 10_000 }, error => {
      if (error) {
        console.error(`[shutdown] 關機排程失敗（可重試）：${error.message.split('\n')[0] ?? ''}`);
        shutdownPending = false;
      } else {
        console.log(`[shutdown] 已排定 ${delay} 秒後關機`);
      }
    });
    shutdownPending = true;
    return true;
  });

  ipcMain.handle(IPC.requestReboot, (_event, delaySec: unknown) => {
    const delay =
      typeof delaySec === 'number' && Number.isFinite(delaySec) && delaySec >= 0
        ? Math.min(Math.round(delaySec), 600)
        : 10;

    if (delaySec === -1) {
      execFile('shutdown.exe', ['/a'], { windowsHide: true, timeout: 10_000 }, error => {
        if (error) console.error('[reboot] 取消重開/關機失敗（可能沒有待排定的項目）');
        else console.log('[reboot] 已取消排定的重開/關機');
      });
      return true;
    }

    execFile('shutdown.exe', ['/r', '/f', '/t', String(delay)], { windowsHide: true, timeout: 10_000 }, error => {
      if (error) console.error(`[reboot] 重開排程失敗（可重試）：${error.message.split('\n')[0] ?? ''}`);
      else console.log(`[reboot] 已排定 ${delay} 秒後重開機`);
    });
    return true;
  });

  ipcMain.handle(IPC.execProgram, (_event, rawPath: unknown, rawArgs: unknown) => {
    const target = String(rawPath ?? '').trim();
    if (!target) return { ok: false, message: '沒有指定要執行的檔案' };
    if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
      console.log(`[exec] 檔案不存在：${target}`);
      return { ok: false, message: `檔案不存在：${target}` };
    }
    const args = Array.isArray(rawArgs) ? rawArgs.map(item => String(item)) : [];
    const ext = path.extname(target).toLowerCase();
    const cwd = path.dirname(target);
    try {
      if (ext === '.bat' || ext === '.cmd') {
        spawn('cmd.exe', ['/c', target, ...args], {
          cwd,
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        }).unref();
      } else {
        const child = spawn(target, args, {
          cwd,
          detached: true,
          stdio: 'ignore',
          windowsHide: false,
        });
        // spawn 失敗（如 CreateProcess 錯誤）是走 error 事件而非例外，
        // 不掛監聽會「完全沒反應」：最常見是安裝程式需要 UAC（ERROR_ELEVATION_REQUIRED）、
        // 系統不認得 .lnk 快捷方式與 .msi 安裝包。此時改走 ShellExecute：
        // Windows 會顯示 UAC 權限提示、解析捷徑、正確帶起 msiexec。
        child.on('error', error => {
          const reason = error instanceof Error ? error.message.split('\n')[0] ?? '' : String(error);
          console.warn(`[exec] 直接啟動失敗（${reason}），改以 ShellExecute 啟動：${target}`);
          if (args.length > 0) {
            // 走 cmd start 傳參數（ShellExecute；需要 UAC 時會提示）
            const viaStart = spawn('cmd.exe', ['/c', 'start', '', target, ...args], {
              cwd,
              detached: true,
              stdio: 'ignore',
              windowsHide: true,
            });
            viaStart.on('error', err => {
              console.error(`[exec] ShellExecute啟動也失敗：${err.message}`);
            });
            viaStart.unref();
          } else {
            void shell.openPath(target).then(msg => {
              if (msg) console.error(`[exec] ShellExecute 啟動失敗：${msg}`);
              else console.log(`[exec] 已以 ShellExecute 啟動：${target}`);
            });
          }
        });
        child.unref();
      }
      console.log(`[exec] 已啟動：${target}（${args.length} 個參數）`);
      return { ok: true };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[exec] 啟動失敗：${message}`);
      return { ok: false, message };
    }
  });

  ipcMain.handle(IPC.openUrl, async (_event, rawUrl: unknown): Promise<boolean> => {
    const url = String(rawUrl ?? '');
    if (!/^https?:\/\//i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle(IPC.closeBrowsers, async (): Promise<boolean> => {
    for (const name of ['chrome.exe', 'msedge.exe']) {
      try {
        execFile('taskkill', ['/F', '/T', '/IM', name], () => undefined);
      } catch {
        /* 程序可能已不存在 */
      }
    }
    return true;
  });

  ipcMain.handle(IPC.networkInfo, () => detectNetworkInfo());

  ipcMain.handle(IPC.getScreenSource, async () => {
    const { desktopCapturer } = await import('electron');
    const sources = await desktopCapturer.getSources({ types: ['screen'] });
    if (sources.length === 0) {
      return { error: '找不到可擷取的螢幕' };
    }
    return { id: sources[0]!.id };
  });
}
