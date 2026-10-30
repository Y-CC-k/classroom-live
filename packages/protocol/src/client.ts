import type { ClientMessage, ServerMessage } from './signaling.js';

/**
 * 兩端（教師機、學生機）共用的信令連線封裝。
 *
 * 這裡只依賴標準的 `WebSocket` 全域物件（瀏覽器與 Node 22+ 皆有），
 * 因此可以直接被 renderer 打包使用，不需要 electron 的任何 API。
 */

export type SignalingStatus = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'closed';

export interface SignalingClientOptions {
  url: string;
  /** 連線成功後自動送出的 hello 訊息 */
  hello: Extract<ClientMessage, { t: 'hello' }>;
  onMessage(message: ServerMessage): void;
  onStatus?(status: SignalingStatus, detail?: string): void;
  /** 重連起始延遲，預設 1000ms */
  baseRetryMs?: number;
  /** 重連上限延遲，預設 15000ms */
  maxRetryMs?: number;
  /** 應用層 ping 間隔，預設 10s（用來量測來回延遲） */
  pingIntervalMs?: number;
}

export class SignalingClient {
  private socket: WebSocket | null = null;
  private status: SignalingStatus = 'idle';
  private retryDelay: number;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closedByUser = false;
  private lastLatencyMs = 0;

  constructor(private readonly options: SignalingClientOptions) {
    this.retryDelay = options.baseRetryMs ?? 1000;
  }

  get currentStatus(): SignalingStatus {
    return this.status;
  }

  /** 最近一次 ping 的來回延遲（毫秒），可用於教室網路品質顯示 */
  get latencyMs(): number {
    return this.lastLatencyMs;
  }

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  /** 送訊息。回傳 false 表示目前沒有連線 */
  send(message: ClientMessage): boolean {
    if (!this.socket || this.socket.readyState !== 1 /* OPEN */) return false;
    this.socket.send(JSON.stringify(message));
    return true;
  }

  /** 主動關閉，不會自動重連 */
  close(): void {
    this.closedByUser = true;
    this.clearTimers();
    this.setStatus('closed');
    this.socket?.close(1000, 'client-close');
    this.socket = null;
  }

  private setStatus(status: SignalingStatus, detail?: string): void {
    if (this.status === status && detail === undefined) return;
    this.status = status;
    this.options.onStatus?.(status, detail);
  }

  private clearTimers(): void {
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private open(): void {
    if (this.closedByUser) return;

    this.setStatus(this.retryDelay === (this.options.baseRetryMs ?? 1000) ? 'connecting' : 'reconnecting');

    let socket: WebSocket;
    try {
      socket = new WebSocket(this.options.url);
    } catch (error) {
      this.scheduleRetry(error instanceof Error ? error.message : String(error));
      return;
    }
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.retryDelay = this.options.baseRetryMs ?? 1000;
      this.setStatus('connected');
      // hello 必須是第一個送出的訊息，伺服器會用它來決定角色與班級。
      this.send(this.options.hello);
      this.startPing();
    });

    socket.addEventListener('message', event => {
      let parsed: ServerMessage;
      try {
        parsed = JSON.parse(String(event.data)) as ServerMessage;
      } catch {
        return;
      }
      if (parsed.t === 'pong') {
        this.lastLatencyMs = Date.now() - parsed.ts;
        return;
      }
      try {
        this.options.onMessage(parsed);
      } catch (error) {
        // 個別訊息處理失敗不應該讓整條連線掛掉
        console.error('[signaling] 處理訊息時發生例外', error, parsed);
      }
    });

    socket.addEventListener('close', event => {
      this.clearTimers();
      if (this.closedByUser) {
        this.setStatus('closed');
        return;
      }
      this.scheduleRetry(`連線關閉（code ${event.code}）`);
    });

    socket.addEventListener('error', () => {
      // close 事件一定會跟在 error 之後，重連邏輯統一在 close 處理即可。
    });
  }

  private scheduleRetry(reason: string): void {
    if (this.closedByUser) return;
    this.socket = null;
    this.setStatus('reconnecting', reason);

    const maxDelay = this.options.maxRetryMs ?? 15000;
    const delay = this.retryDelay;
    // 指數退避 + 抖動，避免整間教室的學生機同時重連打爆伺服器。
    this.retryDelay = Math.min(maxDelay, Math.round(delay * 1.8 + Math.random() * 300));

    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.open();
    }, delay);
  }

  private startPing(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    const interval = this.options.pingIntervalMs ?? 10_000;
    this.pingTimer = setInterval(() => {
      this.send({ t: 'ping', ts: Date.now() });
    }, interval);
  }
}
