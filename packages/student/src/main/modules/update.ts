import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { app } from 'electron';
import { ipcMain } from 'electron';

import { IPC } from '../../shared/ipc.js';
import { getLastStoredFile, clearLastStoredFile } from './file-recv.js';

export function registerUpdateIpc(): void {
  ipcMain.handle(IPC.applyUpdate, async (): Promise<{ ok: boolean; reason?: string }> => {
    const logPath = path.join(app.getPath('userData'), 'update-log.txt');
    const stamp = () => `[${new Date().toISOString()}]`;
    const updateLog = (line: string): void => {
      try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fs.appendFileSync(logPath, `${stamp()} (main) ${line}\r\n`, 'utf8');
      } catch {
        /* 寫不進去就算了 */
      }
    };

    const recent = getLastStoredFile();
    if (!recent || Date.now() - recent.at > 30 * 60 * 1000 || !recent.path.toLowerCase().endsWith('.zip')) {
      updateLog('拒絕：30 分鐘內沒有收過可用的 .zip 升級包');
      console.log('[update] 沒有可用的升級包（需在 30 分鐘內收到過 .zip 升級包）');
      return { ok: false, reason: '30 分鐘內沒有收過可用的 .zip 升級包' };
    }
    try {
      if (fs.statSync(recent.path).size < 32 * 1024) {
        updateLog(`拒絕：升級包體積過小（${recent.path}）`);
        console.log('[update] 升級包體積過小（<32KB），判定為不可用');
        return { ok: false, reason: '升級包體積過小，判定為不可用' };
      }
    } catch (error) {
      updateLog(`拒絕：讀不到升級包（${error instanceof Error ? error.message : String(error)}）`);
      console.error(`[update] 讀不到升級包（可能已被清掉）：${error instanceof Error ? error.message : String(error)}`);
      clearLastStoredFile();
      return { ok: false, reason: '讀不到升級包（可能已被清掉）' };
    }

    const appRoot = path.resolve(process.execPath, '..');
    const appDir = path.join(appRoot, 'resources', 'app');
    const stage = path.join(app.getPath('temp'), `classroom-update-${Date.now()}`);
    updateLog(`開始解壓：zip=${recent.path} appRoot=${appRoot}`);

    const runTar = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const tarExe = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
        const child = spawn(tarExe, ['-xf', recent.path, '-C', stage], { windowsHide: true, stdio: 'ignore' });
        const timer = setTimeout(() => reject(new Error('tar 解壓逾時（60 秒）')), 60_000);
        child.on('exit', code => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`tar 結束碼=${code}`));
        });
        child.on('error', e => {
          clearTimeout(timer);
          reject(e);
        });
      });

    const runPsFallback = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const ps = `Expand-Archive -LiteralPath '${recent.path.replace(/'/g, "''")}' -DestinationPath '${stage.replace(/'/g, "''")}' -Force`;
        const enc = Buffer.from(ps, 'utf16le').toString('base64');
        const child = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
          {
            windowsHide: true,
            stdio: 'ignore',
          }
        );
        const timer = setTimeout(() => reject(new Error('Expand-Archive 逾時（90 秒）')), 90_000);
        child.on('exit', code => {
          clearTimeout(timer);
          if (code === 0) resolve();
          else reject(new Error(`powershell 結束碼=${code}`));
        });
        child.on('error', e => {
          clearTimeout(timer);
          reject(e);
        });
      });

    try {
      fs.mkdirSync(stage, { recursive: true });
      try {
        await runTar();
      } catch (tarError) {
        updateLog(
          `tar 解壓失敗，改用 PowerShell 備援（${tarError instanceof Error ? tarError.message : String(tarError)}）`
        );
        await runPsFallback();
      }
      const staged = fs.readdirSync(stage);
      if (staged.length === 0) throw new Error('解壓後暫存目錄是空的（zip 疑似損毀）');
      fs.cpSync(stage, appDir, {
        recursive: true,
        filter: src => path.basename(src).toLowerCase() !== 'config.json',
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      updateLog(`EXPAND FAILED: ${msg}`);
      console.error('[update] EXPAND FAILED：', msg);
      try {
        fs.rmSync(stage, { recursive: true, force: true });
      } catch {
        /* 清不掉就算了 */
      }
      return { ok: false, reason: `解壓失敗：${msg}` };
    }
    updateLog('expanded update OK');
    try {
      fs.rmSync(stage, { recursive: true, force: true });
    } catch {
      /* 清不掉就算了 */
    }

    updateLog('relaunched app');
    console.log('[update] expanded update OK，即將重啟上新版');
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });
}
