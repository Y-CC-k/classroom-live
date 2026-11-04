import {
  DC_CTL,
  DC_EVT,
  DC_FILE,
  DC_IMG,
  FILE_CHUNK_SIZE,
  PROTOCOL_VERSION,
  type BroadcastMode,
  type CtlMessage,
  type DcMessage,
  type FileChannelMessage,
  type PeerInfo,
  type ServerMessage,
  type SignalPayload,
  type ScreenMeta,
} from '@classroom/protocol';
import { SignalingClient, type SignalingStatus } from '@classroom/protocol/client';

import { ImagePump, type ImagePumpStats } from './image-pump.js';

/**
 * 教師端的會話核心。
 *
 * 每個學生使用一條獨立的 RTCPeerConnection：
 *
 *   pcBroadcast  教師 → 學生   教師是 offerer。承載廣播畫面 + ctl/evt 資料通道。
 *                              生命週期整個課程，永不重新協商。
 *
 * 只有單一 offerer，所以完全不需要 perfect-negotiation。
 *
 * 廣播模式（broadcastMode）：
 *   - video：視訊軌（即時滑鼠，但每台一份編碼，台數多時教師機會塞車）
 *   - image：JPEG 逐張（img 通道，無編碼佇列、延遲恆定）
 *            這個模式**不建視訊收發器**：30 台只有一個畫面來源成本
 *            抽幀 + 3xx KB 一張的 JPEG 分發，教師機 CPU 幾乎無感。
 */

/** 教室在區網內，不需要 STUN/TURN。跨網段或走 VPN 時才需要補上。 */
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [],
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require',
};

export interface StudentState {
  info: PeerInfo;
  broadcastState: RTCPeerConnectionState | 'idle';
  /** 學生回報的最後一筆錯誤 */
  lastError: string | null;
  lastSeenAt: number;
}

interface Link {
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

export interface TeacherSessionEvents {
  onStatus(status: SignalingStatus, detail?: string): void;
  onStudentsChanged(): void;
  onLog(level: 'info' | 'warn' | 'error', message: string): void;
}

export interface TeacherSessionOptions extends TeacherSessionEvents {
  serverUrl: string;
  teacherName: string;
  classId: string;
  maxBitrate: number;
  maxFramerate: number;
  /** 優先 H.264（硬體編碼）：學生機多時教師機 CPU 的關鍵開關 */
  hardwareCodec: boolean;
  /** 廣播模式：video = 視訊；image = JPEG 逐張（多台教室用） */
  broadcastMode: BroadcastMode;
  /** 圖片廣播「定影幀」JPEG 品質（0.6–0.97，預設 0.85） */
  imgSharpQuality: number;
  /** 圖片廣播的頻寬統計（泵每 10 秒回報一次；排課時判斷「網路還是編碼」卡哪邊用） */
  onImageStats?: (stats: ImagePumpStats) => void;
  /**
   * 單台螢幕監看：組完一幀回報（URL 需顯示後 revokeObjectURL）；
   * peerId 不再被監看就不用理它。
   */
  onWatchFrame?: (peerId: string, frame: { url: string; width: number; height: number; seq: number }) => void;
}

export class TeacherSession {
  private readonly options: TeacherSessionOptions;
  private client: SignalingClient | null = null;
  private readonly links = new Map<string, Link>();
  /** 學生端回報拒收的檔案序號：deliverFiles 在送下一片前先查，直接中止 */
  private readonly fileRejected = new Map<string, Set<string>>();
  /** 熱更新：各台正在等待寫入完成的升級包檔名；file-result 成功後自動送 apply-update */
  private readonly upgradePackageNames = new Map<string, string>();
  private selfId: string | null = null;
  private localStream: MediaStream | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** 「鎖定全班」的意圖：ctl 通道打開時會補送給（新加入／重連的）學生 */
  private lockOn = false;
  /** 「靜音全班」的意圖：跟鎖定同一套語義（重連的學生會收到補送） */
  private muteOn = false;
  /**
   * 單台／部分直播（image 模式）：null = 全班（預設）；
   * 有值時抽幀泵只把 JPEG 送名單內的台，其餘學生維持清屏。
   */
  private broadcastTargets: Set<string> | null = null;
  /** 圖片廣播抽幀泵（image 模式才有作用） */
  private readonly pump: ImagePump;

  // ── 螢幕監看的幀組裝狀態（one per watched peer） ──
  private readonly watchFrames = new Map<
    string,
    { seq: number; width: number; height: number; expectedSize: number; received: number; chunks: ArrayBuffer[] }
  >();

  /** 監看幀的大小上限（防呆：超過 8MB 的「一幀」當然不是真的幀） */
  private static readonly WATCH_MAX_FRAME_BYTES = 8 * 1024 * 1024;

  constructor(options: TeacherSessionOptions) {
    this.options = options;
    this.pump = new ImagePump(
      () =>
        [...this.links.values()]
          .filter(link => this.isBroadcastTarget(link.state.info.id))
          .map(link => link.img)
          .filter((c): c is RTCDataChannel => Boolean(c)),
      line => this.options.onLog('info', line),
      stats => this.options.onImageStats?.(stats)
    );
    this.pump.setSharpQuality(options.imgSharpQuality ?? 0.85);
  }

  get isConnected(): boolean {
    return this.selfId !== null;
  }

