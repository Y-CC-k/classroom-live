/**
 * SFU (Selective Forwarding Unit) 核心模組。
 *
 * 基於 mediasoup v3，提供：
 * - Worker 管理（單一 worker，多 CPU 核心可擴充）
 * - Router 管理（每班一個 router，支援多班並行）
 * - Producer/Consumer 生命週期（教師為 producer，學生為 consumer）
 * - 信令介面（供 server 呼叫：createTransport, connectTransport, produce, consume）
 *
 * 架構：
 *   Server (signaling) ──► SFU (media)
 *   教師機 ──produce──► SFU ──consume──► 學生機
 */

import type {
  Router,
  WebRtcTransport,
  Producer,
  Consumer,
  RtpCodecCapability,
  RtpParameters,
  RtpCapabilities,
  MediaKind,
  ConsumerType,
  WorkerLogTag,
} from 'mediasoup/types';
import { EventEmitter } from 'node:events';

export interface SfuConfig {
  /** mediasoup worker 設定 */
  worker: {
    rtcMinPort: number;
    rtcMaxPort: number;
    logLevel: 'debug' | 'warn' | 'error' | 'none';
    logTags: WorkerLogTag[];
  };
  /** Router 媒體編碼能力 */
  router: {
    mediaCodecs: RtpCodecCapability[];
  };
  /** WebRTC transport 設定 */
  webRtcTransport: {
    listenIps: { ip: string; announcedIp?: string }[];
    maxIncomingBitrate: number;
    initialAvailableOutgoingBitrate: number;
  };
}

/** 每個班級對應一個 SFU Room */
export class SfuRoom extends EventEmitter {
  public readonly router: Router;
  private readonly transports = new Map<string, WebRtcTransport>();
  private readonly producers = new Map<string, Producer>();
  private readonly consumers = new Map<string, Consumer>();

  constructor(router: Router) {
    super();
    this.router = router;
  }

  /** 建立 WebRTC transport（教師/學生兩端各建一個） */
  async createTransport(direction: 'send' | 'recv', config: SfuConfig['webRtcTransport']): Promise<WebRtcTransport> {
    const transport = await this.router.createWebRtcTransport({
      listenIps: config.listenIps,
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      initialAvailableOutgoingBitrate: config.initialAvailableOutgoingBitrate,
    });

    if (direction === 'send') {
      // 'produce' event not in TypeScript defs but emitted by mediasoup when client calls produce()
      (transport as any).on(
        'produce',
        async (
          {
            kind,
            rtpParameters,
            appData,
          }: { kind: MediaKind; rtpParameters: RtpParameters; appData: Record<string, unknown> },
          callback: (data: { id: string }) => void,
          errback: (error: Error) => void
        ) => {
          try {
            const producer = await transport.produce({
              kind,
              rtpParameters,
              appData: { ...appData, direction: 'send' },
            });
            this.producers.set(producer.id, producer);
            this.emit('producer-created', producer, appData);
            callback({ id: producer.id });
          } catch (error) {
            errback(error as Error);
          }
        }
      );
    } else {
      // 'consume' event not in TypeScript defs but emitted by mediasoup when client calls consume()
      (transport as any).on(
        'consume',
        async (
          {
            producerId,
            rtpCapabilities,
            appData,
          }: { producerId: string; rtpCapabilities: RtpCapabilities; appData: Record<string, unknown> },
          callback: (data: {
            id: string;
            producerId: string;
            kind: MediaKind;
            rtpParameters: RtpParameters;
            type: ConsumerType;
            producerPaused: boolean;
          }) => void,
          errback: (error: Error) => void
        ) => {
          try {
            if (!this.router.canConsume({ producerId, rtpCapabilities })) {
              throw new Error('cannot consume');
            }
            const producer = this.producers.get(producerId);
            if (!producer) throw new Error('producer not found');

            const consumer = await transport.consume({
              producerId,
              rtpCapabilities,
              paused: false,
              appData: { ...appData, direction: 'recv' },
            });
            this.consumers.set(consumer.id, consumer);
            this.emit('consumer-created', consumer, appData);
            callback({
              id: consumer.id,
              producerId,
              kind: consumer.kind,
              rtpParameters: consumer.rtpParameters,
              type: consumer.type,
              producerPaused: consumer.producerPaused,
            });
          } catch (error) {
            errback(error as Error);
          }
        }
      );
    }

    transport.on('dtlsstatechange', (dtlsState: string) => {
      if (dtlsState === 'closed' || dtlsState === 'failed') {
        transport.close();
        this.transports.delete(transport.id);
      }
    });

    transport.on('@close', () => {
      this.transports.delete(transport.id);
    });

    this.transports.set(transport.id, transport);
    return transport;
  }

