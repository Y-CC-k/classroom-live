import type { PeerInfo, PeerKind, Role } from './types.js';

/**
 * 信令訊息（走 WebSocket，經由教室伺服器中轉）。
 *
 * 伺服器本身不理解 WebRTC，只負責房間成員管理與訊息轉發，
 * 這樣未來要把 broadcast 換成 mediasoup SFU 時，伺服器不需要改動信令格式。
 */

/** SDP 相關的最小結構（與 RTCSessionDescriptionInit 相容，但不需要 DOM lib） */
export interface SdpInit {
  type: 'offer' | 'answer' | 'pranswer' | 'rollback';
  sdp?: string;
}

/** ICE candidate 的最小結構（與 RTCIceCandidateInit 相容） */
export interface IceInit {
  candidate?: string;
  sdpMid?: string | null;
  sdpMLineIndex?: number | null;
  usernameFragment?: string | null;
}

/** SFU 專用：Transport 選項（序列化後給客戶端） */
export interface SfuTransportOptions {
  id: string;
  iceParameters: { usernameFragment: string; password: string };
  iceCandidates: Array<{
    foundation: string;
    priority: number;
    ip: string;
    port: number;
    protocol: 'udp' | 'tcp';
    type: 'host';
  }>;
  dtlsParameters: { role?: 'auto' | 'client' | 'server'; fingerprints: Array<{ algorithm: string; value: string }> };
  sctpParameters?: { port: number; OS: number; MIS: number; maxMessageSize: number };
}

/** SFU 專用：Producer/ Consumer 選項 */
export interface SfuProduceOptions {
  kind: 'video' | 'audio';
  rtpParameters: any; // mediasoup RtpParameters
  appData?: Record<string, unknown>;
}

export interface SfuConsumeOptions {
  producerId: string;
  rtpCapabilities: any; // mediasoup RtpCapabilities
  appData?: Record<string, unknown>;
}

export type SignalPayload =
  | { kind: PeerKind; description: SdpInit }
  | { kind: PeerKind; ice: IceInit }
  // SFU 專用信令
  | { kind: 'sfu'; type: 'create-transport'; direction: 'send' | 'recv'; transportOptions: SfuTransportOptions }
  | { kind: 'sfu'; type: 'connect-transport'; transportId: string; dtlsParameters: any }
  | { kind: 'sfu'; type: 'produce'; transportId: string; options: SfuProduceOptions }
  | { kind: 'sfu'; type: 'consume'; transportId: string; options: SfuConsumeOptions };

// ─────────────────────────── 客戶端 → 伺服器 ───────────────────────────

export type ClientMessage =
  /** 連線後第一則訊息，必須最先送出 */
  | {
      t: 'hello';
      role: Role;
      name: string;
      classId: string;
      protocolVersion: number;
      screen?: PeerInfo['screen'];
      agent?: PeerInfo['agent'];
      /**
       * 學生機的網卡 MAC（一鍵開機用）。
       * 刻意是**加欄位**而不是改版本：舊版伺服器會忽略它、
       * 新版伺服器遇到舊版學生機（沒有這個欄位）也照常運作，
       * 所以 `PROTOCOL_VERSION` 不需要跟著跳號。
       */
      mac?: PeerInfo['mac'];
      macs?: PeerInfo['macs'];
    }
  /** 轉發 WebRTC 信令給指定對象 */
  | { t: 'signal'; to: string; payload: SignalPayload }
  /** 教師專用：把指令廣播给同班所有學生（伺服器逐一轉發給學生） */
  | { t: 'broadcast'; payload: unknown }
  /** 僅更新自己的 metadata（例如解析度改變、提權後重啟） */
  | { t: 'meta'; screen?: PeerInfo['screen']; agent?: PeerInfo['agent'] }
  // SFU 專用訊息
  | { t: 'sfu-create-transport'; classId: string; direction: 'send' | 'recv' }
  | { t: 'sfu-connect-transport'; classId: string; transportId: string; dtlsParameters: any }
  | {
      t: 'sfu-produce';
      classId: string;
      transportId: string;
      kind: 'video' | 'audio';
      rtpParameters: any;
      appData?: Record<string, unknown>;
    }
  | {
      t: 'sfu-consume';
      classId: string;
      transportId: string;
      producerId: string;
      rtpCapabilities: any;
      appData?: Record<string, unknown>;
    }
  | { t: 'ping'; ts: number }
  | { t: 'bye' };

// ─────────────────────────── 伺服器 → 客戶端 ───────────────────────────

export type ServerMessage =
  | {
      t: 'welcome';
      /** 伺服器核發給你的 id */
      self: string;
      /** 同班既有的其他成員 */
      peers: PeerInfo[];
      serverTime: number;
    }
  | { t: 'peer-joined'; peer: PeerInfo }
  | { t: 'peer-left'; id: string; reason: string }
  | { t: 'peer-updated'; peer: PeerInfo }
  /** 來自他人的信令，`from` 為對方 id */
  | { t: 'signal'; from: string; payload: SignalPayload }
  /** 教師廣播的指令 */
  | { t: 'broadcast'; from: string; payload: unknown }
  // SFU 專用回應
  | { t: 'sfu-transport-created'; transportId: string; transportOptions: SfuTransportOptions }
  | { t: 'sfu-transport-connected'; transportId: string; dtlsParameters: any }
  | { t: 'sfu-produced'; transportId: string; producerId: string }
  | {
      t: 'sfu-consumed';
      transportId: string;
      consumerId: string;
      producerId: string;
      kind: 'video' | 'audio';
      rtpParameters: any;
      type: string;
      producerPaused: boolean;
    }
  | { t: 'sfu-producer-closed'; producerId: string }
  | { t: 'pong'; ts: number }
  | { t: 'error'; code: ServerErrorCode; message: string };

export type ServerErrorCode =
  | 'bad-message'
  | 'not-hello'
  | 'duplicate-hello'
  | 'role-forbidden'
  | 'unknown-peer'
  | 'room-full'
  | 'protocol-mismatch'
  // SFU 專用錯誤
  | 'sfu-unavailable'
  | 'sfu-transport-not-found'
  | 'sfu-producer-not-found'
  | 'sfu-cannot-consume'
  | 'internal';

/** 目前協定版本，雙方不一致時伺服器會拒絕連線 */
export const PROTOCOL_VERSION = 1;

/** 伺服器預設埠 */
export const DEFAULT_SERVER_PORT = 8787;

/** 單一班級學生人數上限（P2P mesh 建議 < 20，改用 SFU 後可調高） */
export const DEFAULT_MAX_STUDENTS_PER_ROOM = 60;
