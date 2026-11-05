import fs from 'node:fs';
import path from 'node:path';
import { app, dialog } from 'electron';
import { ipcMain } from 'electron';

import { IPC } from '../../shared/ipc.js';
import { isNativeReady, nativeError } from './native-control.js';
import { defaultFileSaveDir, getConfig, saveConfig } from '../store.js';
import { getMainWindow } from './window.js';

/** 教師機檔案傳送：進行中的接收狀態 */
interface FileTransfer {
  name: string;
  target: string;
  size: number;
  bytes: number;
  fd: number;
  error: string | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

const fileTransfers = new Map<string, FileTransfer>();
let resolvedSaveDir: string | null = null;

/** 最近一次成功落地的檔案（供熱更新套用判斷） */
let lastStoredFile: { path: string; at: number } | null = null;

const ILLEGAL_NAME_CHARS = /[<>:"/\\|?*\u0000-\u001f]/;

function sanitizeFileName(raw: string): string {
  let name = path.win32.basename(String(raw)).trim();
  name = name
    .replace(ILLEGAL_NAME_CHARS, '_')
    .replace(/\u007f/g, '_')
    .trim();
  name = name.replace(/[. ]+$/, '');
  const stem = name.replace(/\.[^.]+$/, '').toUpperCase();
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem)) name = `_${name}`;
  return name || 'file';
}

function dirCandidates(dir: string): string[] {
  const abs = path.resolve(dir);
  const root = path.win32.parse(abs).root;
  if (abs.toLowerCase() !== root.toLowerCase()) return [abs];
  return [root, path.join(root, 'SETUP')];
}

