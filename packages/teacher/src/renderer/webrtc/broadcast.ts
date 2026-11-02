import {
  DC_CTL,
  DC_EVT,
  DC_FILE,
  DC_IMG,
  type CtlMessage,
  type DcMessage,
  type ScreenMeta,
  type SfuTransportOptions,
} from '@classroom/protocol';
import { SignalingClient } from '@classroom/protocol/client';
import { ImagePump } from '../image-pump.js';
import type { Link, TeacherSessionOptions, StudentState } from './types.js';
import { findVideoSender, preferVideoCodecs, tuneSender, describe } from './encoding.js';

/** 監看幀的大小上限（防呆：超過 8MB 的「一幀」當然不是真的幀） */
const WATCH_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export class BroadcastManager {
  private readonly options: TeacherSessionOptions;
  private client: SignalingClient | null = null;
  private readonly links = new Map<string, Link>();
  private selfId: string | null = null;
  private localStream: MediaStream | null = null;
  private readonly pump: ImagePump;
  private broadcastTargets: Set<string> | null = null;

  // ── SFU 相關狀態 ──
  private sfuSendTransport: RTCPeerConnection | null = null;
  private sfuSendTransportId: string | null = null;
  private sfuProducer: RTCRtpSender | null = null;

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

  // ─────────────────────────── 連線生命週期 ───────────────────────────

  connect(): void {
    if (this.client) this.client.close();

    // 檢測瀏覽器是否支援 H.264 編碼，若不支援則自動關閉硬體編碼
    if (this.options.hardwareCodec) {
      try {
        const caps = RTCRtpSender.getCapabilities?.('video');
        const hasH264 = caps?.codecs?.some(codec => codec.mimeType?.toLowerCase() === 'video/h264');
        if (!hasH264) {
          this.options.hardwareCodec = false;
          this.options.onLog('warn', '瀏覽器不支援 H.264 編碼，已自動關閉硬體編碼，將使用預設編碼器');
        } else {
          this.options.onLog('info', '偵測到 H.264 硬體編碼支援，已啟用');
        }
      } catch {
        this.options.hardwareCodec = false;
        this.options.onLog('warn', '無法偵測 H.264 編碼支援，已關閉硬體編碼');
      }
    }

    // SFU 模式：連到 SFU 伺服器；其他模式：連到 signaling server
    const signalUrl =
      this.options.broadcastMode === 'sfu'
        ? this.options.sfuServerUrl || this.options.serverUrl
        : this.options.serverUrl;

    this.client = new SignalingClient({
      url: signalUrl,
      hello: {
        t: 'hello',
        role: 'teacher',
        name: this.options.teacherName,
        classId: this.options.classId,
        protocolVersion: 1,
        ...(this.localMeta ? { screen: this.localMeta } : {}),
      },
      onMessage: message => this.handleServerMessage(message),
      onStatus: (status, detail) => {
        this.options.onStatus(status, detail);
        if (status !== 'connected') this.selfId = null;

        // SFU 模式：連線建立後主動建立 send transport
        if (status === 'connected' && this.options.broadcastMode === 'sfu') {
          this.createSfuSendTransport();
        }
      },
    });
    this.client.connect();
    this.startHeartbeat();
  }

  disconnect(): void {
    this.stopHeartbeat();
    this.client?.send({ t: 'bye' });
    this.client?.close();
    this.client = null;
    this.broadcastTargets = null;
    this.watchFrames.clear();

    // 清理 SFU 相關資源
    this.closeSfuResources();

    for (const peerId of [...this.links.keys()]) this.teardownLink(peerId);
    this.links.clear();
    this.selfId = null;
    this.options.onStudentsChanged();
  }

  /** 關閉 SFU 相關資源 */
  private closeSfuResources(): void {
    if (this.sfuProducer) {
      this.sfuProducer.track?.stop();
      this.sfuProducer = null;
    }
    if (this.sfuSendTransport) {
      this.sfuSendTransport.close();
      this.sfuSendTransport = null;
    }
  }

  // ─────────────────────────── SFU 專用方法 ───────────────────────────

  /** 建立 SFU send transport（教師端只需要 send transport） */
  private async createSfuSendTransport(): Promise<void> {
    if (!this.client || this.options.broadcastMode !== 'sfu') return;

    try {
      this.client.send({
        t: 'sfu-create-transport',
        classId: this.options.classId,
        direction: 'send',
      });
    } catch (error) {
      this.options.onLog('error', `建立 SFU send transport 失敗：${describe(error)}`);
    }
  }

  /** 處理 SFU transport 建立回應 */
  private handleSfuTransportCreated(message: { transportId: string; transportOptions: SfuTransportOptions }): void {
    // 儲存 transport ID
    this.sfuSendTransportId = message.transportId;
    this.options.onLog('info', `SFU transport 建立：${message.transportId}`);
  }

  /** 處理 SFU produce 回應 */
  private handleSfuProduced(message: { transportId: string; producerId: string }): void {
    this.options.onLog('info', `SFU producer 建立成功：${message.producerId}`);
  }

  /** 開始 SFU produce（教師端送流到 SFU） */
  private async startSfuProduceInternal(): Promise<void> {
    if (!this.sfuSendTransport || this.sfuProducer || !this.localStream) return;

    const track = this.localStream.getVideoTracks()[0];
    if (!track) return;

    try {
      const sender = this.sfuSendTransport.getSenders().find(s => s.track?.kind === 'video');
      if (!sender) return;

      this.sfuProducer = sender;

      this.client?.send({
        t: 'sfu-produce',
        classId: this.options.classId,
        transportId: this.sfuSendTransportId || '',
        kind: 'video',
        rtpParameters: sender.getParameters(),
        appData: { teacherId: this.selfId },
      });
    } catch (error) {
      this.options.onLog('error', `SFU produce 失敗：${describe(error)}`);
    }
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

    // SFU 模式：透過 SFU send transport 送流
    if (this.options.broadcastMode === 'sfu') {
      if (stream) {
        // 如果已有 SFU transport，直接 produce；否則等待 transport 建立
        if (this.sfuSendTransport) {
          await this.startSfuProduceInternal();
        }
      } else {
        // 停止廣播：關閉 SFU producer
        if (this.sfuProducer) {
          this.sfuProducer.track?.stop();
          this.sfuProducer = null;
        }
        // 通知所有學生停止接收
        for (const peerId of this.links.keys()) {
          this.sendCtl(peerId, { t: 'broadcast', on: false, mode: 'sfu' });
        }
      }
      if (previous && previous !== stream) {
        for (const track of previous.getTracks()) track.stop();
      }
      if (this.client) {
        this.client.send({ t: 'meta', ...(this.localMeta ? { screen: this.localMeta } : {}) });
      }
      return;
    }

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
        const sender = findVideoSender(link.broadcast);
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

  // ─────────────────────────── 廣播連線建立 ───────────────────────────

  private async ensureBroadcastLink(peerId: string): Promise<void> {
    const link = this.links.get(peerId);
    if (!link || !this.client) return;
    if (link.broadcast) return;

    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle', rtcpMuxPolicy: 'require' });
    link.broadcast = pc;
    link.state.broadcastState = 'new';

    // 圖片模式：不建視訊收發器（沒有畫面成本），只有資料通道；
    // 天生沒有「每台一份編碼」的問題。
    if (this.options.broadcastMode !== 'image') {
      const stream = this.localStream;
      const videoTrack = stream?.getVideoTracks()[0] ?? null;
      if (videoTrack && stream) {
        const sender = pc.addTrack(videoTrack, stream);
        await tuneSender(sender, this.options);
      } else {
        // 還沒開始廣播也要先把視訊通道開好。
        // 這條連線同時承載 ctl／evt 資料通道；若等有畫面才建立，
        // 中途開始廣播就得重新協商、中斷畫面。
        // 先掛一個 sendonly 的視訊收發器，之後 replaceTrack 就能直接送畫面，
        // 不需要重新協商。
        const transceiver = pc.addTransceiver('video', { direction: 'sendonly' });
        await tuneSender(transceiver.sender, this.options);
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
    await preferVideoCodecs(pc, this.options);

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
        // 版本與教師機不一致時改用警告色（黃），提醒老師送升級包。
        const name = parsed.studentName || parsed.studentId || '(未知位址)';
        const agent = parsed.agent;
        const teacherVersion = this.options.appVersion;
        if (agent?.build) {
          const buildLocal = `${agent.build.slice(0, 16).replace('T', ' ')}`;
          const mismatched = Boolean(teacherVersion) && agent.version !== teacherVersion;
          if (mismatched) {
            this.options.onLog(
              'warn',
              `${name}（v${agent.version}，build ${buildLocal}）已連線 — ⚠️ 版本與教師機（v${teacherVersion}）不一致，建議送升級包`
            );
          } else {
            this.options.onLog('info', `${name}（v${agent.version}，build ${buildLocal}）已連線`);
          }
        } else {
          this.options.onLog(
            'warn',
            `${name}（v${agent?.version ?? '?'}，舊版未帶 build 標記）已連線 — 版本不明，建議送升級包`
          );
        }
        return;
      }
      if (parsed.t === 'pong') return;
      if (parsed.t === 'clean-result') {
        const name = this.links.get(peerId)?.state.info.name ?? peerId;
        if (parsed.ok) {
          this.options.onLog('info', `${name} 已清理收檔資料夾（${parsed.deleted} 項）`);
        } else {
          this.options.onLog('warn', `${name} 清理收檔資料夾失敗：${parsed.message ?? '未知原因'}`);
        }
        return;
      }
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
        if (parsed.size <= 0 || parsed.size > WATCH_MAX_FRAME_BYTES) return;
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
          // 待機圖落地：通知學生端重取並套用（檔名固定「待機畫面.xxx」）
          if (/^待機畫面\./i.test(parsed.name ?? '')) {
            this.sendCtl(peerId, { t: 'idle-image-applied' });
            this.options.onLog('info', `${link.state.info.name} 待機圖已套用`);
          }
          // 熱更新：若收到的是升級包（檔名含「升級包」的 .zip），通知學生機套用並重啟
          const isUpgradePkg = parsed.name.toLowerCase().endsWith('.zip') && parsed.name.includes('升級包');
          if (isUpgradePkg) {
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

  // ─────────────────────────── 信令處理 ───────────────────────────

  private handleServerMessage(message: { t: string; [key: string]: unknown }): void {
    switch (message.t) {
      case 'welcome': {
        this.selfId = message.self as string;
        this.options.onLog('info', `已加入班級，本機 id = ${this.selfId}`);
        for (const peer of message.peers as any[]) this.upsertPeer(peer);
        this.options.onStudentsChanged();
        // 晚一步加入的教師機可能在學生之後才連上，補送自己的畫面尺寸
        if (this.localMeta) this.client?.send({ t: 'meta', screen: this.localMeta });
        break;
      }
      case 'peer-joined': {
        this.upsertPeer(message.peer);
        this.options.onLog('info', `${(message.peer as any).name} 已加入`);
        break;
      }
      case 'peer-updated': {
        this.upsertPeer(message.peer);
        break;
      }
      case 'peer-left': {
        const peer = this.links.get(message.id as string);
        this.options.onLog('warn', `${peer?.state.info.name ?? message.id} 已離線（${message.reason}）`);
        this.teardownLink(message.id as string);
        this.links.delete(message.id as string);
        this.options.onStudentsChanged();
        break;
      }
      case 'signal': {
        void this.handleSignal(message.from as string, message.payload);
        break;
      }
      // SFU 專用信令
      case 'sfu-transport-created': {
        this.handleSfuTransportCreated(
          message as unknown as { transportId: string; transportOptions: SfuTransportOptions }
        );
        break;
      }
      case 'sfu-produced': {
        this.handleSfuProduced(message as unknown as { transportId: string; producerId: string });
        break;
      }
      default:
        break;
    }
  }

  private upsertPeer(peer: any): void {
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

  private async handleSignal(from: string, payload: any): Promise<void> {
    const link = this.links.get(from);
    if (!link || payload.kind !== 'broadcast') return;

    if ('description' in payload && payload.description.type === 'answer') {
      const pc = link.broadcast;
      if (!pc) return;
      await pc.setRemoteDescription(payload.description);
      for (const candidate of link.pendingBroadcastIce.splice(0)) {
        await pc.addIceCandidate(candidate).catch(() => undefined);
      }
    } else if ('ice' in payload) {
      const pc = link.broadcast;
      if (!pc) return;
      if (pc.remoteDescription) {
        await pc.addIceCandidate(payload.ice).catch(() => undefined);
      } else {
        link.pendingBroadcastIce.push(payload.ice);
      }
    }
  }

  // ─────────────────────────── 公開 API ───────────────────────────

  /** 對外發送控制指令 */
  public sendCtl(peerId: string, message: CtlMessage): void {
    const channel = this.links.get(peerId)?.ctl;
    if (!channel || channel.readyState !== 'open') return;
    channel.send(JSON.stringify(message));
  }

  /** 取得連線集合（供 file-transfer / lock / targets 等模組使用） */
  getLinks(): Map<string, Link> {
    return this.links;
  }

  // 以下為各功能模組需要的存取器
  getClient(): SignalingClient | null {
    return this.client;
  }
  setClient(client: SignalingClient | null) {
    this.client = client;
  }
  getLocalStream(): MediaStream | null {
    return this.localStream;
  }
  setLocalStreamDirect(stream: MediaStream | null) {
    this.localStream = stream;
  }
  getSelfId(): string | null {
    return this.selfId;
  }
  setSelfId(id: string | null) {
    this.selfId = id;
  }
  getPump(): ImagePump {
    return this.pump;
  }
  getBroadcastTargets(): Set<string> | null {
    return this.broadcastTargets;
  }
  setBroadcastTargets(targets: Set<string> | null) {
    this.broadcastTargets = targets;
  }
  getWatchFrames(): Map<string, any> {
    return this.watchFrames;
  }
  getFileRejected(): Map<string, Set<string>> {
    return this.fileRejected;
  }
  getLockOn(): boolean {
    return this.lockOn;
  }
  setLockOn(on: boolean) {
    this.lockOn = on;
  }
  getMuteOn(): boolean {
    return this.muteOn;
  }
  setMuteOn(on: boolean) {
    this.muteOn = on;
  }

  // 心跳
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private lockOn = false;
  private muteOn = false;
  private readonly fileRejected = new Map<string, Set<string>>();

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

  // 需要從外部存取的私有屬性
  private namesOf(ids: string[]): string {
    const names = ids.map(id => this.links.get(id)?.state.info.name ?? id);
    return names.length > 5 ? `${names.slice(0, 5).join('、')} 等 ${names.length} 台` : names.join('、');
  }

  private isBroadcastTarget(peerId: string): boolean {
    return !this.broadcastTargets || this.broadcastTargets.has(peerId);
  }
}