  get localMeta(): ScreenMeta | null {
    const track = this.localStream?.getVideoTracks()[0];
    if (!track) return null;
    const settings = track.getSettings();
    return {
      width: settings.width ?? 0,
      height: settings.height ?? 0,
      x: 0,
      y: 0,
      scaleFactor: 1,
      monitors: 1,
    };
  }

  students(): StudentState[] {
    return [...this.links.values()].map(link => link.state);
  }

  // ─────────────────────────── 連線生命週期 ───────────────────────────

  connect(): void {
    if (this.client) this.client.close();

    this.client = new SignalingClient({
      url: this.options.serverUrl,
      hello: {
        t: 'hello',
        role: 'teacher',
        name: this.options.teacherName,
        classId: this.options.classId,
        protocolVersion: PROTOCOL_VERSION,
        ...(this.localMeta ? { screen: this.localMeta } : {}),
      },
      onMessage: message => this.handleServerMessage(message),
      onStatus: (status, detail) => {
        this.options.onStatus(status, detail);
        if (status !== 'connected') this.selfId = null;
      },
    });
    this.client.connect();
    this.startHeartbeat();
  }

  disconnect(): void {
    this.stopHeartbeat();
    // 主動告知伺服器再關閉，讓學生端立刻看到「教師離線」而不是等心跳逾時。
    this.client?.send({ t: 'bye' });
    this.client?.close();
    this.client = null;
    this.clearLock();
    this.muteOn = false;
    this.broadcastTargets = null;
    this.watchFrames.clear();
    for (const peerId of [...this.links.keys()]) this.teardownLink(peerId);
    this.links.clear();
    this.selfId = null;
    this.options.onStudentsChanged();
  }

  // ─────────────────────────── 螢幕來源 ───────────────────────────

  /**
   * 切換／啟動／停止廣播來源。
   *
   * 關鍵：對已建立的連線使用 `replaceTrack` 而不是重新協商。
   * 老師在課堂中途切換「整個螢幕 ↔ 某個簡報視窗」時，
   * 學生端完全不中斷，畫面在幾十毫秒內就切過去了。
   */
  async setLocalStream(stream: MediaStream | null): Promise<void> {
    const previous = this.localStream;
    this.localStream = stream;

    // 圖片模式：完全不碰視訊收發器（也不會有任何編碼成本），
    // 改由抽幀泵把 JPEG 逐張送到各台的 img 通道。
    if (this.options.broadcastMode === 'image') {
      if (stream) {
        this.pump.start(stream);
      } else {
        this.pump.stop();
      }
      for (const peerId of this.links.keys()) {
        // 廣播開始只通知名單內的台；停止則全班都要收到「off」清屏
        const on = Boolean(stream) && this.isBroadcastTarget(peerId);
        this.sendCtl(peerId, { t: 'broadcast', on, mode: 'image' });
      }
      if (this.broadcastTargets && stream) {
        this.options.onLog(
          'info',
          `直播中：只送 ${this.broadcastTargets.size} 台（${this.namesOf([...this.broadcastTargets])}）；其餘台待機。`
        );
      } else if (stream) {
        this.options.onLog('info', '全班廣播中（圖片逐張）。');
      }
      if (previous && previous !== stream) {
        for (const track of previous.getTracks()) track.stop();
      }
      if (this.client) {
        this.client.send({ t: 'meta', ...(this.localMeta ? { screen: this.localMeta } : {}) });
      }
      return;
    }

    const nextTrack = stream?.getVideoTracks()[0] ?? null;

    for (const [peerId, link] of this.links) {
      if (link.broadcast) {
        const sender = this.findVideoSender(link.broadcast);
        if (sender) {
          try {
            await sender.replaceTrack(nextTrack);
          } catch (error) {
            this.options.onLog('warn', `對 ${link.state.info.name} 切換畫面失敗：${describe(error)}`);
          }
        } else if (nextTrack) {
          // 連線存在卻沒有任何視訊收發器（理論上不該發生）：整條重建最保險。
          this.options.onLog('warn', `${link.state.info.name} 的廣播連線缺少視訊通道，正在重建`);
          this.restartBroadcast(peerId, link);
        }
      } else if (nextTrack) {
        // 之前沒有來源所以還沒連線，現在補上
        await this.ensureBroadcastLink(peerId);
      }

      // 明確告知學生「開始／停止廣播」：停止時學生端要清屏，
      // 不能讓他盯著最後一格畫面以為老師還在播。
      this.sendCtl(peerId, { t: 'broadcast', on: Boolean(nextTrack), mode: 'video' });
    }

    if (previous && previous !== stream) {
      for (const track of previous.getTracks()) track.stop();
    }

    if (this.client) {
      this.client.send({ t: 'meta', ...(this.localMeta ? { screen: this.localMeta } : {}) });
    }
  }

  // ─────────────────────────── 對學生的操作 ───────────────────────────

  /**
   * 把所有學生機縮到系統匣（停止廣播後收攏教室用：
   * 學生機視窗隱藏、行程留在背景，教師重新廣播會自動把它拉回全螢幕）。
   */
  minimizeAll(): void {
    for (const peerId of this.links.keys()) {
      this.sendCtl(peerId, { t: 'minimize', on: true });
    }
  }

  /**
   * 要求所有已連線學生機以系統預設瀏覽器開啟網址。
   * 回傳實際送達（控制通道已開）的學生機數量。
   */
  openUrlAll(url: string): number {
    let sent = 0;
    for (const peerId of this.links.keys()) {
      if (this.links.get(peerId)?.ctl?.readyState === 'open') sent++;
      this.sendCtl(peerId, { t: 'open-url', url });
    }
    return sent;
  }

