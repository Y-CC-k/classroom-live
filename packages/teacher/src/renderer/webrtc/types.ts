import type { PeerInfo, BroadcastMode } from '@classroom/protocol';
import type { SignalingStatus } from '@classroom/protocol/client';
import type { CtlMessage, DcMessage, FileChannelMessage, ScreenMeta } from '@classroom/protocol';

// Re-export commonly used protocol types
export type { CtlMessage, DcMessage, FileChannelMessage, ScreenMeta, SignalingStatus };

/** 教室在區網內，不需要 STUN/TURN。跨網段或走 VPN 時才需要補上。 */
export const RTC_CONFIG: RTCConfiguration = {
  iceServers: [],
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

/** 單一學生的狀態 */
export interface StudentState {
  info: PeerInfo;
  broadcastState: RTCPeerConnectionState | 'idle';
  /** 學生回報的最後一筆錯誤 */
  lastError: string | null;
  lastSeenAt: number;
}

/** 每個學生一條連線的完整狀態 */
export interface Link {
  state: StudentState;
  broadcast: RTCPeerConnection | null;
  ctl: RTCDataChannel | null;
  evt: RTCDataChannel | null;
  /** 檔案傳送專用通道（內容分片走二進位，控制訊息走 JSON） */
  file: RTCDataChannel | null;
  /** 圖片廣播通道（image 模式才會有資料流；通道一律先開好） */
  img: RTCDataChannel | null;
  /** 學生 → 教師即時畫面（遠端接管時使用，學生是 offerer） */
  monitor: RTCPeerConnection | null;
  /**
   * 遠端描述尚未設定前，先暫存 ICE candidate。
   * `addIceCandidate` 在 `setRemoteDescription` 之前會直接失敗。
   */
  pendingBroadcastIce: RTCIceCandidateInit[];
  /** 監看連線（monitor）尚未設定遠端描述前的 ICE 候選暫存 */
  pendingMonitorIce: RTCIceCandidateInit[];
}

/** 供外部掛鉤的事件回呼 */
export interface TeacherSessionEvents {
  onStatus(status: SignalingStatus, detail?: string): void;
  onStudentsChanged(): void;
  onLog(level: 'info' | 'warn' | 'error' | 'hand', message: string): void;
}

/** 建構 TeacherSession 時需傳入的選項 */
export interface TeacherSessionOptions extends TeacherSessionEvents {
  serverUrl: string;
  teacherName: string;
  classId: string;
  maxBitrate: number;
  maxFramerate: number;
  /** 優先 H.264（硬體編碼）：學生機多時教師機 CPU 的關鍵開關 */
  hardwareCodec: boolean;
  /** 教師機自身版本：學生機連線時比較，不一致的記錄用警告色提示送升級包 */
  appVersion?: string;
  /** 自適應畫質：根據網路狀況自動調整編碼參數 */
  adaptiveQualityEnabled: boolean;
  /** 廣播模式：video = 視訊；image = JPEG 逐張（多台教室用）；sfu = Selective Forwarding Unit */
  broadcastMode: BroadcastMode;
  /** 圖片廣播「定影幀」JPEG 品質（0.6–0.97，預設 0.85） */
  imgSharpQuality: number;
  /** 圖片廣播的頻寬統計（泵每 10 秒回報一次） */
  onImageStats?: (stats: ImagePumpStats) => void;
  /**
   * 單台螢幕監看：組完一幀回報（URL 需顯示後 revokeObjectURL）；
   * peerId 不再被監看就不用理它。
   */
  onWatchFrame?: (
    peerId: string,
    frame: { url: string; width: number; height: number; seq: number; blob: Blob }
  ) => void;
  /**
   * 遠端接管時學生端即時畫面軌回傳（WebRTC monitor 軌）；
   * peerId 對應的學生機，stream 為收到的視訊 MediaStream。
   */
  onMonitorFrame?: (peerId: string, stream: MediaStream) => void;
  // SFU 相關設定
  sfuServerUrl?: string;
  sfuAnnouncedIp?: string | null;
  sfuRtpPortRange?: { min: number; max: number } | null;
  /** WebRTC ICE 伺服器（STUN/TURN），未設定則使用模組內建預設 */
  iceServers?: RTCIceServer[];
  /**
   * 遠端接管即時畫面（monitor 軌）的幀率上限（fps）。
   * 避免學生機螢幕擷取佔用過高 CPU；建議 5～10，預設 10。
   */
  monitorMaxFramerate: number;
  /**
   * 遠端接管即時畫面（monitor 軌）的擷取寬度上限（px）。
   * 0 = 不縮放，沿用學生機原始解析度。
   */
  monitorMaxWidth: number;
  /**
   * 遠端接管即時畫面（monitor 軌）的擷取高度上限（px）。
   * 0 = 不縮放，沿用學生機原始解析度。
   */
  monitorMaxHeight: number;
  /**
   * 遠端接管即時畫面是否走 SFU（true = 經伺服器轉發，false = P2P 直接連線）。
   */
  monitorUseSfu: boolean;
}

/** 監看幀的組裝狀態 */
export interface WatchFrameAssembly {
  seq: number;
  width: number;
  height: number;
  expectedSize: number;
  received: number;
  chunks: ArrayBuffer[];
}

/** 圖片廣播抽幀泵的統計資料（從 image-pump 傳回） */
export interface ImagePumpStats {
  framesPerSec: number;
  kbPerSec: number;
  frames: number;
}
