import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

import type { TeacherConfig } from '../shared/ipc.js';
import { QUALITY_PRESETS, STANDARD_QUALITY, matchQualityPreset } from '../shared/ipc.js';

/**
 * 兩層設定：
 *
 *   部署層（安裝目錄的 config.json，資訊組／安裝包提供）
 *     > 個人層（userData 的 teacher-config.json，UI 修改後由程式寫入）
 *     > 程式內建 DEFAULTS
 *
 * 部署層可帶 serverUrl / classId / lockServerUrl。
 *
 * 合併語義：
 *   - 個人層記錄「上次已套用的部署值」（appliedDeploy* 欄位）。
 *   - 部署層的值與上次相同 → 以個人層為準（老師 UI 改過的值持續有效）。
 *   - 部署層的值變更了（例如伺服機搬家）→ 部署層隨即壓過個人層，
 *     並把已套用值記回個人層，讓整間教室在不鎖定IP的狀況下也能被更新。
 *   - `lockServerUrl: true` → serverUrl 每次都以部署層為準，UI 唯讀。
 *
 * 程式不回寫安裝目錄（Program Files 通常需要管理員權限），
 * config.json 由資訊組直接編輯，改完重開程式即可。
 */

/**
 * 舊版內建畫質：升級時用來判斷「老師根本沒動過設定」。
 * 內建畫質本身 = `STANDARD_QUALITY`（「一般」預設，見 shared/ipc.ts）。
 * 以前是 30fps / 6Mbps 不設限解析度，那組設定正是秒差會越上課越大的原因。
 */
const LEGACY_MAX_BITRATE = 6_000_000;
const LEGACY_MAX_FRAMERATE = 30;

const DEFAULTS: TeacherConfig = {
  serverUrl: 'ws://127.0.0.1:8787',
  teacherName: '教師機',
  classId: '',
  lastSourceId: null,
  maxBitrate: STANDARD_QUALITY.maxBitrate,
  maxFramerate: STANDARD_QUALITY.maxFramerate,
  maxCaptureWidth: STANDARD_QUALITY.maxCaptureWidth,
  maxCaptureHeight: STANDARD_QUALITY.maxCaptureHeight,
  qualityPreset: STANDARD_QUALITY.id,
  flipCamera: false,
  hardwareCodec: true,
  broadcastMode: 'video',
  /** 定影幀 JPEG 品質預設＝0.85 */
  imgSharpQuality: 0.85,
  serverUrlLocked: false,
  adaptiveQualityEnabled: false,
  // SFU 設定
  sfuServerUrl: '',
  sfuAnnouncedIp: null,
  sfuRtpPortRange: null,
};

const DEPLOY_FILE = 'config.json';

interface DeploymentConfig {
  serverUrl?: string;
  classId?: string;
  lockServerUrl: boolean;
}

/** 個人層 JSON 額外記錄的部署套用追蹤（僅存在磁碟，不回傳給 renderer） */
interface DeployTracing {
  appliedDeployServerUrl: string | null;
  appliedDeployClassId: string | null;
}

let cache: TeacherConfig | null = null;
let deployCache: DeploymentConfig | null = null;

function deployPath(): string {
  // 開發時 = packages/teacher/config.json；打包後（非 asar）= resources/app/config.json
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
  } catch {
    // 沒有部署設定檔或格式錯 → 完全交給個人層
  }
  return result;
}

function deployment(): DeploymentConfig {
  if (!deployCache) deployCache = loadDeployment();
  return deployCache;
}

function configPath(): string {
  return path.join(app.getPath('userData'), 'teacher-config.json');
}

function readPersonal(): { data: Partial<TeacherConfig>; tracing: DeployTracing; existed: boolean } {
  let data: Partial<TeacherConfig> = {};
  let tracing: DeployTracing = { appliedDeployServerUrl: null, appliedDeployClassId: null };
  let existed = true;
  try {
    const raw = JSON.parse(fs.readFileSync(configPath(), 'utf8')) as Partial<TeacherConfig> & Record<string, unknown>;
    data = raw;
    tracing = {
      appliedDeployServerUrl: typeof raw.appliedDeployServerUrl === 'string' ? raw.appliedDeployServerUrl : null,
      appliedDeployClassId: typeof raw.appliedDeployClassId === 'string' ? raw.appliedDeployClassId : null,
    };
  } catch {
    // 檔案不存在或損毀都回到預設值，不要讓老師卡在無法啟動
    existed = false;
  }
  return { data, tracing, existed };
}