  /**
   * 鎖定／解除全班學生機鍵盤滑鼠（課堂秩序）。
   * 意圖記在 `lockOn`：新加入或重連的學生在 ctl 通道打開時自動補送狀態，
   * 不會有「老師忘了對剛上線的那台鎖定」的漏洞。
   */
  lockAll(on: boolean): number {
    this.lockOn = on;
    let sent = 0;
    for (const peerId of this.links.keys()) {
      if (this.links.get(peerId)?.ctl?.readyState === 'open') sent++;
      this.sendCtl(peerId, { t: 'lock', on });
    }
    return sent;
  }

  /** 目前鎖定意圖（供卡片顯示「已鎖定」狀態） */
  get lockActive(): boolean {
    return this.lockOn;
  }

  // ─────────────────────── 對「單一台」學生機的動作 ───────────────────────
  // 實作上跟全班版同訊息、只指定 peerId；回傳「訊息是否真的送出去了」。

  /** 對單一台鎖定／解除鍵盤滑鼠 */
  lockStudent(peerId: string, on: boolean): boolean {
    const link = this.links.get(peerId);
    if (link?.ctl?.readyState !== 'open') return false;
    this.sendCtl(peerId, { t: 'lock', on });
    return true;
  }

  // ─────────────── 教師端獨立管理：靜音／關閉學生網頁 ───────────────
  // 這兩件事跟廣播開關脫鉤：強制模式只負責置頂全螢幕，
  // 靜音與關網頁由右欄按鍵下達、教師自己決定什麼時候用。

  /** 目前「靜音全班」的意圖（供按鈕顯示狀態） */
  get muteActive(): boolean {
    return this.muteOn;
  }

  /** 靜音全班／解除：記意圖＋送指令（重連的學生會被補送） */
  muteAll(on: boolean): number {
    this.muteOn = on;
    let sent = 0;
    for (const peerId of this.links.keys()) {
      if (this.links.get(peerId)?.ctl?.readyState === 'open') sent++;
      this.sendCtl(peerId, { t: 'mute', on });
    }
    return sent;
  }

  /** 對單一台靜音／解除 */
  muteStudent(peerId: string, on: boolean): boolean {
    const link = this.links.get(peerId);
    if (link?.ctl?.readyState !== 'open') return false;
    this.sendCtl(peerId, { t: 'mute', on });
    return true;
  }

  /** 關閉學生 Chrome／Edge（一次性動作，不記意圖） */
  closeBrowsersAll(): number {
    let sent = 0;
    for (const peerId of this.links.keys()) {
      if (this.links.get(peerId)?.ctl?.readyState === 'open') sent++;
      this.sendCtl(peerId, { t: 'close-browsers' });
    }
    return sent;
  }

  // ─────────────── 螢幕監看（單台 3 秒一張 JPEG） ───────────────
  // 教師按「👁 監看」時送 watch 指令；學生把螢幕壓成 JPEG 走 evt
  // 通道回傳（hdr → 分片 → end），這裡組成 Blob 後回報給 UI 顯示。

  /**
   * 對單一台開始／停止監看。
   * 一開始要跟上一台換台也在這裡做（先停舊台，避免兩台同時送圖）。
   */
  watchStudent(peerId: string, on: boolean, intervalMs = 3000): boolean {
    const link = this.links.get(peerId);
    if (on) {
      if (link?.ctl?.readyState !== 'open') return false;
      if (!Number.isFinite(intervalMs) || intervalMs < 1000) intervalMs = 1000;
      this.sendCtl(peerId, { t: 'watch', on: true, intervalMs: Math.round(intervalMs) });
      return true;
    }
    if (link?.ctl?.readyState === 'open') {
      this.sendCtl(peerId, { t: 'watch', on: false });
    }
    this.watchFrames.delete(peerId);
    return true;
  }

  /** 對單一台要求關機；delaySec < 0 取消該台已排定的關機 */
  shutdownStudent(peerId: string, delaySec: number): boolean {
    const link = this.links.get(peerId);
    if (link?.ctl?.readyState !== 'open') return false;
    this.sendCtl(peerId, { t: 'shutdown', delaySec });
    return true;
  }

  /** 對單一台執行程式（該台機器上已存在的檔案；同「▶ 執行全班」的單人版） */
  execStudent(peerId: string, target: string, args: string[]): boolean {
    const link = this.links.get(peerId);
    if (link?.ctl?.readyState !== 'open') return false;
    this.sendCtl(peerId, { t: 'exec', path: target, args });
    return true;
  }

  /** 把「選擇檔案…」挑的檔案送給單一台（走該台的檔案通道） */
  sendFilesToStudent(peerId: string, files: File[]): boolean {
    const link = this.links.get(peerId);
    const channel = link?.file;
    if (!channel || channel.readyState !== 'open' || files.length === 0) return false;
    void this.deliverFiles(peerId, channel, files);
    return true;
  }

  /** 對單一台推播網址（同「網站推播」的單人版；學生機以瀏覽器開啟） */
  pushUrlStudent(peerId: string, url: string): boolean {
    const link = this.links.get(peerId);
    if (link?.ctl?.readyState !== 'open') return false;
    this.sendCtl(peerId, { t: 'open-url', url });
    return true;
  }