  /** 取得所有 transports */
  getTransports(): Map<string, WebRtcTransport> {
    return this.transports;
  }

  /** 取得單一 transport */
  getTransport(transportId: string): WebRtcTransport | undefined {
    return this.transports.get(transportId);
  }

  /** 教師端開始廣播：建立 producer */
  async produce(
    transportId: string,
    kind: MediaKind,
    rtpParameters: RtpParameters,
    appData: Record<string, unknown>
  ): Promise<string> {
    const transport = this.transports.get(transportId);
    if (!transport) throw new Error('transport not found');

    const producer = await transport.produce({ kind, rtpParameters, appData });
    this.producers.set(producer.id, producer);
    this.emit('producer-created', producer, appData);
    return producer.id;
  }

  /** 學生端接收廣播：建立 consumer */
  async consume(
    transportId: string,
    producerId: string,
    rtpCapabilities: RtpCapabilities,
    appData: Record<string, unknown>
  ): Promise<{
    id: string;
    producerId: string;
    kind: MediaKind;
    rtpParameters: RtpParameters;
    type: ConsumerType;
    producerPaused: boolean;
  }> {
    const transport = this.transports.get(transportId);
    if (!transport) throw new Error('transport not found');

    const producer = this.producers.get(producerId);
    if (!producer) throw new Error('producer not found');

    const consumer = await transport.consume({
      producerId,
      rtpCapabilities,
      paused: false,
      appData,
    });
    this.consumers.set(consumer.id, consumer);
    this.emit('consumer-created', consumer, appData);

    return {
      id: consumer.id,
      producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      type: consumer.type,
      producerPaused: consumer.producerPaused,
    };
  }

  /** 關閉 transport */
  closeTransport(transportId: string): void {
    const transport = this.transports.get(transportId);
    if (transport) {
      transport.close();
      this.transports.delete(transportId);
    }
  }

  /** 關閉 producer（教師停止廣播） */
  closeProducer(producerId: string): void {
    const producer = this.producers.get(producerId);
    if (producer) {
      producer.close();
      this.producers.delete(producerId);
      this.emit('producer-closed', producerId);
    }
  }

  /** 關閉 consumer */
  closeConsumer(consumerId: string): void {
    const consumer = this.consumers.get(consumerId);
    if (consumer) {
      consumer.close();
      this.consumers.delete(consumerId);
    }
  }

  /** 取得所有 producer（供新加入學生列出可用流） */
  getProducers(): Array<{ id: string; kind: MediaKind; appData: Record<string, unknown> }> {
    return [...this.producers.values()].map(p => ({
      id: p.id,
      kind: p.kind,
      appData: p.appData,
    }));
  }

  /** 清理房間資源 */
  close(): void {
    for (const transport of this.transports.values()) transport.close();
    for (const producer of this.producers.values()) producer.close();
    for (const consumer of this.consumers.values()) consumer.close();
    this.transports.clear();
    this.producers.clear();
    this.consumers.clear();
    this.router.close();
    this.emit('closed');
  }
}

/** SFU 管理器：管理 worker 與所有房間 */
export class SfuManager {
  private worker: Awaited<ReturnType<typeof import('mediasoup').createWorker>> | null = null;
  private readonly rooms = new Map<string, SfuRoom>();
  private readonly config: SfuConfig;