/** serverUrlLocked 是 IPC 傳回值的運算欄位，不寫進個人設定檔 */
function persistable(config: TeacherConfig): Partial<TeacherConfig> {
  const { serverUrlLocked, ...rest } = config;
  void serverUrlLocked;
  return rest;
}

function writePersonal(config: TeacherConfig, tracing: DeployTracing): void {
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify({ ...persistable(config), ...tracing }, null, 2), 'utf8');
  } catch (error) {
    console.error('[store] 設定寫入失敗', error);
  }
}

export function getConfig(): TeacherConfig {
  if (cache) return cache;

  const deploy = deployment();
  const { data: parsed, tracing } = readPersonal();

  const next: TeacherConfig = sanitize({ ...DEFAULTS, ...parsed });

  let dirty = false;

  // 舊版升級：個人設定檔裡沒有畫質預設，幀率／頻寬是寫死的 30fps / 6 Mbps，
  // 而且擷取尺寸不設限（4K 螢幕也硬編）——這正是「秒差越上課越大」的來源。
  //   - 從沒調過設定 → 直接換成新預設，問題自動消失（廣播面板可隨時換回）。
  //   - 自己調過 → 保留原值並標成「自訂」，只把「不縮放」的旧行為寫回去，
  //     不擅自改變老師選過的畫質。
  if (typeof parsed.qualityPreset !== 'string') {
    const untouched =
      (parsed.maxBitrate ?? LEGACY_MAX_BITRATE) === LEGACY_MAX_BITRATE &&
      (parsed.maxFramerate ?? LEGACY_MAX_FRAMERATE) === LEGACY_MAX_FRAMERATE;
    if (untouched) {
      next.maxBitrate = STANDARD_QUALITY.maxBitrate;
      next.maxFramerate = STANDARD_QUALITY.maxFramerate;
      next.maxCaptureWidth = STANDARD_QUALITY.maxCaptureWidth;
      next.maxCaptureHeight = STANDARD_QUALITY.maxCaptureHeight;
      next.qualityPreset = STANDARD_QUALITY.id;
    } else {
      // 自己調過：數字一律保留，只補標籤（尺寸是新版才有的欄位，
      // 老師沒設過 → 先拿 DEFAULTS 注入的值去比對，比不中才退回「不縮放」的旧行為）
      const matched = matchQualityPreset(next);
      if (matched) {
        next.qualityPreset = matched.id;
      } else {
        next.maxCaptureWidth = 0;
        next.maxCaptureHeight = 0;
        next.qualityPreset = 'custom';
      }
    }
    dirty = true;
  }

  // 部署層的 classId 出現過但「上次沒套用過」或「值變了」→ 套用新值
  if (deploy.classId !== undefined && deploy.classId !== tracing.appliedDeployClassId) {
    next.classId = deploy.classId;
    tracing.appliedDeployClassId = deploy.classId;
    dirty = true;
  }

  // 部署層的 serverUrl：鎖定時永遠以部署層為準；
  // 未鎖定時，只有部署層變更（與上次套用值不同）才重新壓過個人層。
  if (deploy.serverUrl !== undefined) {
    if (deploy.lockServerUrl || deploy.serverUrl !== tracing.appliedDeployServerUrl) {
      next.serverUrl = deploy.serverUrl;
      tracing.appliedDeployServerUrl = deploy.serverUrl;
      dirty = true;
    }
  }

  next.serverUrlLocked = deploy.lockServerUrl;
  cache = next;

  // 部署值有變動（或第一次安裝）才寫回磁碟；不然每次啟動都不必動檔
  if (dirty || (!tracing.appliedDeployServerUrl && deploy.serverUrl !== undefined)) {
    writePersonal(next, tracing);
  }

  return cache;
}

