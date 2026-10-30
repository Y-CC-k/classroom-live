/**
 * 伺服機控制台：主行程 ↔ preload/renderer 的 IPC 契約。
 */

export const IPC = {
  status: 'ctl:status',
  start: 'ctl:start',
  stop: 'ctl:stop',
  restart: 'ctl:restart',
  getConfig: 'ctl:get-config',
  saveConfig: 'ctl:save-config',
  appInfo: 'ctl:app-info',
} as const;

export const EVENTS = {
  status: 'ctl:event-status',
  log: 'ctl:event-log',
  /** 教室在線統計（輪詢 /healthz）；null = 引擎未執行或讀取失敗 */
  stats: 'ctl:event-stats',
} as const;

export interface ControlStatus {
  running: boolean;
  /** classroom-server.exe 的 PID（未執行時 null） */
  pid: number | null;
  /** 本次啟動時間（epoch ms），未執行時 null */
  startedAt: number | null;
  /** 執行檔位置 */
  exePath: string;
  /** 部署設定檔位置（與 classroom-server.exe 同資料夾） */
  configPath: string;
  host: string;
  port: number;
  /** 給老師／資訊組看的連線位址提要 */
  serverUrl: string;
  /** 上一次非人為停止時的結束碼（診斷用） */
  lastExitCode: number | null;
  lastExitSignal: string | null;
}

export interface ServerRuntimeConfig {
  host: string;
  port: number;
  maxStudentsPerRoom: number;
}

export interface ControlConfigSaveResult {
  ok: boolean;
  message: string;
  config: ServerRuntimeConfig;
}

export interface ControlApi {
  status: () => Promise<ControlStatus>;
  start: () => Promise<ControlStatus>;
  stop: () => Promise<ControlStatus>;
  restart: () => Promise<ControlStatus>;
  getConfig: () => Promise<ServerRuntimeConfig>;
  saveConfig: (patch: Partial<ServerRuntimeConfig>) => Promise<ControlConfigSaveResult>;
  appInfo: () => Promise<{ version: string; platform: string; electron: string }>;
}

export interface ControlEvents {
  onStatus: (callback: (status: ControlStatus) => void) => void;
  onLog: (callback: (line: string) => void) => void;
  onStats: (callback: (stats: ServerLiveStats | null) => void) => void;
}

/** 教室在線統計（來自引擎 /healthz） */
export interface ServerLiveStats {
  ok: boolean;
  rooms: number;
  students: number;
  teachers: number;
  /** 引擎已運行秒數 */
  uptime: number;
  classrooms: ClassroomLiveStat[];
}

/** 一個班級的在線狀態 */
export interface ClassroomLiveStat {
  classId: string;
  teacherOnline: boolean;
  teacherName: string;
  students: number;
}
