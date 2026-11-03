import path from 'node:path';

import { app, BrowserWindow, ipcMain, shell } from 'electron';

import { IPC, type AppInfo, type TeacherConfig } from '../shared/ipc.js';
import { listSources } from './sources.js';
import { getConfig, saveConfig } from './store.js';
import { wakeTargets } from './wol.js';
import { WakeRoster } from './wake-roster.js';
import { registerSnapshotIpc } from './snapshots.js';
import type { PeerInfo } from '@classroom/protocol';

const isDev = process.env.NODE_ENV === 'development';

/**
 * 強制 Chromium 用舊版（GDI）路徑擷取「單一視窗」，不要用 Windows Graphics Capture（WGC）。
 *
 * 原因：在部分 Windows 組建上（實測 26300 / 26H2）WGC 的視窗擷取會直接失敗，
 * `getUserMedia({ chromeMediaSource: 'desktop', chromeMediaSourceId: 'window:…' })`
 * 一律回 NotReadableError: Could not start video source；而螢幕擷取走的是 DXGI，
 * 所以「螢幕可以播、視窗一按就失敗」。關掉 WGC 視窗擷取之後，
 * Chromium 會退回 GDI 路徑，實測可以正常擷取單一視窗（且不受其他視窗遮蔽影響）。
 *
 * 已知副作用：視窗來源的 `track.label` 會是 `Screen`，
 * `track.getSettings()` 也會回報成螢幕尺寸（例如 1920×1920）——都是錯的，
 * 真正的畫面尺寸只有 videoWidth/videoHeight 可信（renderer 端另用量測處理）。
 *
 * 螢幕與攝影機擷取不受這個旗標影響。
 */
app.commandLine.appendSwitch('disable-features', 'AllowWgcWindowCapturer');

// 打包器輸出 CommonJS，因此 __dirname 直接可用，
// 而且指向 dist/main，剛好可以用相對路徑找到 dist/preload 與 dist/renderer。
const currentDir = __dirname;

let mainWindow: BrowserWindow | null = null;

const wakeRoster = new WakeRoster();

function rendererFile(name: string): string {
  return path.join(currentDir, '..', 'renderer', name);
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    show: false,
    backgroundColor: '#10141c',
    title: '教室直播 — 教師機',
    autoHideMenuBar: true,
    // 視窗／工作列圖示：開發時位於 packages/teacher/build/icon.png，
    // 打包後（非 asar）位於 resources/app/build/icon.png，相對路徑一致。
    icon: path.join(currentDir, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(currentDir, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // renderer 只需要 getUserMedia / RTCPeerConnection。
      // 關閉 sandbox 是為了讓 preload 能自由載入被 esbuild 打包的模組；
      // 由於我們完全不把 Node API 暴露給 renderer，風險仍受控。
      sandbox: false,
      // 教師機必須持續送出畫面，即使視窗被切到背景也不能被節流。
      backgroundThrottling: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    // 啟動即最大化（填滿螢幕，方便監控牆與多面板操作）
    mainWindow?.maximize();
    mainWindow?.show();
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 教室軟體不該讓老師誤觸外部連結後跳出瀏覽器而失去簡報控制。
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  await mainWindow.loadFile(rendererFile('index.html'));
}

function registerIpc(): void {
  ipcMain.handle(IPC.listSources, async () => listSources());

  ipcMain.handle(IPC.getConfig, () => getConfig());

  ipcMain.handle(IPC.saveConfig, (_event, patch: Partial<TeacherConfig>) => saveConfig(patch));

  ipcMain.handle(IPC.appInfo, (): AppInfo => ({
    version: app.getVersion(),
    platform: `${process.platform} ${process.arch}`,
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    userDataPath: app.getPath('userData'),
  }));

  ipcMain.handle(IPC.getWakeRoster, () => wakeRoster.list());

  ipcMain.handle(IPC.reportWakePeers, (_event, peers: PeerInfo[]) => {
    const items = Array.isArray(peers) ? peers : [];
    return wakeRoster.merge(items);
  });

  ipcMain.handle(IPC.wake, (_event, targets?: string[]) => {
    const list = wakeRoster.list();
    return wakeTargets(list, { targets: Array.isArray(targets) ? targets : undefined });
  });
}

// 同一台機器同時開兩個教師機會造成「誰才是教師」的混亂，直接鎖單一實例。
export { wakeTargets } from './wol.js';

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });

  app.whenReady().then(async () => {
    registerIpc();
    registerSnapshotIpc();

    ipcMain.handle(IPC.setFullscreen, (_event, on: unknown) => {
      const enable = on === true;
      if (mainWindow && mainWindow.isFullScreen() !== enable) mainWindow.setFullScreen(enable);
      return Boolean(mainWindow?.isFullScreen());
    });
    await createWindow();

    app.on('activate', async () => {
      if (BrowserWindow.getAllWindows().length === 0) await createWindow();
    });
  });

  app.on('window-all-closed', () => {
    // 教師機一關就是要下課了，直接結束行程。
    app.quit();
  });

  if (isDev) {
    // 讓 Ctrl+Shift+I 可以開 DevTools；正式版不提供。
    app.on('browser-window-created', (_event, window) => {
      window.webContents.on('before-input-event', (_e, input) => {
        if (input.control && input.shift && input.key.toLowerCase() === 'i') {
          window.webContents.toggleDevTools();
        }
      });
    });
  }
}
