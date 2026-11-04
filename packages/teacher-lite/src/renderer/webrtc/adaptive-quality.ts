/**
 * 自適應畫質（Adaptive Quality）
 *
 * 監控 WebRTC 編碼統計，根據網路狀況自動調整編碼參數：
 *   - 偵測到幀丟失、NACK 增加或編碼佇列塞車時，自動降低畫質
 *   - 網路狀況良好時，逐步恢復畫質
 *
 * 調整順序（從最溫和到最激進）：
 *   1. 降低幀率 (maxFramerate)
 *   2. 降低編碼碼率 (maxBitrate)
 *   3. 降低擷取解析度 (maxCaptureWidth/Height)
 */

interface RTCRtpSentReport {
  type: string;
  kind: string;
  framesEncoded: number;
  framesDropped: number;
  nackCount: number;
  bytesSent: number;
  roundTripTime: number;
  timestamp: number;
  ssrc: number;
}

/** 偵測到編碼壓力後的檢查間隔（ms） */
const CHECK_INTERVAL_MS = 5000;

/** 幀丟失率閾值（超過此值視為編碼壓力過大） */
const DROP_FRAME_THRESHOLD = 0.05;

/** NACK 數量閾值（超過此值視為網路擁塞） */
const NACK_THRESHOLD = 10;

/** 恢復畫質時的緩衝時間（ms），避免頻繁震盪 */
const RECOVERY_INTERVAL_MS = 30000;

/** 調整畫質後的冷卻時間（ms） */
const ADJUST_COOLDOWN_MS = 5000;

/** 畫質等級（0 = 預設/最高，越大代表畫質越低） */
export type AdaptiveQualityLevel = 0 | 1 | 2 | 3 | 4;

export interface AdaptiveQualityStats {
  framesEncoded: number;
  framesDropped: number;
  nackCount: number;
  bytesSent: number;
  roundTripTime: number;
  timestamp: number;
}

/** 自適應畫質管理器 */
export class AdaptiveQualityManager {
  private readonly links: Map<string, { sender: RTCRtpSender; lastStats?: AdaptiveQualityStats }>;
  private readonly onQualityChange: (
    maxBitrate: number,
    maxFramerate: number,
    maxCaptureWidth: number,
    maxCaptureHeight: number
  ) => void;
  private timer: ReturnType<typeof setInterval> | null = null;
  private _isEnabled = false;
  private lastAdjustmentTime = 0;
  private lastRecoveryTime = 0;
  /** 當前畫質等級（0 = 預設，越大越低） */
  private _qualityLevel: AdaptiveQualityLevel = 0;

  constructor(
    links: Map<string, { sender: RTCRtpSender }>,
    onQualityChange: (
      maxBitrate: number,
      maxFramerate: number,
      maxCaptureWidth: number,
      maxCaptureHeight: number
    ) => void
  ) {
    this.links = new Map();
    for (const [peerId, { sender }] of links) {
      this.links.set(peerId, { sender, lastStats: undefined });
    }
    this.onQualityChange = onQualityChange;
  }

  /** 啟動自適應監測 */
  enable(): void {
    if (this._isEnabled) return;
    this._isEnabled = true;
    this.timer = setInterval(() => void this.checkAndAdjust(), CHECK_INTERVAL_MS);
  }

