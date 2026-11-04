/**
 * 學生機畫面截圖收藏：
 *   教師端監控牆每格的 📸 → 存到「文件\教室直播收藏\日期\名稱_HHMMSS.jpg」
 *   另提供「以檔案總管開啟收藏資料夾」。
 */
import fs from 'node:fs';
import path from 'node:path';
import { app, ipcMain, shell } from 'electron';

import { IPC } from '../shared/ipc.js';

function snapshotsDir(): string {
  return path.join(app.getPath('documents'), '教室直播收藏', new Date().toISOString().slice(0, 10));
}

/** Windows 檔名禁字元與控制字元清理 */
function sanitizeName(raw: string): string {
  let name = path.win32.basename(String(raw)).trim();
  name = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return name || 'student';
}

export function registerSnapshotIpc(): void {
  ipcMain.handle(
    IPC.saveSnapshot,
    (_event, studentName: unknown, dataBase64: unknown): { ok: boolean; path?: string; message?: string } => {
      try {
        if (typeof dataBase64 !== 'string' || dataBase64.length < 100) {
          return { ok: false, message: '沒有可收藏的畫面' };
        }
        const dir = snapshotsDir();
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, '');
        const file = path.join(dir, `${sanitizeName(typeof studentName === 'string' ? studentName : '')}_${stamp}.jpg`);
        fs.writeFileSync(file, Buffer.from(dataBase64, 'base64'));
        return { ok: true, path: file };
      } catch (error) {
        return { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
    }
  );

  ipcMain.handle(IPC.openSnapshotsFolder, async (): Promise<string> => {
    const dir = snapshotsDir();
    fs.mkdirSync(dir, { recursive: true });
    await shell.openPath(dir);
    return dir;
  });
}