export function saveConfig(patch: Partial<TeacherConfig>): TeacherConfig {
  const next = sanitize({ ...getConfig(), ...patch });
  const deploy = deployment();
  const { tracing } = readPersonal();

  if (deploy.lockServerUrl && deploy.serverUrl !== undefined) {
    // 部署層鎖定時，UI 傳來的 serverUrl 一律忽略
    next.serverUrl = deploy.serverUrl;
  }
  next.serverUrlLocked = deploy.lockServerUrl;

  // UI 存檔的同時記下「目前部署值已套用」，之後部署檔不變就尊重個人層
  tracing.appliedDeployServerUrl = deploy.serverUrl ?? tracing.appliedDeployServerUrl;
  tracing.appliedDeployClassId = deploy.classId ?? tracing.appliedDeployClassId;

  cache = next;
  writePersonal(next, tracing);
  return next;
}

function sanitize(config: TeacherConfig): TeacherConfig {
  const capture = sanitizeCaptureSize(config.maxCaptureWidth, config.maxCaptureHeight);
  const preset =
    config.qualityPreset === 'custom' || QUALITY_PRESETS.some(item => item.id === config.qualityPreset)
      ? config.qualityPreset
      : 'custom';

  return {
    serverUrl: config.serverUrl.trim() || DEFAULTS.serverUrl,
    teacherName: config.teacherName.trim().slice(0, 32) || DEFAULTS.teacherName,
    classId: config.classId.trim().slice(0, 16),
    lastSourceId: config.lastSourceId ?? null,
    // 夾在合理範圍，避免有人手改 JSON 之後把教室網路灌爆
    maxBitrate: clampInt(config.maxBitrate, 500_000, 30_000_000),
    // 下限 1：「每秒 2 張截圖模式」要能設得進去
    maxFramerate: clampInt(config.maxFramerate, 1, 60),
    maxCaptureWidth: capture.width,
    maxCaptureHeight: capture.height,
    qualityPreset: preset,
    flipCamera: Boolean(config.flipCamera),
    hardwareCodec: config.hardwareCodec !== false, // 舊設定檔沒有欄位 → 預設啟用
    broadcastMode: config.broadcastMode === 'image' ? 'image' : config.broadcastMode === 'sfu' ? 'sfu' : 'video',
    // 定影幀品質：夾 0.6–0.97；舊設定檔沒有值 → 0.85
    imgSharpQuality: Math.min(0.97, Math.max(0.6, Number(config.imgSharpQuality) || 0.85)),
    serverUrlLocked: false,
    // SFU 設定：空字串 = 使用預設（與 signaling server 相同）
    sfuServerUrl: config.sfuServerUrl?.trim() || '',
    sfuAnnouncedIp: config.sfuAnnouncedIp ?? null,
    sfuRtpPortRange: config.sfuRtpPortRange ?? null,
    adaptiveQualityEnabled: Boolean(config.adaptiveQualityEnabled),
  };
}

/**
 * 擷取尺寸上限：0 = 不縮放（沿用來源原始尺寸）。
 *
 * 只要有一邊不合法（缺值、0、手改 JSON 改壞）就整組退回不縮放，
 * 這等於舊版行為，總比送一個畸形約束給擷取器安全。
 */
function sanitizeCaptureSize(width: number, height: number): { width: number; height: number } {
  const w = Math.round(Number(width) || 0);
  const h = Math.round(Number(height) || 0);
  if (w <= 0 || h <= 0) return { width: 0, height: 0 };
  return {
    width: Math.min(3840, Math.max(320, w)),
    height: Math.min(2160, Math.max(180, h)),
  };
}

/** 夾進範圍的整數；不是數字（輸入框留空、手改 JSON）一律退回下限，不送出 NaN。 */
function clampInt(value: number, min: number, max: number): number {
  const num = Math.round(Number(value));
  if (!Number.isFinite(num)) return min;
  return Math.min(max, Math.max(min, num));
}
