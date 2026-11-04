import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC,
  type AppInfo,
  type CaptureSource,
  type TeacherApi,
  type TeacherConfig,
  type WakeSendResult,
  type WakeTarget,
} from '../shared/ipc.js';
import type { PeerInfo } from '@classroom/protocol';

/**
 * preload 是唯一能同時碰到 Node 與 DOM 的地方。
 * 這裡只暴露「資料」與「明確的動作」，不暴露任何 ipcRenderer 原始物件，
 * 避免 renderer 被注入的內容任意呼叫主行程。
 */
const api: TeacherApi = {
  listSources: () => ipcRenderer.invoke(IPC.listSources) as Promise<CaptureSource[]>,
  getConfig: () => ipcRenderer.invoke(IPC.getConfig) as Promise<TeacherConfig>,
  saveConfig: (patch: Partial<TeacherConfig>) => ipcRenderer.invoke(IPC.saveConfig, patch) as Promise<TeacherConfig>,
  appInfo: () => ipcRenderer.invoke(IPC.appInfo) as Promise<AppInfo>,
  getWakeRoster: () => ipcRenderer.invoke(IPC.getWakeRoster) as Promise<WakeTarget[]>,
  reportWakePeers: (peers: PeerInfo[]) => ipcRenderer.invoke(IPC.reportWakePeers, peers) as Promise<WakeTarget[]>,
  wake: (targets?: string[]) => ipcRenderer.invoke(IPC.wake, targets) as Promise<WakeSendResult[]>,
  saveSnapshot: (studentName: string, dataBase64: string) =>
    ipcRenderer.invoke(IPC.saveSnapshot, studentName, dataBase64) as Promise<{
      ok: boolean;
      path?: string;
      message?: string;
    }>,
  openSnapshotsFolder: () => ipcRenderer.invoke(IPC.openSnapshotsFolder) as Promise<string>,
  setFullscreen: (on: boolean) => ipcRenderer.invoke(IPC.setFullscreen, on) as Promise<boolean>,
};

contextBridge.exposeInMainWorld('teacherApi', api);