  /** 開機還原（UWF）遙控：對全部已連線學生機送出指令；回傳已送出數量 */
  uwfAll(
    action: 'setup' | 'install' | 'status' | 'maint-on' | 'maint-off' | 'remove' | 'set-exclusion',
    path?: string
  ): number {
    let sent = 0;
    for (const [peerId, link] of this.links) {
      if (link.ctl?.readyState === 'open') {
        this.sendCtl(peerId, { t: 'uwf', action, path });
        sent++;
      }
    }
    return sent;
  }

  /** 對單一台重開機（delaySec < 0 取消已排定的重開/關機） */
  rebootStudent(peerId: string, delaySec: number): boolean {
    const link = this.links.get(peerId);
    if (link?.ctl?.readyState !== 'open') return false;
    this.sendCtl(peerId, { t: 'reboot', delaySec });
    return true;
  }

  /** 全班重開機（對全部已連線學生機）；回傳已送出數量 */
  rebootAll(delaySec: number): number {
    let sent = 0;
    for (const [peerId, link] of this.links) {
      if (link.ctl?.readyState === 'open') {
        this.sendCtl(peerId, { t: 'reboot', delaySec });
        sent++;
      }
    }
    return sent;
  }

  // ─────────────────── 單台／部分直播（image 模式） ───────────────────

  private isBroadcastTarget(peerId: string): boolean {
    return !this.broadcastTargets || this.broadcastTargets.has(peerId);
  }

  /** 目前指定的名單（null = 全班） */
  getBroadcastTargets(): ReadonlySet<string> | null {
    return this.broadcastTargets;
  }

  /**
   * 把某台加入／移出名單：
   *   - 全班狀態下按 → 只播該台
   *   - 名單模式下按同台 → 移出（名單空了＝回到全班）
   *   - 名單模式下按別台 → 加入名單（多台一起看）
   * 回傳 null＝影片模式不支援；true＝該台已在名單；false＝已回全班。
   */
  toggleBroadcastStudent(peerId: string): boolean | null {
    if (this.options.broadcastMode !== 'image') return null;
    let targeted: boolean;
    if (this.broadcastTargets === null) {
      // 全班 → 只播這一台
      this.broadcastTargets = new Set([peerId]);
      targeted = true;
    } else if (this.broadcastTargets.has(peerId)) {
      this.broadcastTargets.delete(peerId);
      if (this.broadcastTargets.size === 0) this.broadcastTargets = null; // 名單空＝全班
      targeted = false;
    } else {
      this.broadcastTargets.add(peerId);
      targeted = true;
    }
    // 名單變動即時同步：變成目標的台補送 on，被移出的台補送 off
    if (this.localStream) {
      for (const id of this.links.keys()) {
        this.sendCtl(id, { t: 'broadcast', on: this.isBroadcastTarget(id), mode: 'image' });
      }
    }
    return targeted;
  }

  /** 注入設定檔的「定影幀」JPEG 品質（0.6–0.97，改了立即生效） */
  setImgSharpQuality(quality: number): void {
    this.pump.setSharpQuality(quality);
  }

  /**
   * 直接設定名單（勾選多台一次套用）：
   * ids 空陣列＝解除名單、回到全班；否則畫面只送 ids 內的台。
   * 回傳 false＝影片模式不支援（caller 要提示老師）；true＝已套用。
   */
  setBroadcastTargetIds(ids: string[]): boolean {
    if (this.options.broadcastMode !== 'image') {
      this.options.onLog('warn', '直播只在「圖片逐張」模式可用；目前是視訊模式。');
      return false;
    }
    if (ids.length === 0) {
      this.clearBroadcastTargets();
      return true;
    }
    this.broadcastTargets = new Set(ids);
    // 名單變動即時同步各台的 on／off（教師正在廣播時才需要）
    if (this.localStream) {
      for (const id of this.links.keys()) {
        this.sendCtl(id, { t: 'broadcast', on: this.isBroadcastTarget(id), mode: 'image' });
      }
      this.options.onLog('info', `直播已套用：只送 ${ids.length} 台（${this.namesOf(ids)}），其餘台維待機畫面。`);
    } else {
      this.options.onLog('info', `直播已設定（${ids.length} 台）；按「開始廣播」後生效。`);
    }
    return true;
  }

  /** 名單 id → 名字（記錄用，最多列 5 個） */
  private namesOf(ids: string[]): string {
    const names = ids.map(id => this.links.get(id)?.state.info.name ?? id);
    return names.length > 5 ? `${names.slice(0, 5).join('、')} 等 ${names.length} 台` : names.join('、');
  }

  /** 回到全班廣播（直播解除） */
  clearBroadcastTargets(): void {
    const hadTargets = this.broadcastTargets !== null;
    this.broadcastTargets = null;
    // 剛才被排除的台要補送 on（若正在廣播）
    if (hadTargets && this.localStream) {
      for (const peerId of this.links.keys()) {
        if (this.options.broadcastMode === 'image') {
          this.sendCtl(peerId, { t: 'broadcast', on: true, mode: 'image' });
        }
      }
    }
  }

  /** 斷線時把意圖清掉，重連後視為全新課堂 */
  clearLock(): void {
    this.lockOn = false;
  }

  /**
   * 要求所有已連線學生機關機（下課收攏用）。
   * 一次性事件：不持久化、不補送，重連的學生不會被莫名關掉。
   * `delaySec < 0` 表示取消已排定的關機（`shutdown /a`）。
   * 回傳送達（控制通道已開）的台數。
   */
  shutdownAll(delaySec: number): number {
    let sent = 0;
    for (const [peerId, link] of this.links) {
      if (link.ctl?.readyState === 'open') sent++;
      this.sendCtl(peerId, { t: 'shutdown', delaySec });
    }
    return sent;
  }

