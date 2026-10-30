/**
 * 共用基礎型別。
 * 這個檔案同時被 Node（伺服器）與瀏覽器（Electron renderer）匯入，
 * 因此不得引用任何 DOM 或 Node 專屬的全域物件。
 */

/** 連線角色 */
export type Role = 'teacher' | 'student';

/**
 * 一對「教師機 ↔ 學生機」之間會有兩條獨立的 RTCPeerConnection：
 *
 * - `broadcast`：教師 → 學生。教師是 offerer，承載教師螢幕畫面 + `ctl` 資料通道。
 *                生命週期與課程相同，永不重新協商。
 * - `monitor`  ：學生 → 教師。學生是 offerer，承載學生螢幕畫面（教師要接管時才建立）。
 *
 * 拆成兩條連線是刻意的設計：每一條只有單一方向、單一 offerer，
 * 因此完全不需要 perfect-negotiation，大幅降低競態問題。
 */
export type PeerKind = 'broadcast' | 'monitor';

/**
 * 學生機的狀態機。
 * - `monitor`：學生可正常操作，教師只接收畫面（不接管）。
 * - `lock`   ：畫面遮蔽 + 本機鍵鼠被鉤子攔截，學生無法操作。
 * - `control`：本機鍵鼠被攔截，改由教師遠端注入操作。
 */
export type ControlMode = 'monitor' | 'lock' | 'control';

export type MouseButton = 'left' | 'right' | 'middle';

/** 螢幕資訊。`width`/`height` 一律指「主要螢幕」，也就是教師端實際看到的那一顆。 */
export interface ScreenMeta {
  /** 主要螢幕寬度，單位為實體像素 */
  width: number;
  /** 主要螢幕高度 */
  height: number;
  /** 主要螢幕原點，Windows 上固定為 (0,0) */
  x: number;
  y: number;
  scaleFactor: number;
  /** 這台機器接了幾個螢幕（多螢幕時教師只能看到主要螢幕） */
  monitors: number;
}

/** 學生機 agent 的執行環境資訊 */
export interface AgentMeta {
  version: string;
  /** 版本戳（打包時間）；舊版學生機不會帶（升級判別用） */
  build?: string;
  /** 是否以系統管理員權限執行。false 時無法注入到提高權限的視窗 */
  elevated: boolean;
  /** 原生鍵鼠模組是否載入成功 */
  nativeReady: boolean;
  os: string;
}

/** 伺服器與客戶端共同認知的一位參與者 */
export interface PeerInfo {
  id: string;
  role: Role;
  name: string;
  /** 學生機於 hello 時回報 */
  screen?: ScreenMeta;
  agent?: AgentMeta;
  /** 教師端判斷用的連線時間 */
  joinedAt: number;
  /**
   * 這台機器的主網卡 MAC（hello 時由學生機回報、伺服器驗證後轉發）。
   * 一鍵開機（Wake-on-LAN）的喚醒封包就是發給它，見 `wol.ts`。
   * 舊版學生機不會帶這個欄位 → 教師端拿不到就無法喚醒那台，不影響其他功能。
   */
  mac?: string;
  /** 同一台機器的其他網卡 MAC（多網卡時全部都能喚醒，上限 4 個） */
  macs?: string[];
  /** 這條連線的來源 IP（由**伺服器**從 socket 位址填入，不可由客戶端自報） */
  ip?: string;
}
