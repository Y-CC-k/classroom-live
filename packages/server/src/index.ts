import http from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  PROTOCOL_VERSION,
  normalizeMac,
  shortId,
  type ClientMessage,
  type ServerErrorCode,
  type ServerMessage,
  type SfuTransportOptions,
} from '@classroom/protocol';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';
import { getSfuManager } from '@classroom/sfu';

import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { RoomRegistry, type Client } from './room.js';

const config = loadConfig();
const log = createLogger('server');
const registry = new RoomRegistry(config.maxStudentsPerRoom);

// SFU 管理器（延遲啟動，僅當有 SFU 需求時啟動）
let sfuManager: Awaited<ReturnType<typeof import('@classroom/sfu').getSfuManager>> | null = null;

async function getOrStartSfu() {
  if (!sfuManager) {
    sfuManager = getSfuManager();
    await sfuManager.start();
  }
  return sfuManager;
}

/** 連線期間掛在 socket 上的狀態 */
interface Connection {
  id: string;
  client: Client | null;
  /** 來源 IP（IPv4-mapped IPv6 已剝成純 IPv4）；hello 時寫進 client 供一鍵開機用 */
  ip: string;
}

const connections = new Map<WebSocket, Connection>();

// ───────────────────────────── 傳送輔助 ─────────────────────────────

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState !== socket.OPEN) return;
  socket.send(JSON.stringify(message));
}

function sendError(socket: WebSocket, code: ServerErrorCode, message: string): void {
  send(socket, { t: 'error', code, message });
  log.warn(`→ error(${code}) ${message}`);
}

function peerLabel(client: Client | null, fallback: string): string {
  return client ? `${client.name}#${client.id}` : fallback;
}

/** `::ffff:192.168.1.5` → `192.168.1.5`；取不到就回空字串 */
function normalizeIp(raw: string | undefined): string {
  const value = (raw ?? '').trim();
  if (!value) return '';
  return value.startsWith('::ffff:') ? value.slice(7) : value;
}

// ───────────────────────────── 訊息處理 ─────────────────────────────

function handleHello(socket: WebSocket, conn: Connection, message: Extract<ClientMessage, { t: 'hello' }>): void {
  if (conn.client) {
    sendError(socket, 'duplicate-hello', '這個連線已經完成 hello');
    return;
  }
  if (message.protocolVersion !== PROTOCOL_VERSION) {
    sendError(
      socket,
      'protocol-mismatch',
      `協定版本不符：客戶端 ${message.protocolVersion}，伺服器 ${PROTOCOL_VERSION}。請更新軟體。`
    );
    socket.close(4001, 'protocol-mismatch');
    return;
  }
  if (!message.classId || !message.name) {
    sendError(socket, 'bad-message', 'hello 缺少 classId 或 name');
    return;
  }

  const room = registry.obtain(message.classId);
  const client: Client = {
    id: conn.id,
    role: message.role,
    name: message.name.slice(0, 64),
    classId: message.classId,
    joinedAt: Date.now(),
    socket,
    alive: true,
    missCount: 0,
  };
  if (message.screen) client.screen = message.screen;
  if (message.agent) client.agent = message.agent;
  if (conn.ip) client.ip = conn.ip;

  // 一鍵開機（Wake-on-LAN）：學生機在 hello 帶上網卡 MAC，這裡驗過格式
  // （正規化為 aa:bb:cc:dd:ee:ff；全 0／全 f／長度不對一律丟掉）才轉發給教師端，
  // 畢竟後面的喚醒封包是照這個位址打出去的，不能收畸形值。
  const macs = [
    ...(typeof message.mac === 'string' ? [message.mac] : []),
    ...(Array.isArray(message.macs) ? message.macs : []),
  ]
    .map(item => normalizeMac(String(item)))
    .filter((item): item is string => item !== null)
    .filter((item, index, all) => all.indexOf(item) === index)
    .slice(0, 4);
  if (macs.length > 0) client.macs = macs;

  const result = message.role === 'teacher' ? room.addTeacher(client) : room.addStudent(client);
  if (!result.ok) {
    sendError(socket, result.code, result.message);
    socket.close(4003, result.code);
    return;
  }
  conn.client = client;

  // 把被取代的舊連線請走（同一個教師帳號重連的情況）。
  // 注意：room.addTeacher 已經把 room.teacher 指向新連線，
  // 所以這裡不能呼叫 room.remove(evicted)（那個方法會比對 id 而判斷「不是我」），
  // 只需要切斷舊 socket，它的 close 事件會走到 detach，而 detach 會發現
  // room.teacher 已經不是它，因此不會誤刪新連線。
  const evicted = result.evicted;
  if (evicted && evicted.socket !== socket) {
    log.warn(`班級 ${room.id} 的舊教師連線 #${evicted.id} 被新連線 #${client.id} 取代`);
    send(evicted.socket, {
      t: 'error',
      code: 'role-forbidden',
      message: '你的身分已被同一班級的新連線取代（可能是教師機重新開啟）。',
    });
    const evictedState = connections.get(evicted.socket);
    if (evictedState) evictedState.client = null;
    evicted.socket.close(4002, 'superseded');
  }

  send(socket, { t: 'welcome', self: client.id, peers: room.peersExcept(client.id), serverTime: Date.now() });

  // 通知其他人有新成員
  const info = room.toPeerInfo(client);
  for (const other of room.allClients()) {
    if (other.id === client.id) continue;
    send(other.socket, { t: 'peer-joined', peer: info });
  }

  log.info(
    `班級 ${room.id}：${client.role === 'teacher' ? '教師' : '學生'} ${peerLabel(client, '?')} 加入 ` +
      `(目前學生 ${room.students.size} 人)`
  );
}