  /**
   * 教師端「執行程式」：對所有已連線學生機發 ctl exec。
   * 只啟動學生機上**已存在**的檔案（清單使人不夾帶內容），
   * .bat/.cmd 會在學生機以 cmd /c 開主控台視窗；不等待各台執行結果。
   * 回傳已送出的台數（各台結果可在該機 ☰ 記錄看到）。
   */
  execAll(target: string, args: string[]): number {
    let sent = 0;
    for (const [peerId, link] of this.links) {
      if (link.ctl && link.ctl.readyState === 'open') {
        this.sendCtl(peerId, { t: 'exec', path: target, args });
        sent++;
      }
    }
    return sent;
  }

  // ─────────────────────────── 檔案傳送 ───────────────────────────

  /**
   * 熱更新：把升級包（resources\app 的 zip）送給所有已連線學生機。
   * 送完檔案不直接確認套用——等該台的 file-result 成功回報後再送
   * `apply-update`，避免「套用時檔案還沒落地」。
   */
  sendUpgrade(file: File): number {
    const queued: string[] = [];
    for (const [peerId, link] of this.links) {
      if (link.file && link.file.readyState === 'open') {
        queued.push(peerId);
        this.upgradePackageNames.set(peerId, file.name);
        void this.deliverFiles(peerId, link.file, [file]);
      }
    }
    return queued.length;
  }

  /**
   * 把檔案傳送到所有已連線學生機（落在 config.json 指定的資料夾）。
   * 回傳「已開始送出」的學生機數量；每台的結果由 evt 通道回報 file-result。
   *
   * 通道協定：`file-meta`（JSON）→ 裸二進位分片（64KB/片）→ `file-end`（JSON）。
   * 對同一台是一檔做完才換下一檔，靠 `bufferedAmount` 做背壓，
   * 避免一次塞幾百 MB 把 renderer 端佇列灌爆。
   */
  sendFiles(files: File[]): number {
    if (files.length === 0) return 0;
    const sent: string[] = [];
    for (const [peerId, link] of this.links) {
      const channel = link.file;
      if (!channel || channel.readyState !== 'open') continue;
      sent.push(peerId);
      void this.deliverFiles(peerId, channel, files);
    }
    return sent.length;
  }

