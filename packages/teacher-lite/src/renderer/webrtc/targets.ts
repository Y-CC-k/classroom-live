import type { Link, TeacherSessionOptions } from './types.js';
import type { CtlMessage } from '@classroom/protocol';

/** 單台／部分直播（image 模式）目標管理器 */
export class TargetsManager {
  private readonly options: TeacherSessionOptions;
  private readonly links: Map<string, Link>;
  private readonly sendCtl: (peerId: string, message: CtlMessage) => void;
  private readonly onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly getLocalStream: () => MediaStream | null;
  private broadcastTargets: Set<string> | null = null;

  constructor(
    options: TeacherSessionOptions,
    links: Map<string, Link>,
    sendCtl: (peerId: string, message: any) => void,
    onLog: (level: 'info' | 'warn' | 'error', message: string) => void,
    getLocalStream: () => MediaStream | null
  ) {
    this.options = options;
    this.links = links;
    this.sendCtl = sendCtl;
    this.onLog = onLog;
    this.getLocalStream = getLocalStream;
  }

  getBroadcastTargets(): ReadonlySet<string> | null {
    return this.broadcastTargets;
  }
  setBroadcastTargets(targets: Set<string> | null) {
    this.broadcastTargets = targets;
  }

  private isBroadcastTarget(peerId: string): boolean {
    return !this.broadcastTargets || this.broadcastTargets.has(peerId);
  }

  /** 名單 id → 名字（記錄用，最多列 5 個） */
  private namesOf(ids: string[]): string {
    const names = ids.map(id => this.links.get(id)?.state.info.name ?? id);
    return names.length > 5 ? `${names.slice(0, 5).join('、')} 等 ${names.length} 台` : names.join('、');
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
    if (this.getLocalStream()) {
      for (const id of this.links.keys()) {
        this.sendCtl(id, { t: 'broadcast', on: this.isBroadcastTarget(id), mode: 'image' });
      }
    }
    return targeted;
  }

  /** 注入設定檔的「定影幀」JPEG 品質（0.6–0.97，改了立即生效） */
  setImgSharpQuality(_quality: number): void {
    // 由 BroadcastManager 的 pump 處理
  }

  /**
   * 直接設定名單（勾選多台一次套用）：
   * ids 空陣列＝解除名單、回到全班；否則畫面只送 ids 內的台。
   * 回傳 false＝影片模式不支援（caller 要提示老師）；true＝已套用。
   */
  setBroadcastTargetIds(ids: string[]): boolean {
    if (this.options.broadcastMode !== 'image') {
      this.onLog('warn', '直播只在「圖片逐張」模式可用；目前是視訊模式。');
      return false;
    }
    if (ids.length === 0) {
      this.clearBroadcastTargets();
      return true;
    }
    this.broadcastTargets = new Set(ids);
    // 名單變動即時同步各台的 on／off（教師正在廣播時才需要）
    if (this.getLocalStream()) {
      for (const id of this.links.keys()) {
        this.sendCtl(id, { t: 'broadcast', on: this.isBroadcastTarget(id), mode: 'image' });
      }
      this.onLog('info', `直播已套用：只送 ${ids.length} 台（${this.namesOf(ids)}），其餘台維待機畫面。`);
    } else {
      this.onLog('info', `直播已設定（${ids.length} 台）；按「開始廣播」後生效。`);
    }
    return true;
  }

  /** 回到全班廣播（直播解除） */
  clearBroadcastTargets(): void {
    const hadTargets = this.broadcastTargets !== null;
    this.broadcastTargets = null;
    // 剛才被排除的台要補送 on（若正在廣播）
    if (hadTargets && this.getLocalStream()) {
      for (const peerId of this.links.keys()) {
        if (this.options.broadcastMode === 'image') {
          this.sendCtl(peerId, { t: 'broadcast', on: true, mode: 'image' });
        }
      }
    }
  }
}
