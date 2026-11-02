import { contextBridge, ipcRenderer } from 'electron';

import {
  EVENTS,
  IPC,
  type HostCommand,
  type NetworkInfo,
  type StudentApi,
  type StudentConfig,
  type StudentEvents,
} from '../shared/ipc.js';

const api: StudentApi = {
  getConfig: () => ipcRenderer.invoke(IPC.getConfig) as Promise<StudentConfig>,
  saveConfig: (patch: Partial<StudentConfig>) => ipcRenderer.invoke(IPC.saveConfig, patch) as Promise<StudentConfig>,
  appInfo: () =>
    ipcRenderer.invoke(IPC.appInfo) as Promise<{
      version: string;
      platform: string;
      electron: string;
      userDataPath: string;
      saveDir: string;
      build: string | null;
    }>,
  setFullscreen: (on: boolean) => ipcRenderer.invoke(IPC.setFullscreen, on) as Promise<boolean>,
  openUrl: (url: string) => ipcRenderer.invoke(IPC.openUrl, url) as Promise<boolean>,
  fileBegin: (id: string, name: string, size: number) =>
    ipcRenderer.invoke(IPC.fileBegin, id, name, size) as Promise<{ path: string } | { error: string }>,
  // 高頻走單向 send：一秒幾十片，用 invoke 會多一倍來回成本
  fileChunk: (id: string, chunk: ArrayBuffer) => ipcRenderer.send(IPC.fileChunk, id, chunk),
  fileEnd: (id: string) =>
    ipcRenderer.invoke(IPC.fileEnd, id) as Promise<{ ok: boolean; path: string | null; message?: string }>,
  chooseSaveDir: () => ipcRenderer.invoke(IPC.chooseSaveDir) as Promise<string | null>,

  setBroadcastMode: (on: boolean) => ipcRenderer.invoke(IPC.setBroadcastMode, on) as Promise<boolean>,
  setMuted: (on: boolean) => ipcRenderer.invoke(IPC.setMuted, on) as Promise<boolean>,
  closeBrowsers: () => ipcRenderer.invoke(IPC.closeBrowsers) as Promise<boolean>,
  getScreenSource: () => ipcRenderer.invoke(IPC.getScreenSource) as Promise<{ id: string } | { error: string }>,
  setInputLock: (on: boolean) => ipcRenderer.invoke(IPC.setInputLock, on) as Promise<boolean>,
  requestShutdown: (delaySec: number) => ipcRenderer.invoke(IPC.requestShutdown, delaySec) as Promise<boolean>,
  applyUpdate: () => ipcRenderer.invoke(IPC.applyUpdate) as Promise<{ ok: boolean; reason?: string }>,
  getIdleImage: () => ipcRenderer.invoke(IPC.getIdleImage) as Promise<string | null>,
  discoverServers: (timeoutMs?: number) =>
    ipcRenderer.invoke(IPC.discoverServers, timeoutMs) as Promise<{ wsUrl: string }[]>,
  cleanFileDir: () =>
    ipcRenderer.invoke(IPC.cleanFileDir) as Promise<{ ok: boolean; deleted: number; message?: string }>,
  execProgram: (target: string, args: string[]) =>
    ipcRenderer.invoke(IPC.execProgram, target, args) as Promise<{ ok: boolean; message?: string }>,
  uwfAction: (
    action: 'setup' | 'install' | 'status' | 'maint-on' | 'maint-off' | 'remove' | 'set-exclusion',
    path?: string
  ) =>
    ipcRenderer.invoke(IPC.uwfAction, action, path) as Promise<{
      ok: boolean;
      text: string;
      rebooting?: boolean;
    }>,
  requestReboot: (delaySec: number) => ipcRenderer.invoke(IPC.requestReboot, delaySec) as Promise<boolean>,
  hideToTray: () => ipcRenderer.send(IPC.hideToTray),
  showWindow: () => ipcRenderer.send('student:show-window'),
  quitApp: () => ipcRenderer.send(IPC.quitApp),
  networkInfo: () => ipcRenderer.invoke(IPC.networkInfo) as Promise<NetworkInfo>,
};

const events: StudentEvents = {
  onCommand: callback => {
    ipcRenderer.on(EVENTS.command, (_event, command: HostCommand) => callback(command));
  },
};

contextBridge.exposeInMainWorld('studentApi', api);
contextBridge.exposeInMainWorld('studentEvents', events);