function handleSignal(socket: WebSocket, conn: Connection, message: Extract<ClientMessage, { t: 'signal' }>): void {
  const client = conn.client;
  if (!client) {
    sendError(socket, 'not-hello', '送出 signal 前必須先 hello');
    return;
  }
  const room = registry.get(client.classId);
  const target = room?.findByPeerId(message.to);
  if (!room || !target) {
    sendError(socket, 'unknown-peer', `找不到對象 ${message.to}`);
    return;
  }
  // 伺服器不理解 SDP 內容，只做轉發。
  // 這樣未來導入 mediasoup 或換成 WebTransport 時，這一層完全不用動。
  send(target.socket, { t: 'signal', from: client.id, payload: message.payload });
}

function handleBroadcast(
  socket: WebSocket,
  conn: Connection,
  message: Extract<ClientMessage, { t: 'broadcast' }>
): void {
  const client = conn.client;
  if (!client) {
    sendError(socket, 'not-hello', '送出 broadcast 前必須先 hello');
    return;
  }
  if (client.role !== 'teacher') {
    sendError(socket, 'role-forbidden', '只有教師可以廣播指令');
    return;
  }
  const room = registry.get(client.classId);
  if (!room) return;

  for (const student of room.allStudents()) {
    send(student.socket, { t: 'broadcast', from: client.id, payload: message.payload });
  }
}

function handleMeta(socket: WebSocket, conn: Connection, message: Extract<ClientMessage, { t: 'meta' }>): void {
  const client = conn.client;
  if (!client) {
    sendError(socket, 'not-hello', '送出 meta 前必須先 hello');
    return;
  }
  if (message.screen) client.screen = message.screen;
  if (message.agent) client.agent = message.agent;

  const room = registry.get(client.classId);
  if (!room) return;
  const info = room.toPeerInfo(client);
  for (const other of room.allClients()) {
    if (other.id === client.id) continue;
    send(other.socket, { t: 'peer-updated', peer: info });
  }
}

// ───────────────────────────── SFU 信令處理 ─────────────────────────────

