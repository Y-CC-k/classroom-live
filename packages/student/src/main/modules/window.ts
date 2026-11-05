import path from 'node:path';
import { BrowserWindow, nativeImage, Tray, Menu, app, dialog, ipcMain, powerSaveBlocker, globalShortcut } from 'electron';

import { EVENTS, IPC, type HostCommand } from '../../shared/ipc.js';
import { TRAY_ICON_PNG_BASE64 } from '../../shared/tray-icon.js';

import { BroadcastEnforcer } from '../broadcast-enforcer.js';
import { InputLocker } from '../input-lock.js';
import { promoteTrayIcon } from '../tray-promote.js';
import { runStartupBrowserClean } from '../clear-browser.js';
import { getConfig } from '../store.js';

const isDev = process.env.NODE_ENV === 'development';

export interface WindowManagerDeps {
  enforcer: BroadcastEnforcer;
  locker: InputLocker;
  onShowWindow: () => void;
  onHideToTray: () => void;
  onQuitApp: () => void;
  onToggleFullscreen: () => void;
  onReconnect: () => void;
}

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;
let keepAwakeId: number | null = null;

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

export function createWindow(deps: WindowManagerDeps): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 640,
    minHeight: 400,
    show: false,
    backgroundColor: '#05070b',
    title: '教室直播 — 學生機',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  window.once('ready-to-show', () => window.show());

  deps.enforcer.configure(window, line => console.log(line));

  window.webContents.on('did-start-loading', () => deps.enforcer.reset());

  let closePromptOpen = false;
  window.on('close', event => {
    if (quitting) return;
    event.preventDefault();
    if (closePromptOpen) return;

    closePromptOpen = true;

    void dialog
      .showMessageBox(window, {
        type: 'question',
        buttons: ['縮到系統匣', '結束學生機'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        title: '關閉學生機',
        message: '要縮到系統匣繼續上課，還是結束學生機？',
        detail: '縮到系統匣後仍會保持連線，老師依然找得到這台機器。',
      })
      .then(({ response }) => {
        if (response === 1) {
          quitting = true;
          app.quit();
        } else {
          window.hide();
        }
      })
      .catch(() => {
        window.hide();
      })
      .finally(() => {
        closePromptOpen = false;
      });
  });

  window.on('closed', () => {
    mainWindow = null;
  });

  void window.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow = window;
  return window;
}

function send(channel: string, payload?: unknown): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send(channel, payload);
}

function notifyRenderer(command: HostCommand): void {
  send(EVENTS.command, command);
}

function buildTray(deps: WindowManagerDeps): void {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_PNG_BASE64}`);
  tray = new Tray(icon);
  tray.setToolTip('教室直播 — 學生機');

  const menu = Menu.buildFromTemplate([
    {
      label: '顯示視窗',
      click: deps.onShowWindow,
    },
    {
      label: '切換全螢幕',
      click: deps.onToggleFullscreen,
    },
    {
      label: '重新連線',
      click: deps.onReconnect,
    },
    { type: 'separator' },
    {
      label: '結束',
      click: deps.onQuitApp,
    },
  ]);

  tray.setContextMenu(menu);
  tray.on('double-click', deps.onShowWindow);
}

export function registerWindowIpc(deps: WindowManagerDeps): void {
  ipcMain.on(IPC.hideToTray, deps.onHideToTray);
  ipcMain.on('student:show-window', deps.onShowWindow);
  ipcMain.on(IPC.quitApp, deps.onQuitApp);
}

export function initializeApp(): void {
  const gotLock = app.requestSingleInstanceLock();
  if (!gotLock) {
    app.quit();
    return;
  }

  app.setAppUserModelId('com.classroom.student');

  // F1 舉手：系統級全局熱鍵——學生機縮在系統匣（窗口隱藏、無焦點）時也要能觸發，
  // 所以不能用 renderer 的 keydown（窗口隱藏時收不到鍵盤事件）。
  app.whenReady().then(() => {
    try {
      const ok = globalShortcut.register('F1', () => {
        mainWindow?.show();
        mainWindow?.focus();
        notifyRenderer('hand-raise');
      });
      if (ok) console.log('[hand] F1 OK');
      else console.error('[hand] F1 register FAILED');
    } catch (error) {
      console.error('[hand] F1 register error', error);
    }
  });
  app.on('will-quit', () => {
    try {
      globalShortcut.unregisterAll();
    } catch {
      /* 退出清理失敗不影響 */
    }
  });

  app.on('second-instance', () => {
    mainWindow?.show();
    mainWindow?.focus();
  });

  const enforcer = new BroadcastEnforcer();
  // 鎖定診斷訊息（[lock] HOOK 1/1 等）同時送到學生日誌：
  // 安裝版沒有 console，這些訊息原本只在主行程輸出，是診斷上的盲區。
  const locker = new InputLocker(line => {
    console.log(line);
    send(EVENTS.mainLog, line);
  });

  // 教師端鎖定／解除鍵盤滑鼠（低階 hook 封鎖輸入）。
  // 之前此 handler 缺失，鎖定指令會被靜默丟棄（renderer 端 invoke 拋出
  // 「No handler registered」卻無人察覺），全班／單機鎖定因此完全無效。
  ipcMain.handle(IPC.setInputLock, (_event, on: unknown) => {
    locker.setActive(on === true);
    return locker.isActive();
  });

  ipcMain.handle(IPC.setBroadcastMode, (_event, on: unknown) => {
    enforcer.setActive(on === true);
    return enforcer.isActive();
  });

  ipcMain.handle(IPC.setMuted, async (_event, on: unknown): Promise<boolean> => {
    return enforcer.setMuted(on === true);
  });

  ipcMain.handle(IPC.setFullscreen, (_event, on: unknown) => {
    const enable = on === true;
    const win = mainWindow;
    if (win && win.isFullScreen() !== enable) win.setFullScreen(enable);
    return Boolean(win && win.isFullScreen());
  });

  const deps: WindowManagerDeps = {
    enforcer,
    locker,
    onShowWindow: () => {
      if (mainWindow?.isMinimized()) mainWindow.restore();
      mainWindow?.show();
      mainWindow?.focus();
    },
    onHideToTray: () => mainWindow?.hide(),
    onQuitApp: () => {
      quitting = true;
      app.quit();
    },
    onToggleFullscreen: () => {
      mainWindow?.setFullScreen(!mainWindow?.isFullScreen());
    },
    onReconnect: () => {
      notifyRenderer('reconnect');
    },
  };

  app.whenReady().then(async () => {
    const config = getConfig();

    createWindow(deps);
    buildTray(deps);
    registerWindowIpc(deps);

    applyAutoStart(config.autoStart);

    void promoteTrayIcon().then(result => {
      console.log(`[tray] ${result.message}`);
    });

    keepAwakeId = powerSaveBlocker.start('prevent-display-sleep');

    runStartupBrowserClean();

    if (config.autoFullscreen) {
      mainWindow?.setFullScreen(true);
    }

    app.on('activate', () => {
      if (!mainWindow) createWindow(deps);
      mainWindow?.show();
    });
  });

  app.on('before-quit', () => {
    quitting = true;
    locker.dispose();
    if (keepAwakeId !== null) {
      powerSaveBlocker.stop(keepAwakeId);
      keepAwakeId = null;
    }
  });

  app.on('window-all-closed', () => {
    if (isDev) app.quit();
  });
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function setQuitting(value: boolean): void {
  quitting = value;
}
