/** 學生機主程式入口：協調各模組 */
import { ipcMain } from 'electron';

import { initializeApp } from './modules/window.js';
import { registerFileIpc } from './modules/file-recv.js';
import { registerUpdateIpc } from './modules/update.js';
import { registerDiscoverIpc } from './modules/discover-ipc.js';
import { registerSystemCommandsIpc } from './modules/system-commands.js';
import { uwfAction, type UwfAction } from './uwf.js';
import { IPC } from '../shared/ipc.js';

// 註冊各模組的 IPC
function registerAllIpc(): void {
  registerFileIpc();
  registerUpdateIpc();
  registerDiscoverIpc();
  registerSystemCommandsIpc();

  // UWF 遙控（直接在這裡註冊，不拆出模組）
  ipcMain.handle(IPC.uwfAction, (_event, rawAction: unknown, rawPath: unknown) => {
    const action = String(rawAction ?? '');
    const allowed = ['setup', 'install', 'status', 'maint-on', 'maint-off', 'remove', 'set-exclusion'];
    if (!allowed.includes(action)) {
      return { ok: false, text: `不支援的 UWF 動作：${action}` };
    }
    return uwfAction(action as UwfAction, typeof rawPath === 'string' ? rawPath : undefined);
  });
}

// 啟動應用
initializeApp();
registerAllIpc();
