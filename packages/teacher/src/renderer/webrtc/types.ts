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
  /**
   * 遠端描述尚未設定前，先暫存 ICE candidate。
   * `addIceCandidate` 在 `setRemoteDescription` 之前會直接失敗。
   */
  pendingBroadcastIce: RTCIceCandidateInit[];
}

/** 供外部掛鉤的事件回呼 */
export interface TeacherSessionEvents {
  onStatus(status: SignalingStatus, detail?: string): void;
  onStudentsChanged(): void;
  onLog(level: 'info' | 'warn' | 'error', message: string): void;
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
  onWatchFrame?: (peerId: string, frame: { url: string; width: number; height: number; seq: number }) => void;
  // SFU 相關設定
  sfuServerUrl?: string;
  sfuAnnouncedIp?: string | null;
  sfuRtpPortRange?: { min: number; max: number } | null;
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