  private async deliverFiles(peerId: string, channel: RTCDataChannel, files: File[]): Promise<void> {
    for (const file of files) {
      const id = `f${Date.now().toString(36)}-${file.size.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const rejectedIds = this.fileRejected.get(peerId);
      rejectedIds?.delete(id);
      channel.send(
        JSON.stringify({ t: 'file-meta', id, name: file.name, size: file.size } satisfies FileChannelMessage)
      );

      for (let offset = 0; offset < file.size; offset += FILE_CHUNK_SIZE) {
        // 學生拒收（資料夾不可寫等）就立刻停手，不要把整個檔案灌進丟掉的黑洞
        if (rejectedIds?.has(id)) {
          this.options.onLog(
            'warn',
            `${this.links.get(peerId)?.state.info.name ?? peerId} 已拒收 ${file.name}，中止傳送`
          );
          break;
        }
        // 背壓：緩衝超過 8MB 就等 50ms；可靠的 SCTP 不會丟資料，只會變慢
        while (channel.bufferedAmount > 8 * 1024 * 1024) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        const slice = file.slice(offset, Math.min(offset + FILE_CHUNK_SIZE, file.size));
        channel.send(await slice.arrayBuffer());
      }

      if (rejectedIds?.has(id)) continue; // 已中止：不送 file-end、不記「已送出」
      channel.send(JSON.stringify({ t: 'file-end', id } satisfies FileChannelMessage));
      this.options.onLog('info', `已送出 ${file.name} 給 ${this.links.get(peerId)?.state.info.name ?? peerId}`);
    }
  }

  // ─────────────────────────── 內部 ───────────────────────────

  public sendCtl(peerId: string, message: CtlMessage): void {
    const channel = this.links.get(peerId)?.ctl;
    if (!channel || channel.readyState !== 'open') return;
    channel.send(JSON.stringify(message));
  }

  private handleServerMessage(message: ServerMessage): void {
    switch (message.t) {
      case 'welcome': {
        this.selfId = message.self;
        this.options.onLog('info', `已加入班級，本機 id = ${this.selfId}`);
        for (const peer of message.peers) this.upsertPeer(peer);
        this.options.onStudentsChanged();
        // 晚一步加入的教師機可能在學生之後才連上，補送自己的畫面尺寸
        if (this.localMeta) this.client?.send({ t: 'meta', screen: this.localMeta });
        break;
      }
      case 'peer-joined': {
        this.upsertPeer(message.peer);
        this.options.onLog('info', `${message.peer.name} 已加入`);
        break;
      }
      case 'peer-updated': {
        this.upsertPeer(message.peer);
        break;
      }
      case 'peer-left': {
        const peer = this.links.get(message.id);
        this.options.onLog('warn', `${peer?.state.info.name ?? message.id} 已離線（${message.reason}）`);
        this.teardownLink(message.id);
        this.links.delete(message.id);
        this.options.onStudentsChanged();
        break;
      }
      case 'signal': {
        void this.handleSignal(message.from, message.payload);
        break;
      }
      case 'error': {
        this.options.onLog('error', `伺服器：${message.message}`);
        break;
      }
      default:
        break;
    }
  }

  private upsertPeer(peer: PeerInfo): void {
    if (peer.role !== 'student') return;
    const existing = this.links.get(peer.id);
    if (existing) {
      existing.state.info = peer;
    } else {
      this.links.set(peer.id, {
        state: {
          info: peer,
          broadcastState: 'idle',
          lastError: null,
          lastSeenAt: Date.now(),
        },
        broadcast: null,
        img: null,
        ctl: null,
        evt: null,
        file: null,
        pendingBroadcastIce: [],
      });
    }
    // 學生一加入就建立廣播連線：ctl／evt 資料通道掛在這條連線上，
    // 這樣即使教師中途才開始廣播也不需要重新協商。
    void this.ensureBroadcastLink(peer.id);
    this.options.onStudentsChanged();
  }

  private async handleSignal(from: string, payload: SignalPayload): Promise<void> {
    const link = this.links.get(from);
    if (!link || payload.kind !== 'broadcast') return;

    if ('description' in payload && payload.description.type === 'answer') {
      const pc = link.broadcast;
      if (!pc) return;
      await pc.setRemoteDescription(payload.description as RTCSessionDescriptionInit);
      for (const candidate of link.pendingBroadcastIce.splice(0)) {
        await pc.addIceCandidate(candidate).catch(() => undefined);
      }
    } else if ('ice' in payload) {
      const pc = link.broadcast;
      if (!pc) return;
      if (pc.remoteDescription) {
        await pc.addIceCandidate(payload.ice as RTCIceCandidateInit).catch(() => undefined);
      } else {
        link.pendingBroadcastIce.push(payload.ice as RTCIceCandidateInit);
      }
    }
  }

  private async ensureBroadcastLink(peerId: string): Promise<void> {
    const link = this.links.get(peerId);
    if (!link || !this.client) return;
    if (link.broadcast) return;

    const pc = new RTCPeerConnection(RTC_CONFIG);
    link.broadcast = pc;
    link.state.broadcastState = 'new';

    // 圖片模式：不建視訊收發器（沒有畫面成本），只有資料通道；
    // 天生沒有「每台一份編碼」的問題。
    if (this.options.broadcastMode !== 'image') {
      const stream = this.localStream;
      const videoTrack = stream?.getVideoTracks()[0] ?? null;
      if (videoTrack && stream) {
        const sender = pc.addTrack(videoTrack, stream);
        await this.tuneSender(sender);
      } else {
        // 還沒開始廣播也要先把視訊通道開好。
        // 這條連線同時承載 ctl／evt 資料通道；若等有畫面才建立，
        // 中途開始廣播就得重新協商、中斷畫面。
        // 先掛一個 sendonly 的視訊收發器，之後 replaceTrack 就能直接送畫面，
        // 不需要重新協商。
        const transceiver = pc.addTransceiver('video', { direction: 'sendonly' });
        await this.tuneSender(transceiver.sender);
      }
    }

    // 一對資料通道，雙向共用：
    // ctl 由教師發、evt 由學生發；分開是為了讓「誰能送什麼」一目了然。
    link.ctl = pc.createDataChannel(DC_CTL, { ordered: true });
    link.evt = pc.createDataChannel(DC_EVT, { ordered: true });
    // 檔案傳送通道：即使現在還沒送過檔案也先開好，避免事後要重新協商
    link.file = pc.createDataChannel(DC_FILE, { ordered: true });
    // 圖片廣播通道（模式切到 image 時才會有資料流）
    link.img = pc.createDataChannel(DC_IMG, { ordered: true });
    this.wireCtlChannel(peerId, link);
    this.wireEvtChannel(peerId, link);

    // 編碼偏好要在 createOffer 之前設定（中途呼叫會觸發重新協商，
    // 這條連線的協商只由教師端開場一次，所以一律在開場前擺好）。
    await this.preferVideoCodecs(pc);

    pc.onicecandidate = event => {
      if (!event.candidate) return;
      this.client?.send({
        t: 'signal',
        to: peerId,
        payload: { kind: 'broadcast', ice: event.candidate.toJSON() },
      });
    };

    pc.onconnectionstatechange = () => {
      link.state.broadcastState = pc.connectionState;
      this.options.onStudentsChanged();
      if (pc.connectionState === 'failed') {
        this.options.onLog('error', `與 ${link.state.info.name} 的廣播連線失敗，將重新建立`);
        this.restartBroadcast(peerId, link);
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this.client.send({
      t: 'signal',
      to: peerId,
      payload: { kind: 'broadcast', description: { type: 'offer', sdp: offer.sdp } },
    });
  }

  /**
   * 找出廣播連線上的視訊 sender。
   *
   * 注意：**不能靠 `sender.track` 判斷**。停止廣播時我們會
   * `replaceTrack(null)`，此時 sender 與 transceiver 都還在，
   * 但 `sender.track` 已經變成 null；若用 track 去找，下次要恢復廣播時
   * 就會找不到 sender，學生端會永遠停在最後一格畫面。
   */
  private findVideoSender(pc: RTCPeerConnection): RTCRtpSender | null {
    const transceiver = pc.getTransceivers().find(item => item.receiver.track?.kind === 'video');
    if (transceiver) return transceiver.sender;
    return pc.getSenders().find(sender => sender.track?.kind === 'video') ?? null;
  }

  /** 連線失敗時的復原：整個砍掉重練比 restartIce 可靠 */
  private restartBroadcast(peerId: string, link: Link): void {
    link.broadcast?.close();
    link.broadcast = null;
    link.ctl = null;
    link.evt = null;
    link.file = null;
    link.img = null;
    setTimeout(() => void this.ensureBroadcastLink(peerId), 1000);
  }

  private wireCtlChannel(peerId: string, link: Link): void {
    const channel = link.ctl;
    if (!channel) return;
    channel.onopen = () => {
      this.options.onLog('info', `控制通道已連上 ${link.state.info.name}`);
      const meta = this.localMeta;
      channel.send(
        JSON.stringify({
          t: 'ctl-hello',
          teacherId: this.selfId ?? 'unknown',
          teacherName: this.options.teacherName,
          screen: meta ?? { width: 0, height: 0, x: 0, y: 0, scaleFactor: 1, monitors: 1 },
          ts: Date.now(),
        } satisfies CtlMessage)
      );
      // 通道一通就先告訴學生「現在有沒有廣播」：
      // 學生中途加入或重新連線時，才不會停在錯誤的畫面狀態。
      // （直播只通知名單內的台；以下是 image 模式的行為）
      const broadcastOn =
        Boolean(this.localStream) && (this.options.broadcastMode === 'video' || this.isBroadcastTarget(peerId));
      this.sendCtl(peerId, {
        t: 'broadcast',
        on: broadcastOn,
        mode: this.options.broadcastMode,
      });
      // 鎖定意圖也補送：中途上線／重新連線的學生不該漏鎖
      this.sendCtl(peerId, { t: 'lock', on: this.lockOn });
      // 靜音意圖同理補送
      this.sendCtl(peerId, { t: 'mute', on: this.muteOn });
      this.options.onStudentsChanged();
    };
    channel.onclose = () => this.options.onStudentsChanged();
    channel.onerror = event => {
      this.options.onLog('warn', `控制通道錯誤（${link.state.info.name}）：${String(event)}`);
    };
  }

  private wireEvtChannel(peerId: string, link: Link): void {
    const channel = link.evt;
    if (!channel) return;
    channel.binaryType = 'arraybuffer';
    channel.onmessage = event => {
      // 監看的幀分片是裸二進位（hdr／end 才是 JSON 字串）
      if (event.data instanceof ArrayBuffer) {
        this.ingestWatchChunk(peerId, event.data);
        return;
      }
      let parsed: DcMessage;
      try {
        parsed = JSON.parse(String(event.data)) as DcMessage;
      } catch {
        return;
      }
      link.state.lastSeenAt = Date.now();
      // evt 承載 evt-hello（學生就緒回報）、監看幀信封、檔案結果與 pong（心跳回應）
      if (parsed.t === 'evt-hello') {
        // 版本戳：學生機升級後老師記錄一眼看出它跑哪一版。
        // 舊版學生機不帶 build——不能沈默，要標「舊版」才不會誤判成沒連上。
        const name = parsed.studentName || parsed.studentId || '(未知位址)';
        if (parsed.agent?.build) {
          const buildLocal = `${parsed.agent.build.slice(0, 16).replace('T', ' ')}`;
          this.options.onLog('info', `${name}（v${parsed.agent.version}，build ${buildLocal}）已連線`);
        } else {
          this.options.onLog('warn', `${name}（v${parsed.agent?.version ?? '?'}，舊版未帶 build 標記）已連線`);
        }
        return;
      }
      if (parsed.t === 'pong') return;
      if (parsed.t === 'update-result') {
        const name = this.links.get(peerId)?.state.info.name ?? peerId;
        if (parsed.ok) {
          this.options.onLog('info', `${name} 升級套用：${parsed.message ?? '已開始套用'}`);
        } else {
          this.options.onLog('warn', `${name} 升級套用被擋：${parsed.message ?? '未知原因'}`);
        }
        return;
      }
      if (parsed.t === 'watch-frame-hdr') {
        if (parsed.size <= 0 || parsed.size > TeacherSession.WATCH_MAX_FRAME_BYTES) return;
        this.watchFrames.set(peerId, {
          seq: parsed.seq,
          width: parsed.width,
          height: parsed.height,
          expectedSize: parsed.size,
          received: 0,
          chunks: [],
        });
        return;
      }
      if (parsed.t === 'watch-frame-end') {
        const assembly = this.watchFrames.get(peerId);
        this.watchFrames.delete(peerId);
        if (assembly && assembly.received === assembly.expectedSize) {
          const blob = new Blob(assembly.chunks, { type: 'image/jpeg' });
          const url = URL.createObjectURL(blob);
          this.options.onWatchFrame?.(peerId, {
            url,
            width: assembly.width,
            height: assembly.height,
            seq: assembly.seq,
          });
        }
        return;
      }
      if (parsed.t === 'file-result') {
        if (parsed.ok) {
          this.options.onLog(
            'info',
            `${link.state.info.name} 已收到 ${parsed.name}${parsed.path ? `，存到 ${parsed.path}` : ''}`
          );
          // 熱更新：升級包落地的第一時間就通知該台套用
          if (this.upgradePackageNames.get(peerId) === parsed.name) {
            this.upgradePackageNames.delete(peerId);
            this.sendCtl(peerId, { t: 'apply-update' });
            this.options.onLog('info', `${link.state.info.name} 升級包就緒，已通知套用（本機即將重啟）`);
          }
        } else {
          // 記下拒收序號：deliverFiles 每送一片前都會檢查並中止
          if (!this.fileRejected.has(peerId)) this.fileRejected.set(peerId, new Set());
          this.fileRejected.get(peerId)?.add(parsed.id);
          this.options.onLog(
            'warn',
            `${link.state.info.name} 收檔失敗（${parsed.name}）：${parsed.message ?? '未知原因'}`
          );
        }
        return;
      }
      if (parsed.t === 'error') {
        link.state.lastError = parsed.message;
        this.options.onLog('warn', `${link.state.info.name} 回報錯誤：${parsed.message}`);
        this.options.onStudentsChanged();
      }
      if (parsed.t === 'uwf-result') {
        // 開機還原（UWF）遙控的結果回報：text 是學生端一行摘要
        this.options.onLog(parsed.ok ? 'info' : 'warn', `${link.state.info.name} 開機還原：${parsed.text}`);
      }
    };
  }

  /** 通道上收到監看幀的一個分片：有正在組裝的幀才收（hdr 沒先到的丟棄） */
  private ingestWatchChunk(peerId: string, chunk: ArrayBuffer): void {
    const assembly = this.watchFrames.get(peerId);
    if (!assembly) return;
    const room = assembly.expectedSize - assembly.received;
    if (room <= 0) return;
    const slice = chunk.byteLength > room ? chunk.slice(0, room) : chunk;
    assembly.chunks.push(slice);
    assembly.received += slice.byteLength;
  }

  /**
   * 把 H.264 排到編碼偏好第一名（硬體編碼路徑）。
   *
   * 背景：WebRTC 對同一條視訊軌會給每台學生機**各編一份**，
   * 30 台＝30 路軟體 VP8/VP9 編碼，教師機 CPU 一定塞車→畫面延遲。
   * H.264 走 GPU（QuickSync / NVENC / AMF），解碼端也吃 GPU，
   * 多台教室場景的負載直接低一個量級。
   * 頻寬同樣以 tuneSender 的 maxBitrate 為上限，不受影響。
   */
  private async preferVideoCodecs(pc: RTCPeerConnection): Promise<void> {
    if (!this.options.hardwareCodec) return;
    try {
      const caps = RTCRtpSender.getCapabilities?.('video');
      const codecs = [...(caps?.codecs ?? [])];
      const h264 = codecs.filter(codec => codec.mimeType?.toLowerCase() === 'video/h264');
      if (h264.length === 0) {
        this.options.onLog('warn', '這台教師機的瀏覽器不支援 H.264 編碼，沿用預設編碼。');
        return;
      }
      const others = codecs.filter(codec => codec.mimeType?.toLowerCase() !== 'video/h264');
      const ordered = [...h264, ...others];
      for (const transceiver of pc.getTransceivers()) {
        // kind 是標準屬性，但這裡的 TS lib 型別沒標到 → 先 cast、再以 sender.track 補判
        const kind = (transceiver as unknown as { kind?: string }).kind ?? transceiver.sender.track?.kind ?? '';
        if (kind !== 'video') continue;
        transceiver.setCodecPreferences(ordered);
      }
    } catch (error) {
      this.options.onLog('warn', `編碼偏好設定失敗（沿用預設）:${describe(error)}`);
    }
  }

  /** 教室場景是文字、簡報與程式碼，因此偏好「保住解析度」而不是「保住流暢度」。 */
  private async tuneSender(sender: RTCRtpSender): Promise<void> {
    try {
      const params = sender.getParameters();
      if (!params.encodings || params.encodings.length === 0) {
        params.encodings = [{}];
      }
      const encoding = params.encodings[0];
      if (encoding) {
        encoding.maxBitrate = this.options.maxBitrate;
        encoding.maxFramerate = this.options.maxFramerate;
      }
      params.degradationPreference = 'maintain-resolution';
      await sender.setParameters(params);
    } catch (error) {
      this.options.onLog('warn', `設定編碼參數失敗（不影響功能）：${describe(error)}`);
    }
  }

  /**
   * 畫質設定變更後立刻套用到所有已建立的廣播連線。
   *
   * `maxBitrate`／`maxFramerate` 走 `setParameters`，不觸發重新協商，
   * 學生端不會看到斷線或黑畫面（擷取尺寸與擷取幀率仍需重新擷取，
   * 那部分由 renderer 提示老師重啟廣播）。
   */
  async updateEncoding(maxBitrate: number, maxFramerate: number): Promise<void> {
    this.options.maxBitrate = maxBitrate;
    this.options.maxFramerate = maxFramerate;
    for (const link of this.links.values()) {
      if (!link.broadcast) continue;
      const sender = this.findVideoSender(link.broadcast);
      if (sender) await this.tuneSender(sender);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      for (const [peerId, link] of this.links) {
        if (link.ctl?.readyState === 'open') {
          this.sendCtl(peerId, { t: 'ping', ts: Date.now() });
        }
      }
    }, 4000);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private teardownLink(peerId: string): void {
    const link = this.links.get(peerId);
    if (!link) return;
    this.upgradePackageNames.delete(peerId);
    // 監看的半成品幀也一併丟掉（分片通道已關，永遠組不完了）
    this.watchFrames.delete(peerId);
    try {
      link.ctl?.close();
      link.evt?.close();
      link.file?.close();
      link.img?.close();
      link.broadcast?.close();
    } catch {
      // 關閉時的例外不影響流程
    }
    link.broadcast = null;
    link.ctl = null;
    link.evt = null;
    link.file = null;
    link.img = null;
  }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