async function handleSfuCreateTransport(
  socket: WebSocket,
  conn: Connection,
  message: Extract<ClientMessage, { t: 'sfu-create-transport' }>
): Promise<void> {
  const client = conn.client;
  if (!client) {
    sendError(socket, 'not-hello', '送出 sfu-create-transport 前必須先 hello');
    return;
  }
  if (client.role !== 'teacher') {
    sendError(socket, 'role-forbidden', '只有教師可以建立 SFU transport');
    return;
  }

  const sfu = await getOrStartSfu();
  const room = sfu.getRoom(message.classId) ?? (await sfu.getOrCreateRoom(message.classId));

  try {
    const transport = await room.createTransport(message.direction, {
      listenIps: [{ ip: '0.0.0.0', announcedIp: undefined }],
      maxIncomingBitrate: 1500000,
      initialAvailableOutgoingBitrate: 1000000,
    });

    const transportOptions: SfuTransportOptions = {
      id: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
      sctpParameters: transport.sctpParameters,
    };

    send(socket, { t: 'sfu-transport-created', transportId: transport.id, transportOptions });
    log.info(`[SFU] ${message.direction} transport created for class ${message.classId}: ${transport.id}`);
  } catch (error) {
    sendError(socket, 'internal', `建立 SFU transport 失敗：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleSfuConnectTransport(
  socket: WebSocket,
  conn: Connection,
  message: Extract<ClientMessage, { t: 'sfu-connect-transport' }>
): Promise<void> {
  const client = conn.client;
  if (!client) {
    sendError(socket, 'not-hello', '送出 sfu-connect-transport 前必須先 hello');
    return;
  }

  const sfu = await getOrStartSfu();
  const room = sfu.getRoom(message.classId);
  if (!room) {
    sendError(socket, 'sfu-transport-not-found', '找不到班級 SFU room');
    return;
  }

  const transport = room.getTransports?.().get(message.transportId) ?? room.getTransport?.(message.transportId);
  if (!transport) {
    sendError(socket, 'sfu-transport-not-found', '找不到指定的 transport');
    return;
  }

  try {
    await transport.connect({ dtlsParameters: message.dtlsParameters });
    send(socket, { t: 'sfu-transport-connected', transportId: transport.id, dtlsParameters: transport.dtlsParameters });
    log.info(`[SFU] Transport connected: ${message.transportId}`);
  } catch (error) {
    sendError(socket, 'internal', `連接 SFU transport 失敗：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleSfuProduce(
  socket: WebSocket,
  conn: Connection,
  message: Extract<ClientMessage, { t: 'sfu-produce' }>
): Promise<void> {
  const client = conn.client;
  if (!client) {
    sendError(socket, 'not-hello', '送出 sfu-produce 前必須先 hello');
    return;
  }
  if (client.role !== 'teacher') {
    sendError(socket, 'role-forbidden', '只有教師可以產生 SFU producer');
    return;
  }

  const sfu = await getOrStartSfu();
  const room = sfu.getRoom(message.classId);
  if (!room) {
    sendError(socket, 'sfu-transport-not-found', '找不到班級 SFU room');
    return;
  }

  const transport = room.getTransports?.().get(message.transportId);
  if (!transport) {
    sendError(socket, 'sfu-transport-not-found', '找不到指定的 transport');
    return;
  }

  try {
    const producerId = await room.produce(
      message.transportId,
      message.kind,
      message.rtpParameters,
      message.appData ?? {}
    );
    send(socket, { t: 'sfu-produced', transportId: message.transportId, producerId });
    log.info(`[SFU] Producer created: ${producerId} (${message.kind})`);
  } catch (error) {
    sendError(socket, 'internal', `建立 SFU producer 失敗：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function handleSfuConsume(
  socket: WebSocket,
  conn: Connection,
  message: Extract<ClientMessage, { t: 'sfu-consume' }>
): Promise<void> {
  const client = conn.client;
  if (!client) {
    sendError(socket, 'not-hello', '送出 sfu-consume 前必須先 hello');
    return;
  }

  const sfu = await getOrStartSfu();
  const room = sfu.getRoom(message.classId);
  if (!room) {
    sendError(socket, 'sfu-transport-not-found', '找不到班級 SFU room');
    return;
  }

  const transport = room.getTransports?.().get(message.transportId);
  if (!transport) {
    sendError(socket, 'sfu-transport-not-found', '找不到指定的 transport');
    return;
  }

  try {
    const result = await room.consume(
      message.transportId,
      message.producerId,
      message.rtpCapabilities,
      message.appData ?? {}
    );
    send(socket, {
      t: 'sfu-consumed',
      transportId: message.transportId,
      consumerId: result.id,
      producerId: result.producerId,
      kind: result.kind,
      rtpParameters: result.rtpParameters,
      type: result.type,
      producerPaused: result.producerPaused,
    });
    log.info(`[SFU] Consumer created: ${result.id} for producer ${message.producerId}`);
  } catch (error) {
    sendError(
      socket,
      'sfu-cannot-consume',
      `建立 SFU consumer 失敗：${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function detach(socket: WebSocket, reason: string): void {
  const conn = connections.get(socket);
  const client = conn?.client ?? null;
  if (conn) conn.client = null;

  if (!client) return;
  const room = registry.get(client.classId);
  if (!room) return;

  room.remove(client);
  const notice: ServerMessage = { t: 'peer-left', id: client.id, reason };
  for (const other of room.allClients()) {
    send(other.socket, notice);
  }
  log.info(`班級 ${room.id}：${peerLabel(client, client.id)} 離線（${reason}）`);

  if (room.isEmpty) {
    log.info(`班級 ${room.id} 已無成員，等待回收`);
  }
}

// ───────────────────────────── 主流程 ─────────────────────────────

function parse(data: RawData): ClientMessage | null {
  try {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null || typeof (parsed as { t?: unknown }).t !== 'string') {
      return null;
    }
    return parsed as ClientMessage;
  } catch {
    return null;
  }
}

const httpServer = http.createServer((req, res) => {
  // 簡易健康檢查＋班級明細（控台輪詢顯示「教室在線統計」用）
  if (req.url === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(
      JSON.stringify({
        ok: true,
        ...registry.stats(),
        uptime: process.uptime(),
        // 班級明細：每班的教師在線／學生人數（控台列表顯示）
        classrooms: registry.list().map(room => ({
          classId: room.id,
          teacherOnline: room.teacher !== null,
          teacherName: room.teacher?.name ?? '',
          students: room.students.size,
        })),
      })
    );
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  res.end(
    `classroom-live signaling server\n` +
      `protocol v${PROTOCOL_VERSION}\n` +
      `rooms=${registry.stats().rooms} students=${registry.stats().students}\n`
  );
});

const wss = new WebSocketServer({ server: httpServer, maxPayload: 512 * 1024 });

wss.on('connection', (socket, request) => {
  const conn: Connection = { id: shortId(8), client: null, ip: normalizeIp(request.socket.remoteAddress) };
  connections.set(socket, conn);
  log.info(`新連線 #${conn.id} 來自 ${request.socket.remoteAddress ?? '?'}`);

  socket.on('message', async (data: RawData) => {
    const message = parse(data);
    if (!message) {
      sendError(socket, 'bad-message', '無法解析的 JSON 訊息');
      return;
    }

    try {
      switch (message.t) {
        case 'hello':
          handleHello(socket, conn, message);
          break;
        case 'signal':
          handleSignal(socket, conn, message);
          break;
        case 'broadcast':
          handleBroadcast(socket, conn, message);
          break;
        case 'meta':
          handleMeta(socket, conn, message);
          break;
        // SFU 專用訊息
        case 'sfu-create-transport':
          await handleSfuCreateTransport(socket, conn, message);
          break;
        case 'sfu-connect-transport':
          await handleSfuConnectTransport(socket, conn, message);
          break;
        case 'sfu-produce':
          await handleSfuProduce(socket, conn, message);
          break;
        case 'sfu-consume':
          await handleSfuConsume(socket, conn, message);
          break;
        case 'ping':
          send(socket, { t: 'pong', ts: message.ts });
          break;
        case 'bye':
          detach(socket, 'client-bye');
          socket.close(1000, 'bye');
          break;
        default:
          sendError(socket, 'bad-message', `未知的訊息型別`);
      }
    } catch (error) {
      log.error('處理訊息時發生例外', error);
      sendError(socket, 'internal', error instanceof Error ? error.message : String(error));
    }
  });

  socket.on('pong', () => {
    const state = connections.get(socket);
    if (state?.client) {
      state.client.alive = true;
      state.client.missCount = 0;
    }
  });

  socket.on('close', (code, reason) => {
    detach(socket, `close ${code} ${reason.toString() || ''}`.trim());
    connections.delete(socket);
  });

  socket.on('error', error => {
    log.warn(`連線 #${conn.id} 錯誤：${error.message}`);
  });
});

// 心跳：用 WebSocket 協定層的 ping/pong，不需要應用層額外訊息。
const heartbeat = setInterval(() => {
  for (const [socket, conn] of connections) {
    const client = conn.client;
    if (!client) continue;
    if (!client.alive) {
      client.missCount += 1;
      if (client.missCount >= config.heartbeatMissLimit) {
        log.warn(`${peerLabel(client, conn.id)} 心跳逾時，強制斷線`);
        detach(socket, 'heartbeat-timeout');
        socket.terminate();
        connections.delete(socket);
        continue;
      }
    }
    client.alive = false;
    socket.ping();
  }
}, config.heartbeatIntervalMs);

// 回收空房間
const sweeper = setInterval(() => {
  const removed = registry.sweepEmpty(config.emptyRoomTtlMs);
  for (const id of removed) log.info(`回收閒置班級 ${id}`);
}, 60_000);

function shutdown(signal: string): void {
  log.info(`收到 ${signal}，關閉中…`);
  clearInterval(heartbeat);
  clearInterval(sweeper);
  for (const [socket, conn] of connections) {
    if (conn.client) send(socket, { t: 'error', code: 'internal', message: '伺服器關閉中' });
    socket.close(1001, 'server-shutdown');
  }
  wss.close(() => {
    httpServer.close(() => process.exit(0));
  });
  // 保險：5 秒內沒收乾淨就直接結束
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

httpServer.listen(config.port, config.host, () => {
  const address = httpServer.address() as AddressInfo;
  log.info(`教室伺服器已啟動 http://${config.host}:${address.port}`);
  log.info(`健康檢查：http://127.0.0.1:${address.port}/healthz`);
  if (config.host === '0.0.0.0') {
    log.info('提示：學生機請連線到本機的區網 IP（用 ipconfig 查詢），不是 0.0.0.0。');
  }
  log.info(`每班人數上限 ${config.maxStudentsPerRoom}，協定版本 v${PROTOCOL_VERSION}`);
});
