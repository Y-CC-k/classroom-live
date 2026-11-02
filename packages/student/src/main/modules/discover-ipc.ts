import { ipcMain } from 'electron';

import { IPC } from '../../shared/ipc.js';
import { discoverServers } from './discover.js';

export function registerDiscoverIpc(): void {
  ipcMain.handle(IPC.discoverServers, (_event, timeoutMs: unknown): Promise<{ wsUrl: string }[]> => {
    const timeout = typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) ? timeoutMs : 2000;
    return discoverServers(timeout);
  });
}
