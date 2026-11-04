import type { CtlMessage } from '@classroom/protocol';
import type { Link } from './types.js';

/** 鎖定／靜音／關機／重開機／執行程式／UWF 等控制指令管理器 */
export class ControlManager {
  private readonly links: Map<string, Link>;
  private readonly sendCtl: (peerId: string, message: CtlMessage) => void;
  private readonly onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  private lockOn = false;
  private muteOn = false;
  /** 單台鎖定狀態（lockStudent 記錄；lockAll 會整批覆寫） */
  private lockedPeers = new Set<string>();

  constructor(
    links: Map<string, Link>,
    sendCtl: (peerId: string, message: CtlMessage) => void,
    onLog: (level: 'info' | 'warn' | 'error', message: string) => void
  ) {
    this.links = links;
    this.sendCtl = sendCtl;
    this.onLog = onLog;
  }

  getLockOn(): boolean {
    return this.lockOn;
  }
  getMuteOn(): boolean {
    return this.muteOn;
  }
  setLockOn(on: boolean) {
    this.lockOn = on;
  }
  setMuteOn(on: boolean) {
    this.muteOn = on;
  }

  // ─────────────────────── 鎖定 ───────────────────────

  /** 鎖定／解除全班學生機鍵盤滑鼠（課堂秩序）。
   * 意圖記在 `lockOn`：新加入或重連的學生在 ctl 通道打開時自動補送狀態，
   * 不會有「老師忘了對剛上線的那台鎖定」的漏洞。 */
  lockAll(on: boolean): number {
    this.lockOn = on;
    // 全班意圖覆寫單台狀態：鎖定＝全部加入、解除＝清空
    this.lockedPeers = on ? new Set(this.links.keys()) : new Set();
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

  /** 該台目前是否處於鎖定狀態（按鈕切換顯示用） */
  isLocked(peerId: string): boolean {
    return this.lockedPeers.has(peerId);
  }

  /** 對單一台鎖定／解除鍵盤滑鼠 */
  lockStudent(peerId: string, on: boolean): boolean {
    const link = this.links.get(peerId);
    if (link?.ctl?.readyState !== 'open') return false;
    this.sendCtl(peerId, { t: 'lock', on });
    if (on) this.lockedPeers.add(peerId);
    else this.lockedPeers.delete(peerId);
    return true;
  }

  // ─────────────────────── 靜音 ───────────────────────

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

  // ─────────────────────── 關閉瀏覽器 ───────────────────────

  /** 關閉學生 Chrome／Edge（一次性動作，不記意圖） */
  closeBrowsersAll(): number {
    let sent = 0;
    for (const peerId of this.links.keys()) {
      if (this.links.get(peerId)?.ctl?.readyState === 'open') sent++;
      this.sendCtl(peerId, { t: 'close-browsers' });
    }
    return sent;
  }

  // ─────────────────────── 關機 ───────────────────────

  /** 對單一台要求關機；delaySec < 0 取消該台已排定的關機 */
  shutdownStudent(peerId: string, delaySec: number): boolean {
    const link = this.links.get(peerId);
    if (link?.ctl?.readyState !== 'open') return false;
    this.sendCtl(peerId, { t: 'shutdown', delaySec });
    return true;
  }

  /** 要求所有已連線學生機關機（下課收攏用）。
   * 一次性事件：不持久化、不補送，重連的學生不會被莫名關掉。
   * `delaySec < 0` 表示取消已排定的關機（`shutdown /a`）。
   * 回傳送達（控制通道已開）的台數。 */
  shutdownAll(delaySec: number): number {
    let sent = 0;
    for (const [peerId, link] of this.links) {
      if (link.ctl?.readyState === 'open') sent++;
      this.sendCtl(peerId, { t: 'shutdown', delaySec });
    }
    return sent;
  }

  // ─────────────────────── 重開機 ───────────────────────

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

  // ─────────────────────── 執行程式 ───────────────────────

  /** 對單一台執行程式（該台機器上已存在的檔案；同「▶ 執行全班」的單人版） */
  execStudent(peerId: string, target: string, args: string[]): boolean {
    const link = this.links.get(peerId);
    if (link?.ctl?.readyState !== 'open') return false;
    this.sendCtl(peerId, { t: 'exec', path: target, args });
    return true;
  }

  /** 教師端「執行程式」：對所有已連線學生機發 ctl exec。
   * 只啟動學生機上**已存在**的檔案（清單使人不夾帶內容），
   * .bat/.cmd 會在學生機以 cmd /c 開主控台視窗；不等待各台執行結果。
   * 回傳已送出的台數（各台結果可在該機 ☰ 記錄看到）。 */
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

  // ─────────────────────── 推播網址 ───────────────────────

  /** 對單一台推播網址（同「網站推播」的單人版；學生機以瀏覽器開啟） */
  pushUrlStudent(peerId: string, url: string): boolean {
    const link = this.links.get(peerId);
    if (link?.ctl?.readyState !== 'open') return false;
    this.sendCtl(peerId, { t: 'open-url', url });
    return true;
  }

  // ─────────────────────── UWF 開機還原 ───────────────────────

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

  // ─────────────────────── 收攏視窗 ───────────────────────

  /** 把所有學生機縮到系統匣（停止廣播後收攏教室用：
   * 學生機視窗隱藏、行程留在背景，教師重新廣播會自動把它拉回全螢幕）。 */
  minimizeAll(): void {
    for (const peerId of this.links.keys()) {
      this.sendCtl(peerId, { t: 'minimize', on: true });
    }
  }

  /** 要求所有已連線學生機以系統預設瀏覽器開啟網址。
   * 回傳實際送達（控制通道已開）的學生機數量。 */
  openUrlAll(url: string): number {
    let sent = 0;
    for (const peerId of this.links.keys()) {
      if (this.links.get(peerId)?.ctl?.readyState === 'open') sent++;
      this.sendCtl(peerId, { t: 'open-url', url });
    }
    return sent;
  }

  /** 斷線時把意圖清掉，重連後視為全新課堂 */
  clearLock(): void {
    this.lockOn = false;
  }
}
