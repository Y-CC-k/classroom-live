import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import type { StudentConfig } from '../shared/ipc.js';
import { detectLocalIp } from './local-ip.js';

/**
 * 兩層設定：
 *
 *   部署層（安裝目錄的 config.json，資訊組／安裝包提供）
 *     > 個人層（userData 的 student-config.json，UI 修改後由程式寫入）
 *     > 程式內建 DEFAULTS
 *
 * 部署層可帶 serverUrl / classId / lockServerUrl。
 *
 * 合併語義：
 *   - 個人層記錄「上次已套用的部署值」（appliedDeploy* 欄位）。
 *   - 部署層的值與上次相同 → 以個人層為準。
 *   - 部署層的值變更了（例如伺服機搬家）→ 部署層隨即壓過個人層，
 *     60 台學生機只要換 config.json 就整批被更新。
 *   - `lockServerUrl: true` → serverUrl 每次都以部署層為準，UI 唯讀。
 *
 * 程式不回寫安裝目錄（Program Files 通常需要管理員權限），
 * config.json 由資訊組直接編輯，改完重開程式即可。
 */

const DEFAULTS: StudentConfig = {
  serverUrl: 'ws://127.0.0.1:8787',
  classId: '',
  studentName: '',
  autoConnect: false,
  autoFullscreen: true,
  // 登入自動啟動預設開：一鍵開機只會把機器叫醒，程式沒有自己跑起來就等於沒開機。
  autoStart: true,
  serverUrlLocked: false,
  fileSaveDir: '',
  sfuServerUrl: '',
};

const DEPLOY_FILE = 'config.json';

interface DeploymentConfig {
  serverUrl?: string;
  classId?: string;
  lockServerUrl: boolean;
  /** 教師機傳送檔案的落地資料夾；未設定時使用「桌面\SETUP」 */
  fileSaveDir?: string;
  /** 安裝後自動連線（雙擊安裝包、裝完即上線的整批部署用） */
  autoConnect?: boolean;
  /** 登入自動啟動（整批部署可在此關閉；個人層可在設定面板調整） */
  autoStart?: boolean;
}

/** 個人層 JSON 額外記錄的部署套用追蹤（僅存在磁碟，不回傳給 renderer） */
interface DeployTracing {
  appliedDeployServerUrl: string | null;
  appliedDeployClassId: string | null;
  appliedDeployFileSaveDir: string | null;
  appliedDeployAutoConnect: boolean | null;
  appliedDeployAutoStart: boolean | null;
}

let cache: StudentConfig | null = null;
let deployCache: DeploymentConfig | null = null;

function deployPath(): string {
  // 開發時 = packages/student/config.json；打包後（非 asar）= resources/app/config.json
  return path.join(app.getAppPath(), DEPLOY_FILE);
}

function loadDeployment(): DeploymentConfig {
  const result: DeploymentConfig = { lockServerUrl: false };
  try {
    const raw = JSON.parse(fs.readFileSync(deployPath(), 'utf8')) as Record<string, unknown>;
    if (typeof raw.serverUrl === 'string' && raw.serverUrl.trim()) {
      result.serverUrl = raw.serverUrl.trim();
      result.lockServerUrl = raw.lockServerUrl === true;
    }
    if (typeof raw.classId === 'string' && raw.classId.trim()) {
      result.classId = raw.classId.trim().slice(0, 16);
    }
    if (typeof raw.fileSaveDir === 'string' && raw.fileSaveDir.trim()) {
      result.fileSaveDir = raw.fileSaveDir.trim();
    }
    if (raw.autoConnect === true) {
      result.autoConnect = true;
    }
    if (typeof raw.autoStart === 'boolean') {
      result.autoStart = raw.autoStart;
    }
  } catch {
    // 沒有部署設定檔或格式錯 → 完全交給個人層
  }
  return result;
}

/** 教師機送來檔案的預設落地位置：部室標準是 D:\；沒有 D: 槽才退回桌面的「SETUP」 */
export function defaultFileSaveDir(): string {
  try {
    fs.accessSync('D:\\');
    return 'D:\\';
  } catch {
    return path.join(app.getPath('desktop'), 'SETUP');
  }
}