  constructor(config: SfuConfig) {
    this.config = config;
  }

  /** 啟動 SFU worker */
  async start(): Promise<void> {
    const { createWorker } = await import('mediasoup');
    this.worker = await createWorker({
      logLevel: this.config.worker.logLevel,
      logTags: this.config.worker.logTags,
      rtcMinPort: this.config.worker.rtcMinPort,
      rtcMaxPort: this.config.worker.rtcMaxPort,
    });

    this.worker.on('died', () => {
      console.error('[SFU] Worker died, exiting...');
      process.exit(1);
    });

    console.log('[SFU] Worker started');
  }

  /** 取得或建立班級房間 */
  async getOrCreateRoom(classId: string): Promise<SfuRoom> {
    let room = this.rooms.get(classId);
    if (!room) {
      const router = await this.worker!.createRouter({ mediaCodecs: this.config.router.mediaCodecs });
      room = new SfuRoom(router);
      this.rooms.set(classId, room);
      console.log(`[SFU] Room created: ${classId}`);
    }
    return room;
  }

  /** 取得現有房間 */
  getRoom(classId: string): SfuRoom | undefined {
    return this.rooms.get(classId);
  }

  /** 移除房間（班級結束） */
  removeRoom(classId: string): boolean {
    const room = this.rooms.get(classId);
    if (room) {
      room.close();
      this.rooms.delete(classId);
      console.log(`[SFU] Room removed: ${classId}`);
      return true;
    }
    return false;
  }

  /** 關閉所有資源 */
  async close(): Promise<void> {
    for (const room of this.rooms.values()) room.close();
    this.rooms.clear();
    if (this.worker) {
      await this.worker.close();
      this.worker = null;
    }
  }
}

/** 建立預設 SFU 設定 */
export function createDefaultSfuConfig(): SfuConfig {
  return {
    worker: {
      rtcMinPort: 40000,
      rtcMaxPort: 40100,
      logLevel: 'warn',
      logTags: ['info', 'ice', 'dtls', 'rtp', 'srtp', 'rtcp'] as WorkerLogTag[],
    },
    router: {
      mediaCodecs: [
        // H.264 (硬體編碼優先)
        {
          kind: 'video',
          mimeType: 'video/H264',
          clockRate: 90000,
          preferredPayloadType: 100,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42e01f',
            'level-asymmetry-allowed': 1,
          },
        },
        {
          kind: 'video',
          mimeType: 'video/H264',
          clockRate: 90000,
          preferredPayloadType: 101,
          parameters: {
            'packetization-mode': 1,
            'profile-level-id': '42001f',
            'level-asymmetry-allowed': 1,
          },
        },
        // VP8 (fallback)
        {
          kind: 'video',
          mimeType: 'video/VP8',
          clockRate: 90000,
          preferredPayloadType: 96,
        },
        // Opus 音訊
        {
          kind: 'audio',
          mimeType: 'audio/opus',
          clockRate: 48000,
          channels: 2,
          preferredPayloadType: 97,
        },
      ],
    },
    webRtcTransport: {
      listenIps: [{ ip: '0.0.0.0', announcedIp: undefined }],
      maxIncomingBitrate: 1500000,
      initialAvailableOutgoingBitrate: 1000000,
    },
  };
}

/** 單例 SFU 管理器（供 server 使用） */
let sfuManagerInstance: SfuManager | null = null;

export function getSfuManager(config?: SfuConfig): SfuManager {
  if (!sfuManagerInstance) {
    sfuManagerInstance = new SfuManager(config ?? createDefaultSfuConfig());
  }
  return sfuManagerInstance;
}

export async function startSfu(config?: SfuConfig): Promise<SfuManager> {
  const manager = getSfuManager(config);
  await manager.start();
  return manager;
}

export async function stopSfu(): Promise<void> {
  if (sfuManagerInstance) {
    await sfuManagerInstance.close();
    sfuManagerInstance = null;
  }
}