function canWriteDir(dir: string): boolean {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.perm-test-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** resolved save dir (same as file-recv; for silent update etc) */
export function getResolvedSaveDir(): string {
  return pickSaveDir() ?? getConfig().fileSaveDir ?? defaultFileSaveDir() ?? "";
}
function pickSaveDir(): string | null {
  const configured = getConfig().fileSaveDir;
  const configuredList = configured ? dirCandidates(configured) : [];

  if (resolvedSaveDir && configuredList.length > 0) {
    const wantKeys = configuredList.map(dir => dir.toLowerCase());
    if (!wantKeys.includes(path.resolve(resolvedSaveDir).toLowerCase())) {
      for (const dir of configuredList) {
        if (canWriteDir(dir)) {
          resolvedSaveDir = dir;
          return dir;
        }
      }
    }
  }
  if (resolvedSaveDir && canWriteDir(resolvedSaveDir)) return resolvedSaveDir;

  const candidates: string[] = [...configuredList];
  for (const dir of dirCandidates(defaultFileSaveDir())) candidates.push(dir);
  candidates.push(app.getPath('downloads'));
  candidates.push(path.join(app.getPath('desktop'), 'SETUP'));

  const configuredRoot = configured ? path.win32.parse(path.resolve(configured)).root.toLowerCase() : null;
  const seen = new Set<string>();
  for (const dir of candidates) {
    const key = path.resolve(dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!canWriteDir(dir)) {
      console.log(`[file] 收檔資料夾不可用，改試下一個候選：${dir}`);
      continue;
    }
    resolvedSaveDir = dir;
    const usedRoot = path.win32.parse(path.resolve(dir)).root.toLowerCase();
    if (configuredRoot && usedRoot !== configuredRoot) {
      console.log(`[file] 部署設定的 fileSaveDir（${configured}）不可寫，實際收檔改用：${dir}`);
    }
    return dir;
  }
  return null;
}

function uniqueTarget(dir: string, name: string): string {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let index = 0; index < 1000; index++) {
    const candidate = index === 0 ? path.join(dir, name) : path.join(dir, `${stem}(${index})${ext}`);
    try {
      fs.accessSync(candidate);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${stem}-${Date.now()}${ext}`);
}

function failTransfer(transfer: FileTransfer, reason: string): void {
  if (transfer.error) return;
  transfer.error = reason;
  try {
    fs.closeSync(transfer.fd);
  } catch {
    // 已關閉就算了
  }
  try {
    fs.unlinkSync(transfer.target);
  } catch {
    // 刪不掉就算了
  }
  if (transfer.idleTimer) clearTimeout(transfer.idleTimer);
}

function armIdleTimer(id: string, transfer: FileTransfer): void {
  if (transfer.idleTimer) clearTimeout(transfer.idleTimer);
  transfer.idleTimer = setTimeout(
    () => {
      const ongoing = fileTransfers.get(id);
      if (!ongoing) return;
      failTransfer(ongoing, '傳送中斷（教師機中止或逾時）');
      fileTransfers.delete(id);
    },
    3 * 60 * 1000
  );
}

export function registerFileIpc(): void {
  // 啟動即同步「登入自動啟動」登記：預設開啟，安裝後首次執行就生效
  //（使用者可隨時在設定中關閉，下次啟動仍會依設定同步）
  applyAutoStart(getConfig().autoStart);
  ipcMain.handle(IPC.getConfig, () => getConfig());
  ipcMain.handle(IPC.saveConfig, (_event, patch) => {
    const saved = saveConfig(patch);
    resolvedSaveDir = null;
    if (Object.prototype.hasOwnProperty.call(patch, 'autoStart')) {
      applyAutoStart(saved.autoStart);
    }
    return saved;
  });

  ipcMain.handle(IPC.appInfo, () => ({
    version: app.getVersion(),
    platform: `${process.platform} ${process.arch}`,
    electron: process.versions.electron ?? 'unknown',
    userDataPath: app.getPath('userData'),
    build: readBuildInfo(),
    nativeReady: isNativeReady(),
    nativeError: nativeError(),
    saveDir: pickSaveDir() ?? getConfig().fileSaveDir,
  }));

  ipcMain.handle(IPC.cleanFileDir, async (): Promise<{ ok: boolean; deleted: number; message?: string }> => {
    return cleanFileDir();
  });

  ipcMain.handle(IPC.getIdleImage, async (): Promise<string | null> => {
    const imagePath = getConfig().idleImagePath;
    if (!imagePath || !fs.existsSync(imagePath)) return null;
    try {
      const ext = path.extname(imagePath).toLowerCase();
      const mime = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const data = await fs.promises.readFile(imagePath);
      return `data:${mime};base64,${data.toString('base64')}`;
    } catch {
      return null;
    }
  });

  ipcMain.handle(IPC.chooseSaveDir, async () => {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return null;
    const result = await dialog.showOpenDialog(window, {
      title: '選擇收檔資料夾',
      defaultPath: pickSaveDir() ?? undefined,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle(IPC.fileBegin, (_event, id: unknown, name: unknown, size: unknown) => {
    if (typeof id !== 'string' || !id || typeof name !== 'string') {
      return { error: '檔案資訊不完整' };
    }
    if (fileTransfers.has(id)) {
      return { error: '同一批序號重複送出，已略過' };
    }

    const cleanName = sanitizeFileName(name);
    const dir = pickSaveDir();
    if (!dir) {
      return { error: '所有收檔資料夾都不可寫（部署值與備援全失敗）' };
    }

    try {
      const target = uniqueTarget(dir, cleanName);
      const fd = fs.openSync(target, 'w');
      const transfer: FileTransfer = {
        name: cleanName,
        target,
        size: typeof size === 'number' && Number.isFinite(size) ? size : -1,
        bytes: 0,
        fd,
        error: null,
        idleTimer: null,
      };
      fileTransfers.set(id, transfer);
      armIdleTimer(id, transfer);
      const configuredNow = getConfig().fileSaveDir;
      const configuredRoot = configuredNow ? path.win32.parse(path.resolve(configuredNow)).root.toLowerCase() : null;
      const fellBack = !!configuredRoot && path.win32.parse(path.resolve(dir)).root.toLowerCase() !== configuredRoot;
      if (fellBack) {
        console.warn(`[file] 降級生效：設定的收檔資料夾（${configuredNow}）不可寫，本檔改存 ${dir}`);
      }
      return {
        path: target,
        usedDir: dir,
        fallbackFrom: fellBack ? configuredNow : undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[file] 建檔失敗：', message);
      return { error: `無法建立檔案（${cleanName}）：${message}` };
    }
  });

  ipcMain.on(IPC.fileChunk, (_event, id: unknown, chunk: unknown) => {
    const transferId = typeof id === 'string' ? id : '';
    const transfer = transferId ? fileTransfers.get(transferId) : undefined;
    if (!transfer || !(chunk instanceof ArrayBuffer)) return;
    if (transfer.error) return;
    try {
      fs.writeSync(transfer.fd, new Uint8Array(chunk));
      transfer.bytes += chunk.byteLength;
      armIdleTimer(transferId, transfer);
    } catch (error) {
      failTransfer(transfer, `寫入失敗：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  ipcMain.handle(IPC.fileEnd, async (_event, id: unknown) => {
    const transfer = typeof id === 'string' ? fileTransfers.get(id) : undefined;
    if (!transfer) {
      return { ok: false, path: null, message: '沒有對應的傳送作業（可能已被逾時清除）' };
    }
    fileTransfers.delete(String(id));
    if (transfer.idleTimer) clearTimeout(transfer.idleTimer);

    if (transfer.error) {
      return { ok: false, path: null, message: transfer.error };
    }
    try {
      fs.closeSync(transfer.fd);
    } catch (error) {
      return {
        ok: false,
        path: null,
        message: `關檔失敗：${error instanceof Error ? error.message : String(error)}`,
      };
    }

    let bytes;
    try {
      bytes = fs.statSync(transfer.target).size;
    } catch {
      return { ok: false, path: null, message: '檔案消失（磁碟被清除？）' };
    }
    if (transfer.size >= 0 && bytes !== transfer.size) {
      try {
        fs.unlinkSync(transfer.target);
      } catch {
        // 清不掉就算了
      }
      return { ok: false, path: null, message: `大小不符（收到 ${bytes} / 預期 ${transfer.size}）` };
    }

    lastStoredFile = { path: transfer.target, at: Date.now() };

    // 待機圖：「待機畫面.xxx」的圖片檔 → 複製到 userData 並記錄路徑，
    // renderer 待機時顯示（取代 App 內建守則海報）。
    if (/^待機畫面\.(png|jpe?g|webp)$/i.test(transfer.name)) {
      try {
        const ext = path.extname(transfer.target).toLowerCase();
        const dest = path.join(app.getPath('userData'), `idle-image${ext}`);
        // 清掉不同副檔名的舊圖，避免殘留
        for (const e of ['.png', '.jpg', '.jpeg', '.webp']) {
          const oldPath = path.join(app.getPath('userData'), `idle-image${e}`);
          if (oldPath !== dest && fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        }
        fs.copyFileSync(transfer.target, dest);
        saveConfig({ idleImagePath: dest });
        console.log(`[idle-image] 待機圖已更新：${dest}`);
      } catch (error) {
        console.error('[idle-image] 待機圖儲存失敗：', error);
      }
    }
    return { ok: true, path: transfer.target };
  });
}

/**
 * 清空收檔資料夾頂層的所有項目（教師端「🧹 清理收檔夾」遙控）。
 * 安全保護：收檔資料夾若設為磁碟根目錄（例如 D:\），改清 SETUP 子資料夾；
 * SETUP 也不存在則直接拒絕，絕不誤刪磁碟根層資料。
 */
export async function cleanFileDir(): Promise<{ ok: boolean; deleted: number; message?: string }> {
  let dir = pickSaveDir();
  if (!dir) return { ok: false, deleted: 0, message: '收檔資料夾不可用' };
  const resolved = path.resolve(dir);
  if (path.win32.parse(resolved).root.toLowerCase() === resolved.toLowerCase()) {
    const setupDir = path.join(resolved, 'SETUP');
    if (fs.existsSync(setupDir)) {
      dir = setupDir;
    } else {
      return { ok: false, deleted: 0, message: '收檔資料夾為磁碟根目錄，為安全起見已跳過清理' };
    }
  }
  let deleted = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      try {
        if (entry.isDirectory()) fs.rmSync(full, { recursive: true, force: true });
        else fs.unlinkSync(full);
        deleted++;
      } catch {
        /* 單一項目失敗（被占用等）略過，不中斷整批 */
      }
    }
    console.log('[file] 收檔資料夾已清理：' + dir + '（' + deleted + ' 項）');
    return { ok: true, deleted };
  } catch (error) {
    return { ok: false, deleted, message: error instanceof Error ? error.message : String(error) };
  }
}
function readBuildInfo(): string | null {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'build-info.json'), 'utf8')) as {
      builtAt?: string;
    };
    return info.builtAt ?? null;
  } catch {
    return null;
  }
}

function applyAutoStart(enabled: boolean): void {
  if (!app.isPackaged) {
    return;
  }
  try {
    app.setLoginItemSettings({
      openAtLogin: enabled,
      args: [],
    });
    console.log(`[autostart] 登入自動啟動：${enabled ? '已啟用' : '已停用'}`);
  } catch (error) {
    console.error('[autostart] 設定登入自動啟動失敗', error);
  }
}

export function getLastStoredFile(): { path: string; at: number } | null {
  return lastStoredFile;
}

export function clearLastStoredFile(): void {
  lastStoredFile = null;
}
