import { contextBridge, ipcRenderer } from 'electron';

import { EVENTS, IPC, type ControlApi, type ControlEvents } from '../shared/ipc.js';

const api: ControlApi = {
  status: () => ipcRenderer.invoke(IPC.status),
  start: () => ipcRenderer.invoke(IPC.start),
  stop: () => ipcRenderer.invoke(IPC.stop),
  restart: () => ipcRenderer.invoke(IPC.restart),
  getConfig: () => ipcRenderer.invoke(IPC.getConfig),
  saveConfig: patch => ipcRenderer.invoke(IPC.saveConfig, patch),
  appInfo: () => ipcRenderer.invoke(IPC.appInfo),
};

const events: ControlEvents = {
  onStatus: callback => {
    ipcRenderer.on(EVENTS.status, (_event, status) => callback(status));
  },
  onLog: callback => {
    ipcRenderer.on(EVENTS.log, (_event, line: string) => callback(line));
  },
  onStats: callback => {
    ipcRenderer.on(EVENTS.stats, (_event, stats) => callback(stats ?? null));
  },
};

contextBridge.exposeInMainWorld('controlApi', api);
contextBridge.exposeInMainWorld('controlEvents', events);