function deployment(): DeploymentConfig {
  if (!deployCache) deployCache = loadDeployment();
  return deployCache;
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'student-config.json');
}

function readPersonal(): { data: Partial<StudentConfig>; tracing: DeployTracing; existed: boolean } {
  let data: Partial<StudentConfig> = {};
  let tracing: DeployTracing = {
    appliedDeployServerUrl: null,
    appliedDeployClassId: null,
    appliedDeployFileSaveDir: null,
    appliedDeployAutoConnect: null,
    appliedDeployAutoStart: null,
  };
  let existed = true;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Partial<StudentConfig> & Record<string, unknown>;
    data = raw;
    tracing = {
      appliedDeployServerUrl: typeof raw.appliedDeployServerUrl === 'string' ? raw.appliedDeployServerUrl : null,
      appliedDeployClassId: typeof raw.appliedDeployClassId === 'string' ? raw.appliedDeployClassId : null,
      appliedDeployFileSaveDir: typeof raw.appliedDeployFileSaveDir === 'string' ? raw.appliedDeployFileSaveDir : null,
      appliedDeployAutoConnect: typeof raw.appliedDeployAutoConnect === 'boolean' ? raw.appliedDeployAutoConnect : null,
      appliedDeployAutoStart: typeof raw.appliedDeployAutoStart === 'boolean' ? raw.appliedDeployAutoStart : null,
    };
  } catch {
    // 檔案不存在或損毀 → 回到預設值
    existed = false;
  }
  return { data, tracing, existed };
}

/** serverUrlLocked 是 IPC 傳回值的運算欄位，不寫進個人設定檔 */
function persistable(config: StudentConfig): Partial<StudentConfig> {
  const { serverUrlLocked, ...rest } = config;
  void serverUrlLocked;
  return rest;
}

function writePersonal(config: StudentConfig, tracing: DeployTracing): void {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({ ...persistable(config), ...tracing }, null, 2), 'utf8');
  } catch (error) {
    console.error('[store] 設定寫入失敗', error);
  }
}

export function getConfig(): StudentConfig {
  const deploy = deployment();

  if (!cache) {
    const { data: parsed, tracing } = readPersonal();

    const next: StudentConfig = sanitize({ ...DEFAULTS, ...parsed });

    let dirty = false;

    // 部署層的 classId 變更（或第一次）→ 壓過個人層
    if (deploy.classId !== undefined && deploy.classId !== tracing.appliedDeployClassId) {
      next.classId = deploy.classId;
      tracing.appliedDeployClassId = deploy.classId;
      dirty = true;
    }

    // 部署層的 serverUrl：鎖定時永遠以部署層為準；
    // 未鎖定時，只有部署層變更才重新壓過個人層。
    if (deploy.serverUrl !== undefined) {
      if (deploy.lockServerUrl || deploy.serverUrl !== tracing.appliedDeployServerUrl) {
        next.serverUrl = deploy.serverUrl;
        tracing.appliedDeployServerUrl = deploy.serverUrl;
        dirty = true;
      }
    }

    // 部署層的 fileSaveDir：值變更（或第一次）→ 壓過個人層；之後設定面板可自行改
    if (deploy.fileSaveDir !== undefined) {
      if (deploy.fileSaveDir !== tracing.appliedDeployFileSaveDir) {
        next.fileSaveDir = deploy.fileSaveDir;
        tracing.appliedDeployFileSaveDir = deploy.fileSaveDir;
        dirty = true;
      }
    }

    // 部署層的 autoConnect：值變更（或第一次）→ 壓過個人層（整批部署開自動連線用）
    if (deploy.autoConnect !== undefined) {
      if (deploy.autoConnect !== tracing.appliedDeployAutoConnect) {
        next.autoConnect = deploy.autoConnect;
        tracing.appliedDeployAutoConnect = deploy.autoConnect;
        dirty = true;
      }
    }

    // 部署層的 autoStart：值變更（或第一次）→ 壓過個人層（整批部署用）
    if (deploy.autoStart !== undefined) {
      if (deploy.autoStart !== tracing.appliedDeployAutoStart) {
        next.autoStart = deploy.autoStart;
        tracing.appliedDeployAutoStart = deploy.autoStart;
        dirty = true;
      }
    }

    // 沒有部署值也沒有個人值 → 內建預設（D:\；沒有 D 槽的機器退回「桌面\SETUP」）
    if (!next.fileSaveDir) next.fileSaveDir = defaultFileSaveDir();

    next.serverUrlLocked = deploy.lockServerUrl;
    cache = next;

    // 部署值有變動（或第一次安裝）才寫回磁碟
    if (dirty || (!tracing.appliedDeployServerUrl && deploy.serverUrl !== undefined)) {
      writePersonal(next, tracing);
    }
  }

  // 學生機名稱固定是本機 IP：每次讀取都以現場偵測到的值為準，
  // 老師在清單上直接看 IP 就知道是哪一台，學生也無法自行改名。
  cache.studentName = detectLocalIp();
  return cache;
}

