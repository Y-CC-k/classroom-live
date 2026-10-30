/**
 * 主行程 ↔ renderer 之間的 IPC 契約。
 * preload 與 renderer 都匯入這個檔案，避免兩邊字串寫錯卻不報錯。
 */

import type { BroadcastMode } from '@classroom/protocol';
import type { PeerInfo } from '@classroom/protocol';

export const IPC = {
  listSources: 'teacher:list-sources',
  getConfig: 'teacher:get-config',
  saveConfig: 'teacher:save-config',
  appInfo: 'teacher:app-info',
  /** 取得喚醒名單（上課期間由學生 hello 自動填入，持久化到 userData） */
  getWakeRoster: 'teacher:get-wake-roster',
  /** 教師端重新從目前在線的學生收集 MAC，並存進名單（手動刷新用） */
  reportWakePeers: 'teacher:report-wake-peers',
  /** 發送 Wake-on-LAN magic packet 給指定目標（或全部名單） */
  wake: 'teacher:wake',
} as const;

export interface CaptureSource {
  id: string;
  name: string;
  /**
   * 'screen' = 整個螢幕（唯一能精準對應遠端鍵鼠座標的來源）
   * 'window' = 單一視窗（可用來只播 PPT，但遠端鍵鼠座標對不上）
   * 'camera' = 攝影機／實物投影機（由 renderer 端列舉，僅供廣播）
   */
  kind: 'screen' | 'window' | 'camera';
  /** data:image/png;base64,... 用於來源選擇器的預覽 */
  thumbnail: string;
  appIcon: string | null;
  displayId: string | null;
}

/**
 * 畫質預設。
 *
 * 背景（秒差問題）：WebRTC 是「邊編邊送」，編碼器一旦來不及
 * （幀率太高、像素太多、頻寬上限又太低），還沒送出去的訊框會在
 * 教師機排隊，**秒差會越上課越大**。所以畫質必須整組一起調，
 * 不能只調其中一個欄位——這就是為什麼要有預設而不是三個獨立數字。
 *
 * `custom` 不在 `QUALITY_PRESETS` 裡：老師手動改過任何一個數字就會變成它。
 */
export type QualityPreset = 'slideshow' | 'lecture' | 'standard' | 'smooth' | 'native' | 'custom';

export interface QualityProfile {
  /** 擷取與編碼的幀率上限（fps） */
  maxFramerate: number;
  /** 編碼頻寬上限（bps） */
  maxBitrate: number;
  /** 擷取尺寸上限（px）；0 = 不縮放，沿用來源原始尺寸 */
  maxCaptureWidth: number;
  maxCaptureHeight: number;
}

export interface QualityPresetDef extends QualityProfile {
  id: QualityPreset;
  label: string;
  /** 顯示在畫質選單下方，說明這組設定的代價 */
  hint: string;
}

/**
 * 程式內建預設畫質（= 「一般」那組）。
 *
 * 先宣告再放進 `QUALITY_PRESETS`：store 的 DEFAULTS 要直接引用它，
 * 否則從陣列找出來會是 `T | undefined`，得為「不可能發生」的 null 到處補判斷。
 */
export const STANDARD_QUALITY: QualityPresetDef = {
  id: 'standard',
  label: '一般（10 fps · 1080p）',
  maxFramerate: 10,
  maxBitrate: 8_000_000,
  maxCaptureWidth: 1920,
  maxCaptureHeight: 1080,
  hint: '程式示範用：滑鼠移動較連貫，負載與秒差的平衡點。',
};

export const QUALITY_PRESETS: QualityPresetDef[] = [
  {
    id: 'slideshow',
    label: '每秒 2 張（截圖模式）',
    maxFramerate: 2,
    maxBitrate: 1_500_000,
    maxCaptureWidth: 1280,
    maxCaptureHeight: 720,
    hint: '負載最低、秒差最小：畫面像投影片，適合靜態簡報；滑鼠與捲動會有明顯階梯感。',
  },
  {
    id: 'lecture',
    label: '講課簡報（5 fps · 1080p）',
    maxFramerate: 5,
    maxBitrate: 4_000_000,
    maxCaptureWidth: 1920,
    maxCaptureHeight: 1080,
    hint: '文字與簡報用：編碼負載低，秒差最穩定，字依然清楚。',
  },
  STANDARD_QUALITY,
  {
    id: 'smooth',
    label: '流暢（15 fps · 1080p）',
    maxFramerate: 15,
    maxBitrate: 12_000_000,
    maxCaptureWidth: 1920,
    maxCaptureHeight: 1080,
    hint: '影片或動態示範用：較流暢，但編碼負載與網路頻寬都最高，人多時要留意教師機 CPU。',
  },
  {
    id: 'native',
    label: '原始（30 fps · 不縮放）',
    maxFramerate: 30,
    maxBitrate: 6_000_000,
    maxCaptureWidth: 0,
    maxCaptureHeight: 0,
    hint: '舊版行為：解析度與幀率不設限、頻寬卻只有 6 Mbps，編碼器容易塞車，秒差會越上課越大。',
  },
];

export function qualityPresetDef(id: string | null | undefined): QualityPresetDef | null {
  return QUALITY_PRESETS.find(preset => preset.id === id) ?? null;
}