  /** 停止自適應監測 */
  disable(): void {
    if (!this._isEnabled) return;
    this._isEnabled = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get isEnabled(): boolean {
    return this._isEnabled;
  }

  get qualityLevel(): AdaptiveQualityLevel {
    return this._qualityLevel;
  }

  /** 外部開關（供 UI 呼叫） */
  setEnabled(enabled: boolean): void {
    if (enabled) this.enable();
    else this.disable();
  }

  /** 重置為預設畫質等級 */
  reset(): void {
    this._qualityLevel = 0 as AdaptiveQualityLevel;
    this.lastAdjustmentTime = 0;
    this.lastRecoveryTime = 0;
  }

  /** 核心邏輯：檢查統計並決定是否調整畫質 */
  private async checkAndAdjust(): Promise<void> {
    if (!this._isEnabled) return;

    const now = Date.now();
    let totalDropRate = 0;
    let totalNack = 0;
    let linkCount = 0;

    for (const [, link] of this.links) {
      try {
        const stats = await link.sender.getStats();
        let senderStats: RTCRtpSentReport | null = null;
        for (const report of stats.values()) {
          if (report.type === 'outbound-rtp' && report.kind === 'video') {
            senderStats = report;
            break;
          }
        }

        if (!senderStats) continue;

        const prevStats = link.lastStats;
        link.lastStats = {
          framesEncoded: senderStats.framesEncoded,
          framesDropped: senderStats.framesDropped,
          nackCount: senderStats.nackCount,
          bytesSent: senderStats.bytesSent,
          roundTripTime: senderStats.roundTripTime,
          timestamp: now,
        };

        // 計算這段時間的幀丟失率與 NACK
        if (prevStats) {
          const framesEncodedDelta = senderStats.framesEncoded - prevStats.framesEncoded;
          const framesDroppedDelta = senderStats.framesDropped - prevStats.framesDropped;
          const nackDelta = senderStats.nackCount - prevStats.nackCount;

          if (framesEncodedDelta > 0) {
            totalDropRate += framesDroppedDelta / framesEncodedDelta;
          }
          totalNack += nackDelta;
          linkCount++;
        }
      } catch {
        // 單個鏈結錯誤不影響整體
      }
    }

    if (linkCount === 0) return;

    const avgDropRate = totalDropRate / linkCount;
    const avgNack = totalNack / linkCount;

    const needsReduction = avgDropRate > DROP_FRAME_THRESHOLD || avgNack > NACK_THRESHOLD;

    if (needsReduction) {
      await this.reduceQuality();
    } else {
      await this.recoverQuality();
    }
  }

  /** 降低畫質等級（最溫和到最激進） */
  private async reduceQuality(): Promise<void> {
    const now = Date.now();
    if (now - this.lastAdjustmentTime < ADJUST_COOLDOWN_MS) return;

    if (this._qualityLevel < 4) {
      this._qualityLevel = (this._qualityLevel + 1) as AdaptiveQualityLevel;
      this.lastAdjustmentTime = now;

      // 通知外部調整：根據等級決定參數
      switch (this._qualityLevel) {
        case 1:
          // 第 1 級：降低幀率
          this.onQualityChange(0, 5, 0, 0); // maxBitrate=0 表示不改，只改 fps
          break;
        case 2:
          // 第 2 級：降低碼率
          this.onQualityChange(0, 0, 0, 0); // 由外部根據當前值計算
          break;
        case 3:
          // 第 3 級：降低解析度到 720p
          this.onQualityChange(0, 0, 1280, 720);
          break;
        case 4:
          // 第 4 級：降低解析度到 480p
          this.onQualityChange(0, 0, 854, 480);
          break;
      }
    }
  }

  /** 恢復畫質等級 */
  private async recoverQuality(): Promise<void> {
    const now = Date.now();
    if (now - this.lastRecoveryTime < RECOVERY_INTERVAL_MS) return;
    if (this._qualityLevel > 0) {
      this._qualityLevel = (this._qualityLevel - 1) as AdaptiveQualityLevel;
      this.lastRecoveryTime = now;

      switch (this._qualityLevel) {
        case 0:
          this.onQualityChange(0, 0, 0, 0); // 完全恢復，由外部根據原始設定
          break;
        case 1:
          this.onQualityChange(0, 8, 0, 0);
          break;
        case 2:
          this.onQualityChange(0, 6, 0, 0);
          break;
        case 3:
          this.onQualityChange(0, 0, 1280, 720);
          break;
      }
    }
  }
}

export default AdaptiveQualityManager;