export function saveConfig(patch: Partial<StudentConfig>): StudentConfig {
  // 名稱固定是本機 IP，不是可設定的項目，所以忽略外面傳進來的 studentName。
  const rest: Partial<StudentConfig> = { ...patch };
  delete rest.studentName;

  const next = sanitize({ ...getConfig(), ...rest });
  const deploy = deployment();
  const { tracing } = readPersonal();

  if (deploy.lockServerUrl && deploy.serverUrl !== undefined) {
    // 部署層鎖定時，UI 傳來的 serverUrl 一律忽略
    next.serverUrl = deploy.serverUrl;
  }
  next.serverUrlLocked = deploy.lockServerUrl;
  // 部署層的 fileSaveDir 只有「值變更」時才重新壓過；其餘尊重 UI 指定的個人值
  if (deploy.fileSaveDir !== undefined && deploy.fileSaveDir !== tracing.appliedDeployFileSaveDir) {
    next.fileSaveDir = deploy.fileSaveDir;
  }
  if (!next.fileSaveDir) next.fileSaveDir = defaultFileSaveDir();

  // 部署層的 autoConnect：只有「值變更」時才重新壓過；其餘尊重 UI 的勾選狀態
  if (deploy.autoConnect !== undefined && deploy.autoConnect !== tracing.appliedDeployAutoConnect) {
    next.autoConnect = deploy.autoConnect;
  }

  // 部署層的 autoStart：只有「值變更」時才重新壓過；其餘尊重 UI 的勾選狀態
  if (deploy.autoStart !== undefined && deploy.autoStart !== tracing.appliedDeployAutoStart) {
    next.autoStart = deploy.autoStart;
  }

  // UI 存檔的同時記下「目前部署值已套用」，之後部署檔不變就尊重個人層
  tracing.appliedDeployServerUrl = deploy.serverUrl ?? tracing.appliedDeployServerUrl;
  tracing.appliedDeployClassId = deploy.classId ?? tracing.appliedDeployClassId;
  tracing.appliedDeployFileSaveDir = deploy.fileSaveDir ?? tracing.appliedDeployFileSaveDir;
  tracing.appliedDeployAutoConnect = deploy.autoConnect ?? tracing.appliedDeployAutoConnect;
  tracing.appliedDeployAutoStart = deploy.autoStart ?? tracing.appliedDeployAutoStart;

  cache = next;
  writePersonal(next, tracing);
  return next;
}

function sanitize(config: StudentConfig): StudentConfig {
  return {
    serverUrl: config.serverUrl.trim() || DEFAULTS.serverUrl,
    classId: config.classId.trim().slice(0, 16),
    studentName: config.studentName.trim().slice(0, 32),
    autoConnect: Boolean(config.autoConnect),
    autoFullscreen: Boolean(config.autoFullscreen),
    // 登入自動啟動：預設 true，但要能被 UI/部署檔關閉。只有布林值才視為有效。
    autoStart: config.autoStart === false ? false : true,
    fileSaveDir: config.fileSaveDir.trim(),
    serverUrlLocked: false,
    sfuServerUrl: config.sfuServerUrl.trim(),
  };
}
