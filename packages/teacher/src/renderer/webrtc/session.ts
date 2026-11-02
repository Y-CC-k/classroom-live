import type { CtlMessage, DcMessage, ScreenMeta } from '@classroom/protocol';

import type { TeacherSessionOptions, StudentState } from './types.js';
import { BroadcastManager } from './broadcast.js';
import { FileTransferManager } from './file-transfer.js';
import { ControlManager } from './lock.js';
import { TargetsManager } from './targets.js';
import { MonitorManager } from './monitor.js';
import { AdaptiveQualityManager } from './adaptive-quality.js';

/** 教師端的會話核心。
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

export class TeacherSession {
  private readonly broadcastManager: BroadcastManager;
  private readonly fileTransferManager: FileTransferManager;
  private readonly controlManager: ControlManager;
  private readonly targetsManager: TargetsManager;
  private readonly monitorManager: MonitorManager;
  private readonly adaptiveQualityManager: AdaptiveQualityManager;

  constructor(options: TeacherSessionOptions) {
    // 建立 BroadcastManager（核心連線管理）
    this.broadcastManager = new BroadcastManager(options);

    // 建立各功能管理器
    this.fileTransferManager = new FileTransferManager(
      options,
      this.broadcastManager.getLinks(),
      this.broadcastManager
    );

    this.controlManager = new ControlManager(
      this.broadcastManager.getLinks(),
      this.broadcastManager.sendCtl.bind(this.broadcastManager),
      options.onLog
    );

    this.targetsManager = new TargetsManager(
      options,
      this.broadcastManager.getLinks(),
      this.broadcastManager.sendCtl.bind(this.broadcastManager),
      options.onLog,
      () => this.broadcastManager.getLocalStream()
    );

    this.monitorManager = new MonitorManager(
      options,
      this.broadcastManager.getLinks(),
      this.broadcastManager.sendCtl.bind(this.broadcastManager),
      options.onLog,
      options.onWatchFrame
    );

    // 自適應畫質管理器
    const senderLinks = new Map<string, { sender: RTCRtpSender }>();
    for (const [peerId, link] of this.broadcastManager.getLinks()) {
      if (link.broadcast) {
        const sender = link.broadcast.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          senderLinks.set(peerId, { sender });
        }
      }
    }
    this.adaptiveQualityManager = new AdaptiveQualityManager(
      senderLinks,
      (maxBitrate, maxFramerate, maxCaptureWidth, maxCaptureHeight) => {
        this.applyAdaptiveQuality(maxBitrate, maxFramerate, maxCaptureWidth, maxCaptureHeight);
      }
    );
  }

  // ─────────────────────────── 代理屬性與方法 ───────────────────────────

  get isConnected(): boolean {
    return this.broadcastManager['isConnected'];
  }

  get localMeta(): ScreenMeta | null {
    return this.broadcastManager['localMeta'];
  }

  students(): StudentState[] {
    return this.broadcastManager['students']();
  }

  // ─────────────────────────── 連線生命週期 ───────────────────────────

  connect(): void {
    this.broadcastManager['connect']();
    // 自適應畫質：根據設定啟用或停用
    if (this.broadcastManager['options'].adaptiveQualityEnabled) {
      this.adaptiveQualityManager.enable();
    }
  }

  disconnect(): void {
    this.broadcastManager['disconnect']();
  }

  // ─────────────────────────── 螢幕來源 ───────────────────────────

  async setLocalStream(stream: MediaStream | null): Promise<void> {
    await this.broadcastManager['setLocalStream'](stream);
  }

  // ─────────────────────────── 對學生的操作 ───────────────────────────

  minimizeAll(): void {
    this.controlManager.minimizeAll();
  }

  openUrlAll(url: string): number {
    return this.controlManager.openUrlAll(url);
  }

  lockAll(on: boolean): number {
    return this.controlManager.lockAll(on);
  }

  get lockActive(): boolean {
    return this.controlManager.lockActive;
  }

  lockStudent(peerId: string, on: boolean): boolean {
    return this.controlManager.lockStudent(peerId, on);
  }

  get muteActive(): boolean {
    return this.controlManager.muteActive;
  }

  muteAll(on: boolean): number {
    return this.controlManager.muteAll(on);
  }

  muteStudent(peerId: string, on: boolean): boolean {
    return this.controlManager.muteStudent(peerId, on);
  }

  closeBrowsersAll(): number {
    return this.controlManager.closeBrowsersAll();
  }

  watchStudent(peerId: string, on: boolean, intervalMs?: number): boolean {
    return this.monitorManager.watchStudent(peerId, on, intervalMs);
  }

  shutdownStudent(peerId: string, delaySec: number): boolean {
    return this.controlManager.shutdownStudent(peerId, delaySec);
  }

  execStudent(peerId: string, target: string, args: string[]): boolean {
    return this.controlManager.execStudent(peerId, target, args);
  }

  sendFilesToStudent(peerId: string, files: File[]): boolean {
    return this.fileTransferManager.sendFilesToStudent(peerId, files);
  }

  pushUrlStudent(peerId: string, url: string): boolean {
    return this.controlManager.pushUrlStudent(peerId, url);
  }

  uwfAll(
    action: 'setup' | 'install' | 'status' | 'maint-on' | 'maint-off' | 'remove' | 'set-exclusion',
    path?: string
  ): number {
    return this.controlManager.uwfAll(action, path);
  }

  rebootStudent(peerId: string, delaySec: number): boolean {
    return this.controlManager.rebootStudent(peerId, delaySec);
  }

  rebootAll(delaySec: number): number {
    return this.controlManager.rebootAll(delaySec);
  }

  shutdownAll(delaySec: number): number {
    return this.controlManager.shutdownAll(delaySec);
  }

  execAll(target: string, args: string[]): number {
    return this.controlManager.execAll(target, args);
  }

  // ─────────────────── 單台／部分直播（image 模式） ───────────────────

  private isBroadcastTarget(peerId: string): boolean {
    return this.targetsManager['isBroadcastTarget'](peerId);
  }

  getBroadcastTargets(): ReadonlySet<string> | null {
    return this.targetsManager.getBroadcastTargets();
  }

  getLocalStream(): MediaStream | null {
    return this.broadcastManager.getLocalStream();
  }

  toggleBroadcastStudent(peerId: string): boolean | null {
    return this.targetsManager.toggleBroadcastStudent(peerId);
  }

  setImgSharpQuality(quality: number): void {
    this.broadcastManager.getPump().setSharpQuality(quality);
  }

  setBroadcastTargetIds(ids: string[]): boolean {
    return this.targetsManager.setBroadcastTargetIds(ids);
  }

  clearBroadcastTargets(): void {
    this.targetsManager.clearBroadcastTargets();
  }

  // ─────────────────────────── 檔案傳送 ───────────────────────────

  sendUpgrade(file: File): number {
    return this.fileTransferManager.sendUpgrade(file);
  }

  sendFiles(files: File[]): number {
    return this.fileTransferManager.sendFiles(files);
  }

  // ─────────────────────────── 內部事件處理 ───────────────────────────

  /** 由 BroadcastManager 的 wireEvtChannel 呼叫 */
  handleEvtMessage(peerId: string, parsed: DcMessage): void {
    // 監看幀相關
    if (parsed.t === 'watch-frame-hdr') {
      this.monitorManager.handleWatchFrameHdr(peerId, parsed);
      return;
    }
    if (parsed.t === 'watch-frame-end') {
      this.monitorManager.handleWatchFrameEnd(peerId, parsed);
      return;
    }
    // 二進位分片
    if (parsed instanceof ArrayBuffer) {
      this.monitorManager.ingestWatchChunk(peerId, parsed);
      return;
    }
    // 其他訊息由 BroadcastManager 處理（evt-hello, pong, update-result, file-result, error, uwf-result）
    // 這裡不需要額外處理
  }

  // ─────────────────────────── 公開 API ───────────────────────────

  public sendCtl(peerId: string, message: CtlMessage): void {
    this.broadcastManager.sendCtl(peerId, message);
  }

  /** 畫質設定變更後立刻套用到所有已建立的廣播連線。 */
  async updateEncoding(maxBitrate: number, maxFramerate: number): Promise<void> {
    for (const link of this.broadcastManager.getLinks().values()) {
      if (!link.broadcast) continue;
      const sender = link.broadcast.getSenders().find(s => s.track?.kind === 'video');
      if (sender) {
        try {
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          const encoding = params.encodings[0];
          if (encoding) {
            encoding.maxBitrate = maxBitrate;
            encoding.maxFramerate = maxFramerate;
          }
          params.degradationPreference = 'maintain-resolution';
          await sender.setParameters(params);
        } catch (error) {
          this.broadcastManager.getLinks().get(link.state.info.id)?.state.info.name; // dummy to avoid unused
          console.warn(`設定編碼參數失敗（不影響功能）：${describe(error)}`);
        }
      }
    }
  }

  /** 自適應畫質回調：由 AdaptiveQualityManager 呼叫，調整編碼參數 */
  async applyAdaptiveQuality(
    maxBitrate: number,
    maxFramerate: number,
    _maxCaptureWidth: number,
    _maxCaptureHeight: number
  ): Promise<void> {
    for (const link of this.broadcastManager.getLinks().values()) {
      if (!link.broadcast) continue;
      const sender = link.broadcast.getSenders().find(s => s.track?.kind === 'video');
      if (sender) {
        try {
          const params = sender.getParameters();
          if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}];
          }
          const encoding = params.encodings[0];
          if (encoding) {
            // 只有當值大於 0 時才覆寫（0 表示保持原值）
            if (maxBitrate > 0) encoding.maxBitrate = maxBitrate;
            if (maxFramerate > 0) encoding.maxFramerate = maxFramerate;
            // 擷取尺寸需要透過 getUserMedia 重新約束，這裡只記錄，由 renderer 端處理
          }
          params.degradationPreference = 'maintain-resolution';
          await sender.setParameters(params);
        } catch (error) {
          console.warn(`自適應畫質設定失敗：${describe(error)}`);
        }
      }
    }
    // 回寫 config，讓 UI 能顯示自動調整後的畫質
    await window.teacherApi.saveConfig({ maxBitrate, maxFramerate });
  }

  /** 啟用/停用自適應畫質 */
  setAdaptiveQualityEnabled(enabled: boolean): void {
    this.adaptiveQualityManager.setEnabled(enabled);
  }

  /** 自適應畫質是否啟用 */
  getAdaptiveQualityEnabled(): boolean {
    return this.adaptiveQualityManager.isEnabled;
  }

  /** 取得當前畫質等級（0 = 預設，越大越低） */
  getAdaptiveQualityLevel(): number {
    return this.adaptiveQualityManager.qualityLevel;
  }

  /** 重置畫質等級為預設 */
  resetAdaptiveQuality(): void {
    this.adaptiveQualityManager.reset();
  }

  // ─────────────────────────── 多螢幕監控牆 ───────────────────────────

  /** 同時開始監看多台學生機（監控牆用）。回傳實際開始監看的數量。 */
  watchStudents(peerIds: string[], intervalMs = 3000): number {
    return this.monitorManager.watchStudents(peerIds, intervalMs);
  }

  /** 停止單台學生機的監看。 */
  unwatchStudent(peerId: string): void {
    this.monitorManager.watchStudent(peerId, false);
  }

  /** 停止所有監看（監控牆關閉用）。 */
  unwatchAllStudents(): void {
    this.monitorManager.unwatchAll();
  }

  /** 取得目前正在監看的 peerId 列表。 */
  getWatchingPeerIds(): string[] {
    return this.monitorManager.getWatchingPeerIds();
  }

  /** 取得 ctl 通道已連線（可監看）的學生機 ID 列表。 */
  getConnectedStudentIds(): string[] {
    return this.monitorManager.getConnectedPeerIds();
  }

  /**
   * 更新所有已連線學生機的待機（開機初始）畫面文字。
   * 回傳已送出的台數（ctl 通道未開的台送不到）。
   */
  setIdleScreenAll(title: string, text: string): number {
    let sent = 0;
    for (const [peerId, link] of this.broadcastManager.getLinks()) {
      if (link.ctl?.readyState === 'open') {
        this.broadcastManager.sendCtl(peerId, { t: 'idle-screen', title, text });
        sent++;
      }
    }
    return sent;
  }
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
