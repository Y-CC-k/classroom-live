import { FILE_CHUNK_SIZE, type CtlMessage, type FileChannelMessage } from '@classroom/protocol';
import type { Link, TeacherSessionOptions } from './types.js';

/** 檔案傳送管理器 */
export class FileTransferManager {
  private readonly options: TeacherSessionOptions;
  private readonly links: Map<string, Link>;
  private readonly broadcastManager: {
    sendCtl: (peerId: string, message: CtlMessage) => void;
    getLinks: () => Map<string, Link>;
  };
  private readonly fileRejected: Map<string, Set<string>>;

  constructor(
    options: TeacherSessionOptions,
    links: Map<string, Link>,
    broadcastManager: { sendCtl: (peerId: string, message: CtlMessage) => void; getLinks: () => Map<string, Link> }
  ) {
    this.options = options;
    this.links = links;
    this.broadcastManager = broadcastManager;
    this.fileRejected = new Map();
  }

  getFileRejected(): Map<string, Set<string>> {
    return this.fileRejected;
  }

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

  /**
   * 更換學生機待機底圖：把圖片以固定檔名「待機畫面.xxx」送出，
   * 學生機落地後存進 userData 並自動套用（取代內建守則海報）。
   * 回傳已開始送出的台數。
   */
  sendIdleImage(file: File): number {
    const ext = (file.name.match(/\.(png|jpe?g|webp)$/i)?.[0] ?? '.png').toLowerCase();
    const renamed = new File([file], `待機畫面${ext}`, { type: file.type });
    let sent = 0;
    for (const [peerId, link] of this.links) {
      if (link.file?.readyState === 'open') {
        void this.deliverFiles(peerId, link.file, [renamed]);
        sent++;
      }
    }
    return sent;
  }

  /** 對單一台送檔（走該台的檔案通道） */
  sendFilesToStudent(peerId: string, files: File[]): boolean {
    const link = this.links.get(peerId);
    const channel = link?.file;
    if (!channel || channel.readyState !== 'open' || files.length === 0) return false;
    void this.deliverFiles(peerId, channel, files);
    return true;
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
}
