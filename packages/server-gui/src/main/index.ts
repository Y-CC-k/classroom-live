import path from 'node:path';

import { app, BrowserWindow, ipcMain, Menu, nativeImage, shell, Tray } from 'electron';
import http from 'node:http';

import {
  EVENTS,
  IPC,
  type ControlApi,
  type ControlStatus,
  type ServerLiveStats,
  type ServerRuntimeConfig,
} from '../shared/ipc.js';
import { ServerManager } from './server-manager.js';

const currentDir = __dirname;

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
/** --hidden = 開機自動啟動（LoginItem 帶的參數）：不秀視窗＋自動把引擎拉起 */
const hiddenArg = process.argv.includes('--hidden');

function rendererFile(name: string): string {
  return path.join(currentDir, '..', 'renderer', name);
}

const LOG_TAIL_LIMIT = 800;
let logTail: string[] = [];

function appendLog(line: string): void {
  if (!line) return;
  logTail.push(line);
  if (logTail.length > LOG_TAIL_LIMIT) logTail = logTail.slice(-LOG_TAIL_LIMIT);
  mainWindow?.webContents.send(EVENTS.log, line);
}

const manager = new ServerManager({
  onLog: appendLog,
  onStatusChange: () => {
    mainWindow?.webContents.send(EVENTS.status, manager.status());
    updateTrayStatus();
  },
});

// ─────────────── 教室在線統計：輪詢引擎 /healthz ───────────────

function sendStats(stats: ServerLiveStats | null): void {
  mainWindow?.webContents.send(EVENTS.stats, stats);
}

function pollStats(): void {
  const status = manager.status();
  if (!status.running) {
    sendStats(null);
    return;
  }
  // 對引擎的 http 健康檢查埠做本機輪詢（host 不重要，引擎必在本機）
  const request = http.get(`http://127.0.0.1:${status.port}/healthz`, { timeout: 2500 }, res => {
    let data = '';
    res.on('data', chunk => (data += String(chunk)));
    res.on('end', () => {
      try {
        const parsed = JSON.parse(data) as ServerLiveStats;
        sendStats(parsed.ok ? parsed : null);
      } catch {
        sendStats(null);
      }
    });
  });
  request.on('timeout', () => {
    request.destroy();
    sendStats(null);
  });
  request.on('error', () => sendStats(null));
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 860,
    height: 720,
    minWidth: 700,
    minHeight: 560,
    show: false,
    backgroundColor: '#10141c',
    title: '教室直播 — 伺服機控制台',
    autoHideMenuBar: true,
    icon: path.join(currentDir, '..', '..', 'build', 'icon.png'),
    skipTaskbar: true, // 啟動後不出現在工作列，僅常駐系統匣
    webPreferences: {
      preload: path.join(currentDir, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.once('ready-to-show', () => {
    // 開機自動啟動模式（--hidden）：不開視窗，常駐系統匣
    if (!hiddenArg) mainWindow?.show();
  });
  // 按 ✕ 關閉視窗時停止伺服器並結束程式（不再只藏到系統匣）
  mainWindow.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void manager
      .dispose()
      .catch(() => undefined)
      .finally(() => {
        app.exit(0);
      });
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  //公開課器材不希望意外開瀏覽器視窗
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  void mainWindow.loadFile(rendererFile('index.html'));
}

/** 控制台圖示（打包後在 resources\app\build\icon.png，開發中在 packages 同層） */
function trayIcon(): Tray | null {
  try {
    const image = nativeImage.createFromPath(path.join(currentDir, '..', '..', 'build', 'icon.png'));
    return image.isEmpty() ? null : new Tray(image);
  } catch {
    return null;
  }
}

function buildTray(): void {
  tray = trayIcon();
  if (!tray) {
    appendLog('[ctl] 系統匣圖示建立失敗；關閉視窗仍會結束程式。');
    return;
  }
  tray.setToolTip('教室直播 — 伺服機控制台');
  tray.on('double-click', () => mainWindow?.show());
  tray.on('click', () => mainWindow?.show());
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '顯示控制台', click: () => mainWindow?.show() },
      {
        label: '開機自動啟動（隱藏常駐）',
        type: 'checkbox',
        checked: app.getLoginItemSettings({ args: ['--hidden'] }).openAtLogin,
        click: item => {
          app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--hidden'] });
          appendLog(`[ctl] 開機自動啟動：${item.checked ? '開' : '關'}`);
        },
      },
      { type: 'separator' },
      { label: '啟動信號伺服器', click: () => void manager.start() },
      { label: '停止信號伺服器', click: () => void manager.stop() },
      { label: '重新啟動信號伺服器', click: () => void manager.restart() },
      { type: 'separator' },
      {
        label: '結束程式（停止伺服器並離開）',
        click: () => {
          quitting = true;
          void manager
            .dispose()
            .catch(() => undefined)
            .finally(() => app.exit(0));
        },
      },
    ])
  );
  updateTrayStatus();
}

