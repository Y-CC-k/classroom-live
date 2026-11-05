import type { Link, TeacherSessionOptions } from './types.js';
import type { DcMessage } from '@classroom/protocol';

const WATCH_MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** 螢幕監看（單台 3 秒一張 JPEG）管理器 */
export class MonitorManager {
  private readonly options: TeacherSessionOptions;
  private readonly links: Map<string, Link>;
  private readonly sendCtl: (peerId: string, message: DcMessage) => void;
  private readonly onLog: (level: 'info' | 'warn' | 'error', message: string) => void;
  private readonly onWatchFrame:
    | ((peerId: string, frame: { url: string; width: number; height: number; seq: number; blob: Blob }) => void)
    | undefined;

  // ── 螢幕監看的幀組裝狀態（one per watched peer） ──
  private readonly watchFrames = new Map<
    string,
    {
      seq: number;
      width: number;
      height: number;
      expectedSize: number;
      received: number;
      chunks: ArrayBuffer[];
    }
  >();

  constructor(
    options: TeacherSessionOptions,
    links: Map<string, Link>,
    sendCtl: (peerId: string, message: any) => void,
    onLog: (level: 'info' | 'warn' | 'error', message: string) => void,
    onWatchFrame?: (
      peerId: string,
      frame: { url: string; width: number; height: number; seq: number; blob: Blob }
    ) => void
  ) {
    this.options = options;
    this.links = links;
    this.sendCtl = sendCtl;
    this.onLog = onLog;
    this.onWatchFrame = onWatchFrame;
  }

  getWatchFrames(): Map<string, any> {
    return this.watchFrames;
  }

  /**
   * 對單一台開始／停止監看。
   * 支援多台同時監看（不會自動停掉其他台）。
   * `maxWidth`：要求學生端把幀壓到指定寬度以內（省略＝學生端預設 960）。
   */
  watchStudent(peerId: string, on: boolean, intervalMs = 3000, maxWidth?: number): boolean {
    const link = this.links.get(peerId);
    if (on) {
      if (link?.ctl?.readyState !== 'open') return false;
      if (!Number.isFinite(intervalMs) || intervalMs < 500) intervalMs = 500;
      const width = Number.isFinite(maxWidth) && (maxWidth ?? 0) >= 320 ? Math.round(maxWidth!) : undefined;
      this.sendCtl(peerId, { t: 'watch', on: true, intervalMs: Math.round(intervalMs), maxWidth: width });
      return true;
    }
    if (link?.ctl?.readyState === 'open') {
      this.sendCtl(peerId, { t: 'watch', on: false });
    }
    this.watchFrames.delete(peerId);
    return true;
  }

  /**
   * 同時開始監看多台學生機（監控牆用）。
   * 回傳實際開始監看的數量。
   */
  watchStudents(peerIds: string[], intervalMs = 3000, maxWidth?: number): number {
    let count = 0;
    for (const peerId of peerIds) {
      if (this.watchStudent(peerId, true, intervalMs, maxWidth)) count++;
    }
    return count;
  }

  /** 停止所有監看（監控牆關閉用）。 */
  unwatchAll(): void {
    for (const peerId of this.links.keys()) {
      const link = this.links.get(peerId);
      if (link?.ctl?.readyState === 'open') {
        this.sendCtl(peerId, { t: 'watch', on: false });
      }
    }
    this.watchFrames.clear();
  }

  /** 取得 ctl 通道已連線（可監看）的學生機 ID 列表。離線機建了格子也不會有影像。 */
  getConnectedPeerIds(): string[] {
    const result: string[] = [];
    for (const [peerId, link] of this.links) {
      if (link.ctl?.readyState === 'open') result.push(peerId);
    }
    return result;
  }

  /** 取得目前正在監看的 peerId 列表（根據 watchFrames 組裝狀態判斷）。 */
  getWatchingPeerIds(): string[] {
    return [...this.watchFrames.keys()];
  }

  /** 解析 evt 通道收到的監看幀分片 */
  ingestWatchChunk(peerId: string, chunk: ArrayBuffer): void {
    const assembly = this.watchFrames.get(peerId);
    if (!assembly) return;
    const room = assembly.expectedSize - assembly.received;
    if (room <= 0) return;
    const slice = chunk.byteLength > room ? chunk.slice(0, room) : chunk;
    assembly.chunks.push(slice);
    assembly.received += slice.byteLength;
  }

  /** 處理 watch-frame-hdr 訊息 */
  handleWatchFrameHdr(peerId: string, parsed: { seq: number; width: number; height: number; size: number }): void {
    if (parsed.size <= 0 || parsed.size > WATCH_MAX_FRAME_BYTES) return;
    this.watchFrames.set(peerId, {
      seq: parsed.seq,
      width: parsed.width,
      height: parsed.height,
      expectedSize: parsed.size,
      received: 0,
      chunks: [],
    });
  }

  /** 處理 watch-frame-end 訊息 */
  handleWatchFrameEnd(peerId: string, _parsed: { seq: number; ok: boolean }): void {
    const assembly = this.watchFrames.get(peerId);
    this.watchFrames.delete(peerId);
    if (assembly && assembly.received === assembly.expectedSize) {
      const blob = new Blob(assembly.chunks, { type: 'image/jpeg' });
      const url = URL.createObjectURL(blob);
      this.onWatchFrame?.(peerId, {
        url,
        width: assembly.width,
        height: assembly.height,
        seq: assembly.seq,
        blob,
      });
    }
  }
}