/** 對照目前數字屬於哪一組預設；對不上回傳 null（UI 顯示成「自訂」）。 */
export function matchQualityPreset(profile: QualityProfile): QualityPresetDef | null {
  return (
    QUALITY_PRESETS.find(
      preset =>
        preset.maxFramerate === profile.maxFramerate &&
        preset.maxBitrate === profile.maxBitrate &&
        preset.maxCaptureWidth === profile.maxCaptureWidth &&
        preset.maxCaptureHeight === profile.maxCaptureHeight
    ) ?? null
  );
}

export interface TeacherConfig {
  serverUrl: string;
  teacherName: string;
  classId: string;
  /** 上次選用的擷取來源 id，重新開啟時自動沿用 */
  lastSourceId: string | null;
  /** 廣播畫質上限（bps） */
  maxBitrate: number;
  maxFramerate: number;
  /** 擷取尺寸上限（px）；0 = 不縮放，沿用來源原始尺寸 */
  maxCaptureWidth: number;
  maxCaptureHeight: number;
  /** 畫質預設；只用來讓 UI 下拉選單顯示正確狀態，數字才是真的會套用的值 */
  qualityPreset: QualityPreset;
  /** 攝影機鏡像修正：開啟時將左右翻轉後再廣播/預覽 */
  flipCamera: boolean;
  /**
   * 優先 H.264 編碼（硬體編碼為前提）：學生機多時教師機 CPU 是關鍵，
   * GPU 編碼＋GPU 解碼比預設的 VP8/VP9 軟體路徑省非常多。重連/重新開始廣播後生效。
   */
  hardwareCodec: boolean;
  /**
   * 廣播模式。video = 視訊（預設）；image = JPEG 逐張（無編碼佇列，
   * 20–30 台的教室不會因為教師機編碼塞車而越來越延遲）。
   * sfu = Selective Forwarding Unit（mediasoup，大型教室用，教師只編 1 路）。
   * 重新連線後生效。
   */
  broadcastMode: BroadcastMode;
  /**
   * SFU 伺服器位址（預設與 signaling server 相同）。
   * 格式：ws://host:port 或 wss://host:port。
   */
  sfuServerUrl: string;
  /**
   * SFU 對外宣告 IP（用於 NAT 穿透）。
   * 未指定時由 SFU 自動偵測。
   */
  sfuAnnouncedIp: string | null;
  /**
   * SFU RTP 端口範圍（預設 40000-40100）。
   */
  sfuRtpPortRange: { min: number; max: number } | null;
  /**
   * 圖片廣播「定影幀」的 JPEG 品質（0.6–0.97，預設 0.85）。
   * 停留下來看的那一張用這個品質；越高越清楚、單張也越大。
   * 動態幀（捲動中）另有自己的品質，不受此影響。
   */
  imgSharpQuality: number;
  /**
   * 自適應畫質：開啟後，教師端會根據網路狀況（幀丟失率、NACK）自動調整編碼參數，
   * 手動調整畫質時會暫時停用。重連後生效。
   */
  adaptiveQualityEnabled: boolean;
  /**
   * 部署設定（安裝目錄 config.json）把 serverUrl 鎖住了：UI 必須唯讀。
   * 這個欄位只會出現在 IPC 傳回值，不會寫進本機設定檔。
   */
  serverUrlLocked: boolean;
}

/** 一鍵開機名單裡的一筆記錄 */
export interface WakeTarget {
  /** 主鍵：主網卡 MAC（正規化為 aa:bb:cc:dd:ee:ff） */
  mac: string;
  /** 同機器的全部 MAC 備援 */
  macs: string[];
  /** 最後一次從學生 hello 取得的 IP（僅供參考，不用於喚醒） */
  ip?: string;
  /** 學生機名稱（固定是本機 IP） */
  name: string;
  /** 班級代碼 */
  classId?: string;
  /** 最後一次看到的時間（ms） */
  lastSeenAt: number;
}

/** 喚醒結果：每個送出目標的狀況 */
export interface WakeSendResult {
  mac: string;
  /** 實際發送的位址清單（子網廣播 + 255.255.255.255 + roster IP 單播） */
  sentTo: string[];
  /** 發送成功的 UDP 次數（理論上 >= 1） */
  count: number;
  /** 錯誤訊息（有的話代表部分失敗） */
  error?: string;
}

export interface AppInfo {
  version: string;
  platform: string;
  electron: string;
  chrome: string;
  userDataPath: string;
}

export interface TeacherApi {
  listSources(): Promise<CaptureSource[]>;
  getConfig(): Promise<TeacherConfig>;
  saveConfig(patch: Partial<TeacherConfig>): Promise<TeacherConfig>;
  appInfo(): Promise<AppInfo>;
  /** 取得一鍵開機名單 */
  getWakeRoster(): Promise<WakeTarget[]>;
  /**
   * 從目前在線的學生（session）收集 MAC，合併進名單並存檔。
   * 上課期間學生只要連過一次，MAC 就會被自動補上。
   */
  reportWakePeers(peers: PeerInfo[]): Promise<WakeTarget[]>;
  /** 發送 Wake-on-LAN magic packet */
  wake(targets?: string[]): Promise<WakeSendResult[]>;
}

declare global {
  interface Window {
    teacherApi: TeacherApi;
  }
}