/** 依伺服器狀態更新系統匣提示（懸停即見，不必開視窗） */
function updateTrayStatus(): void {
  if (!tray) return;
  const status = manager.status();
  tray.setToolTip(
    status.running
      ? `教室直播 — 信號伺服器運行中（${status.serverUrl}，PID ${status.pid}）\n控制台在系統匣按 ✕ 也能保持運行`
      : '教室直播 — 信號伺服器已停止（控制台右鍵可啟動）'
  );
}

function registerIpc(): void {
  type Api = Pick<ControlApi, 'status' | 'start' | 'stop' | 'restart' | 'getConfig' | 'saveConfig' | 'appInfo'>;
  const api: Api = {
    status: async (): Promise<ControlStatus> => manager.status(),
    start: async () => manager.start(),
    stop: async () => manager.stop(),
    restart: async () => manager.restart(),
    getConfig: async (): Promise<ServerRuntimeConfig> => manager.runtimeConfig(),
    saveConfig: async patch => {
      if (manager.status().running) {
        return {
          ok: false,
          message: '伺服機正在執行中；先「停止」再修改設定，或改完按「重新啟動」。',
          config: manager.runtimeConfig(),
        };
      }
      const config = manager.saveRuntimeConfig(patch);
      return { ok: true, message: '已寫入 config.json，啟動後生效。', config };
    },
    appInfo: async () => ({
      version: app.getVersion(),
      platform: `${process.platform} ${process.arch}`,
      electron: process.versions.electron ?? 'unknown',
    }),
  };

  ipcMain.handle(IPC.status, api.status);
  ipcMain.handle(IPC.start, api.start);
  ipcMain.handle(IPC.stop, api.stop);
  ipcMain.handle(IPC.restart, api.restart);
  ipcMain.handle(IPC.getConfig, api.getConfig);
  ipcMain.handle(IPC.saveConfig, (_event, patch: Partial<ServerRuntimeConfig>) => api.saveConfig(patch));
  ipcMain.handle(IPC.appInfo, api.appInfo);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.setAppUserModelId('com.classroom.server-gui');
  app.on('second-instance', () => {
    mainWindow?.focus();
  });

  app.whenReady().then(async () => {
    registerIpc();
    createWindow();
    buildTray();
    // 每 5 秒輪詢引擎統計（引擎沒跑時回 null，畫面顯示待機）
    setInterval(pollStats, 5000);

    if (hiddenArg) {
      // 開機自動啟動路徑：引擎直接拉起、控制台常駐系統匣
      setTimeout(() => void manager.start(), 300);
      appendLog('[ctl] 開機自動啟動：正在啟動信號伺服器（控制台在系統匣）。');
    } else {
      appendLog('[ctl] 控制台已就緒（縮進系統匣可保持伺服器在背景運行）。');
    }

    // 安裝版預設登記「開機自動啟動」（可用系統匣選單的勾選項關掉）
    if (app.isPackaged) {
      try {
        app.setLoginItemSettings({ openAtLogin: true, args: ['--hidden'] });
        appendLog('[ctl] 已登記開機自動啟動（重開機後伺服器自己上線）。');
      } catch {
        appendLog('[ctl] 登記開機自動啟動失敗（不影響其他功能）。');
      }
    }

    mainWindow?.webContents.send(EVENTS.status, manager.status());
  });

  app.on('before-quit', () => {
    if (quitting) return;
    // 一般退出（例如安裝器先殼載入）：保險停掉引擎
    quitting = true;
    void manager.dispose();
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
