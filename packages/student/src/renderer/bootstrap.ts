import {
  DC_CTL,
  DC_EVT,
  DC_FILE,
  DC_IMG,
  FILE_CHUNK_SIZE,
  PROTOCOL_VERSION,
  normalizeClassId,
  tuneReceiver,
  type BroadcastMode,
  type ClientMessage,
  type DcMessage,
  type EvtMessage,
  type FileChannelMessage,
  type ImgChannelMessage,
  type PeerInfo,
  type ServerMessage,
  type SignalPayload,
} from '@classroom/protocol';
import { SignalingClient } from '@classroom/protocol/client';

import type { HostCommand, StudentConfig } from '../shared/ipc.js';

type HelloMessage = Extract<ClientMessage, { t: 'hello' }>;

/**
 * 學生機 renderer。
 *
 * 職責分工刻意切得很乾淨：
 *   renderer  → 網路（WebRTC / 信令）、畫面顯示、UI
 *   主行程    → 原生模組狀態、系統層操作（靜音、關瀏覽器、視窗控制）
 *
 * 這個版本以「接收廣播」為主；螢幕回傳給教師只剩**低頻監看**
 * （教師按「👁 監看」才啟動，3 秒一張 JPEG）、
 * 鍵鼠接管、緊急解鎖熱鍵已整組移除。
 */

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`找不到 DOM 節點 #${id}`);
  return element as T;
};

const els = {
  broadcast: $<HTMLVideoElement>('broadcast'),
  broadcastImg: $<HTMLImageElement>('broadcast-img'),
  idle: $<HTMLDivElement>('idle'),
  bannerDot: $<HTMLSpanElement>('banner-dot'),
  bannerText: $<HTMLSpanElement>('banner-text'),
  bannerClass: $<HTMLSpanElement>('banner-class'),
  idleTitle: $<HTMLHeadingElement>('idle-title'),
  idleText: $<HTMLParagraphElement>('idle-text'),
  idleRules: $<HTMLImageElement>('idle-rules'),
  btnDiscover: $<HTMLButtonElement>('btn-discover'),
  discoverResults: $<HTMLDivElement>('discover-results'),
  boardLayer: $<HTMLDivElement>('board-layer'),
  boardCanvas: $<HTMLCanvasElement>('board-canvas'),

  settings: $<HTMLElement>('settings'),
  serverUrl: $<HTMLInputElement>('server-url'),
  classId: $<HTMLInputElement>('class-id'),
  studentName: $<HTMLInputElement>('student-name'),
  saveDir: $<HTMLInputElement>('save-dir'),
  btnChooseDir: $<HTMLButtonElement>('btn-choose-dir'),
  autoConnect: $<HTMLInputElement>('auto-connect'),
  autoFullscreen: $<HTMLInputElement>('auto-fullscreen'),
  autoStart: $<HTMLInputElement>('auto-start'),
  btnConnect: $<HTMLButtonElement>('btn-connect'),
  btnCloseSettings: $<HTMLButtonElement>('btn-close-settings'),
  btnGear: $<HTMLButtonElement>('btn-gear'),
  btnMenu: $<HTMLButtonElement>('btn-menu'),
  menu: $<HTMLDivElement>('menu'),
  log: $<HTMLUListElement>('log'),
};

// ───────────────────────────── 狀態 ─────────────────────────────

let config: StudentConfig;
let client: SignalingClient | null = null;
let broadcastPc: RTCPeerConnection | null = null;
let ctl: RTCDataChannel | null = null;
let evt: RTCDataChannel | null = null;
/**
 * evt 通道還沒 open 時暫存的訊息；通道一通就補送。
 * evt-hello 在 ctl 通道 open 的瞬間送出，但 evt 是另一條 channel、
 * 常常還沒 open——不排隊的話 hello（和其他第一時間的回報）會無聲丟掉。
 */
let evtQueue: string[] = [];
let fileCtl: RTCDataChannel | null = null;
let imgCtl: RTCDataChannel | null = null;

/**
 * 教師機檔案傳送：目前進行中的一個檔案。
 * 教師端對同一條通道是逐檔序列化送出（meta → 內容分片 → end），
 * 所以通道上同時只會有一個活動檔案，分片不需要帶編號。
 */
let incomingFile: { id: string; name: string; size: number } | null = null;
let teacherId: string | null = null;
/** 本工作階段是否曾成功連上伺服器（自動搜尋只對「從未連上」觸發） */
let everConnected = false;
/** 原生注入模組是否載入成功（遠端接管前置條件） */
let nativeReadyFlag = false;
let selfId: string | null = null;
let pendingIce: RTCIceCandidateInit[] = [];
let appVersion = '0.0.0';
/** 版本戳（打包時間）；升級後教師機記錄一眼看出機器跑哪一版 */
let buildStamp: string | null = null;
let platformInfo = '';
let hasShownBroadcast = false;
/** 目前教師是否在廣播中（鎖定解除時要依此決定是否恢復廣播強制模式） */
let broadcastActive = false;
/** 目前廣播走哪條路：video = 視訊軌；image = 圖片通道逐張；sfu = SFU consume */
let broadcastMode: BroadcastMode = 'video';
/** 本機是否被教師端鎖定鍵盤滑鼠（心跳逾時自動解除用） */
let inputLocked = false;
/** 教師是否要求本機持續靜音（心跳逾時自動解除用） */
let muteActive = false;
/** 最近一次收到教師心跳（ping）的時間；0 = 這輪還沒收到過 */
let lastPingAt = 0;

// ───────────────────────────── SFU 相關狀態 ─────────────────────────────
/** SFU recv transport（學生端從 SFU 接收流） */
let sfuRecvTransport: RTCPeerConnection | null = null;
/** SFU consumer（學生端從 SFU 接收教師流） */
let sfuConsumer: RTCRtpReceiver | null = null;

// ───────────────────────────── 小工具 ─────────────────────────────

function log(level: 'info' | 'warn' | 'error', message: string): void {
  const item = document.createElement('li');
  item.className = level;
  item.textContent = `[${new Date().toLocaleTimeString('zh-TW', { hour12: false })}] ${message}`;
  els.log.prepend(item);
  while (els.log.childElementCount > 200) els.log.lastElementChild?.remove();
}

/** 重取自訂待機底圖（教師端送來的待機畫面.xxx）；無則保持內建守則海報 */
async function refreshIdleImage(): Promise<void> {
  try {
    const dataUrl = await window.studentApi.getIdleImage();
    if (dataUrl) {
      els.idleRules.src = dataUrl;
      els.idleRules.hidden = false;
    }
  } catch {
    /* 讀不到就維持內建海報 */
  }
}

function setBanner(text: string, kind: 'idle' | 'ok' | 'warn' | 'err'): void {
  els.bannerText.textContent = text;
  els.bannerDot.className = `dot${kind === 'idle' ? '' : kind === 'ok' ? ' on' : ` ${kind}`}`;
}

// ───────────────────────────── 連線 ─────────────────────────────

async function buildHello(): Promise<HelloMessage> {
  // 原生模組已移除：不再回報 screen／agent（教師端也不會再使用）
  // 一鍵開機用：把網卡 MAC 一併帶上，伺服器驗過後轉發給教師端建名單
  let mac: string | undefined;
  let macs: string[] | undefined;
  try {
    const info = await window.studentApi.networkInfo();
    mac = info.mac || undefined;
    macs = info.macs.length ? info.macs : undefined;
  } catch {
    // 抓不到 MAC 不該影響正常連線（舊環境或權限奇怪也能照常上課）
  }

  return {
    t: 'hello',
    role: 'student',
    name: config.studentName,
    classId: config.classId,
    protocolVersion: PROTOCOL_VERSION,
    mac,
    macs,
  };
}

async function connect(): Promise<void> {
  if (client) {
    disconnect();
    return;
  }

  const classId = normalizeClassId(els.classId.value);
  if (!classId) {
    log('error', '班級代碼必須是 6 位數字，例如 123-456');
    els.classId.focus();
    return;
  }
  els.classId.value = classId;

  config = await window.studentApi.saveConfig({
    serverUrl: els.serverUrl.value.trim(),
    classId,
    autoConnect: els.autoConnect.checked,
    autoFullscreen: els.autoFullscreen.checked,
    autoStart: els.autoStart.checked,
  });
  // 名稱由主行程決定（固定為本機 IP），這裡只是把結果顯示回唯讀欄位。
  els.studentName.value = config.studentName;
  void refreshIdleImage();
  // 開機初始畫面：教師端可遠端更換（存 config，每次開機顯示）
  if (config.idleTitle || config.idleText) {
    setIdle(config.idleTitle || '教室直播', config.idleText || '尚未連線到教師機');
  }

  const hello = await buildHello();

  // SFU 模式：連到 SFU 伺服器；其他模式：連到 signaling server
  const signalUrl = broadcastMode === 'sfu' ? config.sfuServerUrl || config.serverUrl : config.serverUrl;

  client = new SignalingClient({
    url: signalUrl,
    hello,
    onMessage: message => handleServerMessage(message),
    onStatus: (status, detail) => {
      switch (status) {
        case 'connected':
          everConnected = true;
          setBanner('已連線，等待教師廣播…', 'ok');
          setIdle('教室直播', '已連線，等待教師廣播…');

          // SFU 模式：連線建立後建立 recv transport
          if (broadcastMode === 'sfu') {
            createSfuRecvTransport();
          }
          break;
        case 'connecting':
          setBanner('連線中…', 'warn');
          break;
        case 'reconnecting':
          setBanner(`重新連線中（${detail ?? ''}）`, 'warn');
          break;
        default:
          setBanner('已中斷', 'idle');
      }
    },
  });

  client.connect();
  els.btnConnect.textContent = '斷線';

  // 初次進入連不上：10 秒後仍未連上且從未連成過 → 自動搜尋區網伺服器
  const thisClient = client;
  setTimeout(() => {
    if (client === thisClient && !everConnected) {
      void runDiscover(true);
    }
  }, 10_000);
  els.bannerClass.textContent = config.classId;
  log('info', `連線到 ${signalUrl}，班級 ${config.classId}`);
}

/**
 * UDP 廣播搜尋區網中的教室伺服器。
 * 結果以按鈕清單呈現；點選即填入位址、儲存設定並重新連線。
 */
async function runDiscover(auto: boolean) {
  if (client) return;
  els.discoverResults.replaceChildren();
  els.discoverResults.hidden = false;
  setBanner(auto ? '連不上伺服器，搜尋區網…' : '搜尋區網伺服器…', 'warn');
  let found: { wsUrl: string }[] = [];
  try {
    found = await window.studentApi.discoverServers(2000);
  } catch (error) {
    log('warn', `搜尋失敗：${error instanceof Error ? error.message : String(error)}`);
  }
  if (found.length === 0) {
    setBanner(auto ? '區網找不到伺服器' : '找不到伺服器', 'err');
    log('warn', '區網搜尋找不到任何伺服器；請確認教師機/伺服器已啟動且同一網段。');
    return;
  }
  for (const s of found) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn ghost discover-btn';
    btn.textContent = `✓ 使用 ${s.wsUrl}（儲存並連線）`;
    btn.addEventListener('click', async () => {
      await window.studentApi.saveConfig({ serverUrl: s.wsUrl });
      els.serverUrl.value = s.wsUrl;
      log('info', `已儲存伺服器位址：${s.wsUrl}，重新連線…`);
      els.discoverResults.replaceChildren();
      els.discoverResults.hidden = true;
      if (client) disconnect();
      void connect();
    });
    els.discoverResults.append(btn);
  }
  setBanner(`找到 ${found.length} 台伺服器，請選擇`, 'warn');
  log('info', '區網搜尋找到 ' + found.length + ' 台伺服器，請在清單點選要使用的位址。');
}

function disconnect(): void {
  client?.send({ t: 'bye' });
  client?.close();
  client = null;
  closeBroadcast();
  closeSfuResources();
  els.btnConnect.textContent = '連線';
  els.bannerClass.textContent = '';
  setBanner('未連線', 'idle');
  els.broadcast.hidden = true;
  setIdle('教室直播', '尚未連線到教師機');
  els.idle.classList.remove('hidden');
  hasShownBroadcast = false;
}

/** 關閉 SFU 相關資源 */
function closeSfuResources(): void {
  if (sfuConsumer) {
    sfuConsumer.track?.stop();
    sfuConsumer = null;
  }
  if (sfuRecvTransport) {
    sfuRecvTransport.close();
    sfuRecvTransport = null;
  }
}

/** 建立 SFU recv transport（學生端從 SFU 接收流） */
async function createSfuRecvTransport(): Promise<void> {
  if (!client || !config.sfuServerUrl) return;

  try {
    client.send({
      t: 'sfu-create-transport',
      classId: config.classId,
      direction: 'recv',
    });
  } catch (error) {
    log('error', `建立 SFU recv transport 失敗：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 處理 SFU transport 建立回應 */
function handleSfuTransportCreated(message: { transportId: string; transportOptions: any }): void {
  const { transportId } = message;
  const logPrefix = '[SFU recv]';

  // 建立本地 RTCPeerConnection 連接到 SFU
  const pc = new RTCPeerConnection({
    iceServers: [],
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
  });

  // SFU 的 dtlsParameters 在 transportOptions 中
  const dtlsParams = message.transportOptions?.dtlsParameters;
  if (dtlsParams) {
    pc.setRemoteDescription({
      type: 'offer',
      sdp: dtlsParams.sdp || '',
    }).catch(err => {
      log('error', `${logPrefix} setRemoteDescription 失敗：${err instanceof Error ? err.message : String(err)}`);
    });
  }

  pc.onicecandidate = event => {
    if (!event.candidate || !client) return;

    client.send({
      t: 'sfu-connect-transport',
      classId: config.classId,
      transportId,
      dtlsParameters: event.candidate.toJSON(),
    });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      log('warn', 'SFU recv transport 連線失敗');
      closeSfuResources();
    }
  };

  sfuRecvTransport = pc;
  log('info', `SFU recv transport 建立：${transportId}`);
}

/** 處理 SFU consumer 建立回應 */
function handleSfuConsumed(message: {
  transportId: string;
  consumerId: string;
  producerId: string;
  kind: 'video' | 'audio';
  rtpParameters: any;
  type: string;
  producerPaused: boolean;
}): void {
  log('info', `SFU consumer 建立成功：${message.consumerId} (producer: ${message.producerId})`);

  // 設定本地視訊元素顯示遠端流
  if (message.rtpParameters?.encodings?.[0]) {
    // 建立一個遠端媒體流連接到 broadcast video 元素
    const remoteStream = new MediaStream();
    const track = new MediaStreamTrack();
    remoteStream.addTrack(track);
    els.broadcast.srcObject = remoteStream;
    void els.broadcast.play().catch(() => undefined);
  }

  broadcastMode = 'sfu';
  broadcastActive = true;
  els.idle.classList.add('hidden');
  els.broadcast.hidden = false;

  void window.studentApi.showWindow();

  if (!hasShownBroadcast) {
    hasShownBroadcast = true;
    log('info', '已收到教師廣播（SFU 模式）');
    if (config.autoFullscreen) void window.studentApi.setFullscreen(true);
  }
}

/** 處理 SFU producer 關閉 */
function handleSfuProducerClosed(message: { producerId: string }): void {
  log('warn', `教師端 SFU producer 關閉：${message.producerId}`);

  // 停止本地 consumer
  if (sfuConsumer) {
    sfuConsumer.track?.stop();
    sfuConsumer = null;
  }

  // 清除畫面
  showBroadcast(false, broadcastMode);
}

// ───────────────────────────── 信令處理 ─────────────────────────────

function handleServerMessage(message: ServerMessage): void {
  switch (message.t) {
    case 'welcome': {
      selfId = message.self;
      log('info', `已加入班級，本機 id = ${selfId}`);
      trackPeers(message.peers);
      break;
    }
    case 'peer-joined':
      trackPeers([message.peer]);
      break;
    case 'peer-updated':
      trackPeers([message.peer]);
      break;
    case 'peer-left':
      if (message.id === teacherId) {
        log('warn', '教師機已離線');
        teacherId = null;
        closeBroadcast();
        setBanner('教師機已離線', 'warn');
        els.idle.classList.remove('hidden');
        els.broadcast.srcObject = null;
        hasShownBroadcast = false;
        broadcastActive = false;
        void window.studentApi.setInputLock(false);
        void window.studentApi.setBroadcastMode(false);
      }
      break;
    case 'signal':
      void handleSignal(message.from, message.payload);
      break;
    case 'error':
      log('error', `伺服器：${message.message}`);
      break;
    // SFU 專用信令
    case 'sfu-transport-created': {
      handleSfuTransportCreated(message);
      break;
    }
    case 'sfu-consumed': {
      handleSfuConsumed(message);
      break;
    }
    case 'sfu-producer-closed': {
      handleSfuProducerClosed(message);
      break;
    }
    default:
      break;
  }
}

function trackPeers(peers: PeerInfo[]): void {
  for (const peer of peers) {
    if (peer.role === 'teacher') {
      if (teacherId !== peer.id) {
        const wasOffline = teacherId === null;
        teacherId = peer.id;
        log('info', `教師機 ${peer.name} 已就緒`);
        // 老師重新上線時要把橫幅從「教師機已離線」復原，
        // 否則畫面明明已經在播，橫幅卻還寫著離線。
        if (wasOffline) setBanner('已連線，等待教師廣播…', 'ok');
      }
    }
  }
}

async function handleSignal(from: string, payload: SignalPayload): Promise<void> {
  if (payload.kind !== 'broadcast') return;
  // 教師是 offerer
  if ('description' in payload && payload.description.type === 'offer') {
    await acceptBroadcast(payload.description as RTCSessionDescriptionInit);
  } else if ('ice' in payload) {
    if (!broadcastPc) return;
    const candidate = payload.ice as RTCIceCandidateInit;
    if (broadcastPc.remoteDescription) {
      await broadcastPc.addIceCandidate(candidate).catch(() => undefined);
    } else {
      pendingIce.push(candidate);
    }
  }
}

/** 設定待機畫面（沒有廣播時顯示的文字） */
/** base64 → bytes（示範幀 ctl 下行用） */
function b64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** 示範幀 ctl 下行的組幀桶 */
let demoB64: { seq: number; total: number; width: number; height: number; parts: Map<number, string> } | null = null;

function setIdle(title: string, text: string): void {
  els.idleTitle.textContent = title;
  els.idleText.textContent = text;
}

/**
 * 顯示／清除教師的廣播畫面。
 *
 * 停止廣播時只把視訊元素藏起來（保留 `srcObject`）：
 * 教師重新開始廣播時，同一條視訊軌會繼續送訊框，不需要重新協商，
 * 畫面幾十毫秒內就回來了。
 */
function showBroadcast(on: boolean, mode: BroadcastMode = broadcastMode): void {
  broadcastMode = mode;
  els.broadcast.hidden = !(on && mode === 'video');
  // 圖片模式：教師機一張一張送 JPEG，img 元素負責顯示
  els.broadcastImg.hidden = !(on && mode === 'image');
  els.idle.classList.toggle('hidden', on);

  if (!on) {
    // 畫面清乾淨：圖片模式要撤掉最後一張 JPEG（video 保留 srcObject），
    // 學生不能停下廣播後還看著上張圖以為老師還在播。
    els.broadcastImg.removeAttribute('src');
    imgFirstFrameLogged = false;
    // 分清楚兩種「沒有畫面」：
    //   1. 上課中老師按了停止 → 要講清楚是「停止了」
    //   2. 一連上就還沒開始廣播 → 只是還沒開始，講「已停止」會讓學生一頭霧水
    if (hasShownBroadcast) setIdle('教師已停止廣播', '等待老師再次開始廣播…');
    else setIdle('教室直播', '已連線，等待教師廣播…');
    return;
  }

  setIdle('教室直播', '已連線，等待教師廣播…');
  void els.broadcast.play().catch(() => undefined);
  // 開始廣播：若本機先前被（教師的「收攏」或學生自己）縮到系統匣／最小化，
  // 這裡要把接收視窗拉回前景，不然學生會以為老師在播、自己卻看不到。
  void window.studentApi.showWindow();

  if (!hasShownBroadcast) {
    hasShownBroadcast = true;
    log('info', mode === 'image' ? '已收到教師廣播（圖片模式）' : '已收到教師廣播畫面');
    if (config.autoFullscreen) void window.studentApi.setFullscreen(true);
  }
}

async function acceptBroadcast(description: RTCSessionDescriptionInit): Promise<void> {
  closeBroadcast();
  pendingIce = [];

  const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: 'max-bundle' });
  broadcastPc = pc;

  pc.ontrack = event => {
    // 降低接收端緩衝：不然秒差會疊上瀏覽器自適應的幾百毫秒（見 protocol/latency.ts）
    tuneReceiver(event.transceiver);
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    els.broadcast.srcObject = stream;
    // 注意：這裡不能直接顯示畫面。廣播連線在上課開始就建立了，
    // 即使老師還沒開始廣播也會收到 ontrack（只是完全沒有訊框）。
    // 要不要顯示一律以教師端送來的 broadcast 指令為準。
    log('info', '已與教師機建立廣播連線');
  };

  // 資料通道由教師端建立，這裡是被動接收。
  pc.ondatachannel = event => {
    const channel = event.channel;
    if (channel.label === DC_CTL) {
      ctl = channel;
      channel.onmessage = message => handleControl(message.data);
      channel.onopen = () => {
        log('info', '控制通道已連線');
        sendEvt({
          t: 'evt-hello',
          studentId: selfId ?? '',
          studentName: config.studentName,
          screen: { width: 0, height: 0, x: 0, y: 0, scaleFactor: 1, monitors: 1 },
          agent: {
            version: appVersion,
            build: buildStamp ?? undefined,
            elevated: false,
            nativeReady: nativeReadyFlag,
            os: platformInfo,
          },
          ts: Date.now(),
        });
      };
      channel.onclose = () => {
        ctl = null;
        // 監看的回傳通道也走 evt：教師端斷了就整組停掉
        stopWatch('line-lost');
        setBanner('已中斷連線', 'warn');
        // 控制通道斷了就不會再有「解除鎖定」指令：立刻還原輸入，
        // 否則教師機關機／重啟後這台會一直被鎖著。
        void window.studentApi.setInputLock(false);
      };
    } else if (channel.label === DC_EVT) {
      evt = channel;
      // 下行的示範幀是裸二進位：必須收成 ArrayBuffer（預設 blob 會讓幀被丟棄）
      channel.binaryType = 'arraybuffer';
      // 遠端建立後可能已 open（也可能還在 connecting）：兩種都要能補送
      if (channel.readyState === 'open') flushEvtQueue();
      else channel.onopen = flushEvtQueue;
      channel.onclose = () => {
        // 學生示範下行：示範者畫面幀（JSON hdr → 裸分片 → JSON end）
        channel.onmessage = message => {
          if (!evtDownlinkSeen) {
            evtDownlinkSeen = true;
            log('info', '[demo] evt 通道下行啟用（收到第一條訊息）');
          }
          if (message.data instanceof ArrayBuffer) {
            if (demoIncoming) {
              demoIncoming.chunks.push(new Uint8Array(message.data));
              demoIncoming.received += message.data.byteLength;
            }
            return;
          }
          let parsed: { t: string; seq?: number; width?: number; height?: number; size?: number };
          try {
            parsed = JSON.parse(String(message.data));
          } catch {
            return;
          }
          if (parsed.t === 'demo-frame-hdr') {
            demoIncoming = {
              seq: Number(parsed.seq) || 0,
              width: Number(parsed.width) || 0,
              height: Number(parsed.height) || 0,
              size: Number(parsed.size) || 0,
              chunks: [],
              received: 0,
            };
          } else if (parsed.t === 'demo-frame-end') {
            if (!demoIncoming) return;
            try {
              const merged = new Uint8Array(demoIncoming.size);
              let off = 0;
              for (const chunk of demoIncoming.chunks) {
                merged.set(chunk, off);
                off += chunk.byteLength;
              }
              const blob = new Blob([merged.buffer as ArrayBuffer], { type: 'image/jpeg' });
              const url = URL.createObjectURL(blob);
              if (lastImgUrl) URL.revokeObjectURL(lastImgUrl);
              lastImgUrl = url;
              els.broadcastImg.src = url;
              if (!imgFirstFrameLogged) {
                imgFirstFrameLogged = true;
                log('info', '[demo] 收到第一張示範畫面（' + Math.round(blob.size / 1024) + ' KB）');
              }
            } catch (error) {
              log('warn', '示範畫面組幀失敗：' + (error instanceof Error ? error.message : String(error)));
            }
            demoIncoming = null;
          }
        };
        evt = null;
        evtQueue = [];
        demoIncoming = null; // 斷線後的舊訊息一律作廢，新連線會重新送 hello
      };
    } else if (channel.label === DC_FILE) {
      fileCtl = channel;
      // 內容分片要拿得到 ArrayBuffer；預設的 blob 型別在 IPC 傳遞上難處理
      channel.binaryType = 'arraybuffer';
      // 逐則序列化處理：meta 對應的 fileBegin 在主行程註冊完成前，
      // chunks／end 不准插隊——不然小檔案可能在「Begin 尚未落地」時
      // 就送出 fileEnd，被判成「沒有對應的傳送作業」。
      let fileQueue: Promise<void> = Promise.resolve();
      channel.onmessage = message => {
        fileQueue = fileQueue
          .then(() => handleFileChannel(message.data))
          .catch(error => log('warn', `檔案處理錯誤：${error instanceof Error ? error.message : String(error)}`));
      };
      channel.onclose = () => {
        fileCtl = null;
      };
    } else if (channel.label === DC_IMG) {
      imgCtl = channel;
      channel.binaryType = 'arraybuffer';
      channel.onopen = () => log('info', '圖片廣播通道已就緒');
      // 與檔案通道相同的序列化處理：hdr → 分片 → end，
      // 教師端逐張送，通道上同時只有一張圖。
      let imgQueue: Promise<void> = Promise.resolve();
      channel.onmessage = message => {
        if (!imgChannelSeen) {
          imgChannelSeen = true;
          log('info', '[demo] img 通道開始收到訊息（img 下行實證）');
        }
        imgQueue = imgQueue
          .then(() => handleImgChannel(message.data))
          .catch(error => log('warn', `圖片處理錯誤：${error instanceof Error ? error.message : String(error)}`));
      };
      channel.onclose = () => {
        imgCtl = null;
      };
    }
  };

  pc.onicecandidate = event => {
    if (!event.candidate || !teacherId) return;
    client?.send({ t: 'signal', to: teacherId, payload: { kind: 'broadcast', ice: event.candidate.toJSON() } });
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      log('warn', `與教師機的廣播連線中斷（${pc.connectionState}）`);
    }
  };

  await pc.setRemoteDescription(description);
  for (const candidate of pendingIce.splice(0)) {
    await pc.addIceCandidate(candidate).catch(() => undefined);
  }

  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  if (teacherId) {
    client?.send({
      t: 'signal',
      to: teacherId,
      payload: { kind: 'broadcast', description: { type: 'answer', sdp: answer.sdp } },
    });
  }
}

function closeBroadcast(): void {
  try {
    ctl?.close();
    evt?.close();
    fileCtl?.close();
    imgCtl?.close();
    broadcastPc?.close();
  } catch {
    // 忽略
  }
  ctl = null;
  evt = null;
  evtQueue = []; // 作廢所有未送的 evt 訊息，重連時會重新走完整 hello 流程
  fileCtl = null;
  imgCtl = null;
  incomingFile = null;
  incomingImg = null;
  els.broadcastImg.removeAttribute('src');
  broadcastPc = null;
  pendingIce = [];

  // 清理 SFU 資源
  closeSfuResources();
}

/**
 * 教師圖片廣播：目前接收中的一張 JPEG。
 * 通道上同時只有一張圖（教師端逐張序列化送出），分片不需要帶編號。
 */
let incomingImg: { size: number; chunks: Uint8Array[]; received: number } | null = null;
let lastImgUrl: string | null = null;
let imgFirstFrameLogged = false;
/** 學生示範下行組幀桶（evt 通道） */
let evtDownlinkSeen = false;
let demoIncoming: {
  seq: number;
  width: number;
  height: number;
  size: number;
  chunks: Uint8Array[];
  received: number;
} | null = null;
let imgChannelSeen = false;

/** 圖片通道：hdr(JSON) → JPEG 裸分片 → end(JSON)。end 一到就組起來顯示。 */
async function handleImgChannel(data: unknown): Promise<void> {
  if (typeof data === 'string') {
    let message: ImgChannelMessage;
    try {
      message = JSON.parse(data) as ImgChannelMessage;
    } catch {
      return;
    }
    if (message.t === 'img-hdr') {
      incomingImg = { size: message.size, chunks: [], received: 0 };
      return;
    }
    // img-end：把這張 JPEG 組起來換 URL 顯示
    const pending = incomingImg;
    incomingImg = null;
    if (!pending || pending.received === 0) return;
    const merged = new Uint8Array(pending.received);
    let offset = 0;
    for (const chunk of pending.chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const blob = new Blob([merged], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    if (lastImgUrl) URL.revokeObjectURL(lastImgUrl);
    lastImgUrl = url;
    els.broadcastImg.src = url;
    if (!imgFirstFrameLogged) {
      imgFirstFrameLogged = true;
      log('info', '[demo] 收到第一張畫面（' + Math.round(blob.size / 1024) + ' KB），顯示中');
    }
    return;
  }
  // 二進位分片
  if (incomingImg && data instanceof ArrayBuffer) {
    incomingImg.chunks.push(new Uint8Array(data));
    incomingImg.received += data.byteLength;
  }
}

// ───────────────────────────── 控制指令 ─────────────────────────────

// ───────── 教師端「👁 監看」：本機螢幕低頻 JPEG 回傳 ─────────
//
// 教師按下監看後，這裡每 intervalMs 送一張：
//   evt 通道上的信封 = watch-frame-hdr（JSON）→ 裸分片（ArrayBuffer）
//   → watch-frame-end（JSON），與檔案／圖片通道同一套格式。
// 張數等級刻意「3 秒一張」：純監看不需要流暢度，頻寬壓到每台
// 約 30～70 KB/s，同時全程有畫面（不是只送一張就停）。

/** 監看幀的寬度上限（教師端 480px 顯示窗足夠清楚，也省頻寬） */
/* 960 寬：監控牆格子僅 200-300px、單台監看窗 760px，960 已足夠且大幅省頻寬
   （1600 時 29 台 x 3s ≈ 14 Mbps；960 時每張約剩 36%，僅 ~3 Mbps） */
const WATCH_MAX_WIDTH = 960;
/** 監看幀 JPEG 品質：文字要能對答案，取中等偏上 */
const WATCH_QUALITY = 0.62;

interface WatchState {
  stream: MediaStream;
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  timer: ReturnType<typeof setInterval>;
  /** 已送出的幀序號（從 1 開始） */
  seq: number;
  /** 上一次抽照還沒跑完就先跳過（避免疊張堆積） */
  busy: boolean;
}

/** 教師監看中的送圖狀態；null = 沒有在監看 */
let watchState: WatchState | null = null;

async function startWatch(intervalMs: number): Promise<void> {
  stopWatch('restart');
  const source = await window.studentApi.getScreenSource();
  if ('error' in source) {
    log('warn', `監看無法啟動：${source.error}`);
    return;
  }
  try {
    // 與教師端廣播同款約束：desktopCapturer 的 screen: 來源配
    // chromeMediaSource: 'desktop' 的舊式約束（不跳系統選擇視窗）。
    const constraints = {
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'desktop',
          chromeMediaSourceId: source.id,
          maxFrameRate: 2,
          maxWidth: WATCH_MAX_WIDTH,
          maxHeight: 1000,
        },
      },
    } as unknown as MediaStreamConstraints;
    const stream = await navigator.mediaDevices.getUserMedia(constraints);

    // 影片要「在 composition 管線裡」才持續出幀：同廣播泵的 8px 牆角做法。
    const video = document.createElement('video');
    video.muted = true;
    video.autoplay = true;
    video.playsInline = true;
    video.style.cssText =
      'position:fixed;left:0;top:0;width:8px;height:8px;opacity:0.01;z-index:-1;pointer-events:none;';
    document.body.append(video);
    video.srcObject = stream;
    await video.play().catch(() => undefined);

    watchState = {
      stream,
      video,
      canvas: document.createElement('canvas'),
      timer: setInterval(() => void sendWatchFrame(), intervalMs),
      seq: 0,
      busy: false,
    };
    log('info', `老師正在監看本機螢幕（每 ${Math.round(intervalMs / 1000)} 秒更新一張）；教師端關閉監看就會停止。`);
  } catch (error) {
    log('warn', `監看無法啟動：${error instanceof Error ? error.message : String(error)}`);
  }
}

/** 送一幀：hdr → 64KB 分片 → end。通道斷了就整個停掉監看。 */
async function sendWatchFrame(): Promise<void> {
  const state = watchState;
  if (!state || state.busy) return;
  state.busy = true;
  try {
    if (!evt || evt.readyState !== 'open') {
      stopWatch('line-lost');
      return;
    }
    const video = state.video;
    if (video.readyState < 2 || video.videoWidth === 0) return;

    const scale = Math.min(1, WATCH_MAX_WIDTH / video.videoWidth);
    state.canvas.width = Math.round(video.videoWidth * scale);
    state.canvas.height = Math.round(video.videoHeight * scale);
    const ctx = state.canvas.getContext('2d');
    if (!ctx) return;
    ctx.drawImage(video, 0, 0, state.canvas.width, state.canvas.height);
    const blob = await new Promise<Blob | null>(resolve => {
      state.canvas.toBlob(resolve, 'image/jpeg', WATCH_QUALITY);
    });
    if (!blob || blob.size === 0) return;
    const buffer = await blob.arrayBuffer();

    const seq = ++state.seq;
    evt.send(
      JSON.stringify({
        t: 'watch-frame-hdr',
        seq,
        width: state.canvas.width,
        height: state.canvas.height,
        size: buffer.byteLength,
      })
    );
    for (let offset = 0; offset < buffer.byteLength; offset += FILE_CHUNK_SIZE) {
      evt.send(buffer.slice(offset, Math.min(offset + FILE_CHUNK_SIZE, buffer.byteLength)));
    }
    evt.send(JSON.stringify({ t: 'watch-frame-end', seq, ok: true }));
  } catch (error) {
    log('warn', `監看送圖失敗：${error instanceof Error ? error.message : String(error)}`);
  } finally {
    state.busy = false;
  }
}

/** 停止監看：放掉擷取（停止後 Chrome 的螢幕分享指示也會消失） */
function stopWatch(reason: 'teacher-stopped' | 'line-lost' | 'restart'): void {
  const state = watchState;
  if (!state) return;
  watchState = null;
  clearInterval(state.timer);
  for (const track of state.stream.getVideoTracks()) track.stop();
  state.video.srcObject = null;
  state.video.remove();
  if (reason === 'line-lost') log('warn', '控制通道已斷線，停止監看。');
}

interface PenStroke {
  color: string;
  width: number;
  points: { x: number; y: number }[];
}

// ── 獨立電子白板（board-mode）：與教師端 16:9 邏輯比例 contain 對齊 ──
let boardStrokes: PenStroke[] = [];
let boardCurrent: PenStroke | null = null;
let boardLast: { x: number; y: number } = { x: 0, y: 0 };

function boardBox(): { drawW: number; drawH: number; ox: number; oy: number } {
  const rect = els.boardCanvas.getBoundingClientRect();
  const srcAr = 16 / 9;
  const boxAr = rect.width / Math.max(1, rect.height);
  if (srcAr > boxAr) {
    const drawH = rect.width / srcAr;
    return { drawW: rect.width, drawH, ox: 0, oy: (rect.height - drawH) / 2 };
  }
  const drawW = rect.height * srcAr;
  return { drawW, drawH: rect.height, ox: (rect.width - drawW) / 2, oy: 0 };
}

function boardFit(): void {
  const rect = els.boardCanvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width * (window.devicePixelRatio || 1)));
  const h = Math.max(1, Math.round(rect.height * (window.devicePixelRatio || 1)));
  if (els.boardCanvas.width !== w || els.boardCanvas.height !== h) {
    els.boardCanvas.width = w;
    els.boardCanvas.height = h;
    boardRedraw();
  }
}

function boardSegment(
  from: { x: number; y: number },
  to: { x: number; y: number },
  color: string,
  width: number
): void {
  const ctx = els.boardCanvas.getContext('2d');
  if (!ctx) return;
  boardFit();
  const scale = window.devicePixelRatio || 1;
  const { drawW, drawH, ox, oy } = boardBox();
  if (color === 'eraser') {
    // 橡皮擦：挖掉已畫內容；筆寬放大 3 倍才擦得乾淨
    ctx.globalCompositeOperation = 'destination-out';
    ctx.lineWidth = Math.max(1, width * 3 * scale);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo((ox + from.x * drawW) * scale, (oy + from.y * drawH) * scale);
    ctx.lineTo((ox + to.x * drawW) * scale, (oy + to.y * drawH) * scale);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    return;
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1, width * scale);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo((ox + from.x * drawW) * scale, (oy + from.y * drawH) * scale);
  ctx.lineTo((ox + to.x * drawW) * scale, (oy + to.y * drawH) * scale);
  ctx.stroke();
}

function boardRedraw(): void {
  const ctx = els.boardCanvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, els.boardCanvas.width, els.boardCanvas.height);
  for (const stroke of boardStrokes) {
    for (let i = 1; i < stroke.points.length; i++) {
      boardSegment(stroke.points[i - 1]!, stroke.points[i]!, stroke.color, stroke.width);
    }
    if (stroke.points.length === 1) {
      boardSegment(stroke.points[0]!, stroke.points[0]!, stroke.color, stroke.width);
    }
  }
}

function boardClear(): void {
  boardStrokes = [];
  boardCurrent = null;
  els.boardCanvas.getContext('2d')?.clearRect(0, 0, els.boardCanvas.width, els.boardCanvas.height);
}

function sendEvt(message: EvtMessage): void {
  const data = JSON.stringify(message);
  if (!evt || evt.readyState !== 'open') {
    // 通道未通：先排隊，evt.onopen 時補送（以前是直接丟掉 → hello 每次蒸發）
    evtQueue.push(data);
    return;
  }
  evt.send(data);
}

/** 通道一通就把排隊的訊息依序補送；送不出來（通道又斷了）就靜默放棄 */
function flushEvtQueue(): void {
  if (!evt || evt.readyState !== 'open') return;
  const pending = evtQueue;
  evtQueue = [];
  for (const data of pending) {
    try {
      evt.send(data);
    } catch {
      // 通道狀態又變了就算了（外層會整線重連）
    }
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * 教師機檔案傳送通道：
 *   meta（JSON）→ 內容分片（ArrayBuffer，逐片轉交主行程寫盤）→ end（JSON）
 * 結束後經 evt 通道回報 file-result，教師端的事件記錄即可看到每台的結果。
 */
async function handleFileChannel(raw: unknown): Promise<void> {
  // 分片是裸二進位；JSON 控制訊息是字串
  if (typeof raw !== 'string') {
    const chunk = raw instanceof ArrayBuffer ? raw : null;
    if (chunk && incomingFile) {
      window.studentApi.fileChunk(incomingFile.id, chunk);
    } else if (chunk) {
      log('warn', '收到檔案分片，但沒有對應的檔案資訊（已丟棄）');
    }
    return;
  }

  let message: FileChannelMessage;
  try {
    message = JSON.parse(raw) as FileChannelMessage;
  } catch {
    return;
  }

  if (message.t === 'file-meta') {
    if (incomingFile) {
      // 上一個檔案沒收到 end 就來了新的：把舊的交還主行程標記為中斷
      void window.studentApi.fileEnd(incomingFile.id);
    }
    incomingFile = { id: message.id, name: message.name, size: message.size };
    const begun = await window.studentApi.fileBegin(message.id, message.name, message.size);
    if ('path' in begun) {
      log('info', `老師送來檔案 ${message.name}（${formatBytes(message.size)}）`);
      if (begun.fallbackFrom) {
        log(
          'warn',
          `設定的收檔資料夾（${begun.fallbackFrom}）不可寫，本機改存「${begun.usedDir}」；請檢查該資料夾權限，或請老師把收檔資料夾設到可寫的位置`
        );
      }
    } else {
      incomingFile = null;
      sendEvt({
        t: 'file-result',
        id: message.id,
        name: message.name,
        ok: false,
        message: begun.error,
      });
      log('warn', `無法接收檔案 ${message.name}：${begun.error}`);
    }
    return;
  }

  if (message.t === 'file-end') {
    const file = incomingFile;
    if (!file || file.id !== message.id) return;
    incomingFile = null;
    const result = await window.studentApi.fileEnd(message.id);
    sendEvt({
      t: 'file-result',
      id: file.id,
      name: file.name,
      ok: result.ok,
      path: result.path ?? undefined,
      message: result.message,
    });
    if (result.ok) {
      log('info', `檔案已儲存到 ${result.path}`);
    } else {
      log('warn', `檔案接收失敗：${result.message ?? '未知原因'}`);
    }
  }
}

async function handleControl(raw: unknown): Promise<void> {
  let message: DcMessage;
  try {
    message = JSON.parse(String(raw)) as DcMessage;
  } catch {
    return;
  }

  switch (message.t) {
    case 'ping':
      lastPingAt = Date.now(); // 心跳：教師當機保護要看這個
      sendEvt({ t: 'pong', ts: message.ts });
      break;

    case 'ctl-hello':
      log('info', `教師 ${message.teacherName} 已連上控制通道`);
      break;

    case 'broadcast': {
      // 教師開始／停止廣播。
      // 停止時一定要立刻清屏，否則學生機會停在最後一格畫面，
      // 看起來像老師還在播（學生就會一直盯著不會動的畫面）。
      // 舊版教師機不會帶 mode → 視為 video，行為跟以前完全一樣。
      const on = Boolean(message.on);
      log('info', '[demo] 廣播指令 on=' + on + ' mode=' + (message.mode ?? 'video'));
      showBroadcast(on, message.mode ?? 'video');
      // 廣播強制模式：置頂＋全螢幕（靜音／關網頁已改為教師端獨立按鍵）
      broadcastActive = on;
      void window.studentApi.setBroadcastMode(on);
      break;
    }

    case 'idle-screen': {
      // 老師遠端更換待機（開機初始）畫面：立即套用並持久化
      const title = String(message.title ?? '')
        .trim()
        .slice(0, 32);
      const text = String(message.text ?? '')
        .trim()
        .slice(0, 200);
      log('info', `老師已更新待機畫面：${title || '（無標題）'}`);
      void window.studentApi.saveConfig({ idleTitle: title, idleText: text });
      // 未廣播時才立即套用顯示（廣播中套了也看不見）
      void refreshIdleImage();
      if (!broadcastActive) {
        setIdle(title || '教室直播', text || '已連線，等待教師廣播…');
      }
      break;
    }

    case 'board-mode': {
      // 教師開／關獨立電子白板：進入時清空筆跡（開新板）
      els.boardLayer.hidden = !message.on;
      if (message.on) boardClear();
      // 白板必須全螢幕：教師端筆跡座標以全螢幕為基準，學生機視窗化時比例會錯位
      try {
        await window.studentApi.setFullscreen(Boolean(message.on));
      } catch (error) {
        log('warn', '白板全螢幕設定失敗：' + (error instanceof Error ? error.message : String(error)));
      }
      // 關閉白板且非廣播中 → 退出全螢幕還原桌面；廣播中交由強制全螢幕接手
      if (!message.on && !broadcastActive) {
        try {
          await window.studentApi.setFullscreen(false);
        } catch {
          // 忽略：退不出全螢幕不影響上課
        }
      }
      log('info', message.on ? '老師開啟了電子白板（已切換全螢幕）' : '老師關閉了電子白板');
      break;
    }

    case 'board-pen': {
      const pt = {
        x: Math.min(1, Math.max(0, Number(message.x) || 0)),
        y: Math.min(1, Math.max(0, Number(message.y) || 0)),
      };
      const color = String(message.color ?? '#111111');
      const width = Number(message.width) || 8;
      if (message.op === 'down') {
        boardCurrent = { color, width, points: [pt] };
        boardLast = pt;
        boardSegment(pt, pt, color, width);
      } else if (message.op === 'move' && boardCurrent) {
        boardSegment(boardLast, pt, boardCurrent.color, boardCurrent.width);
        boardCurrent.points.push(pt);
        boardLast = pt;
      } else if (message.op === 'up') {
        if (boardCurrent) {
          boardCurrent.points.push(pt);
          boardStrokes.push(boardCurrent);
          boardCurrent = null;
        }
      }
      break;
    }

    case 'board-clear':
      boardClear();
      break;

    case 'board-undo':
      boardStrokes.pop();
      boardRedraw();
      break;

    case 'mode': {
      log('info', message.mode === 'control' ? '老師已接管本機鍵鼠（指導模式）' : '控制模式：' + message.mode);
      break;
    }

    case 'mouse-move':
    case 'mouse-button':
    case 'mouse-wheel':
    case 'key':
    case 'text': {
      // 遠端接管：轉發原生注入（未載入時靜默略過，避免高頻 log）
      const m = message as {
        x?: number;
        y?: number;
        button?: string;
        down?: boolean;
        dy?: number;
        vk?: number;
        text?: string;
      };
      void window.studentApi.nativeInject({
        kind:
          'mouse-move' === message.t
            ? 'mouse-move'
            : 'mouse-button' === message.t
              ? 'mouse-button'
              : 'mouse-wheel' === message.t
                ? 'mouse-wheel'
                : 'key' === message.t
                  ? 'key'
                  : 'text',
        x: Number(m.x ?? 0),
        y: Number(m.y ?? 0),
        button: String(m.button ?? 'left'),
        down: m.down !== false,
        dy: Number(m.dy ?? 0),
        vk: Number(m.vk ?? 0),
        text: String(m.text ?? ''),
      });
      break;
    }

    case 'clean-files': {
      // 老師要求清空收檔資料夾（下課收操用）
      log('info', '老師要求清理收檔資料夾');
      const result = await window.studentApi.cleanFileDir();
      sendEvt({
        t: 'clean-result',
        ok: result.ok,
        deleted: result.deleted,
        message: result.message,
      });
      log(result.ok ? 'info' : 'warn', result.message ?? `已清理 ${result.deleted} 項`);
      break;
    }

    case 'idle-image-applied':
      // 老師送來的新待機圖已落地：重取並套用
      void refreshIdleImage();
      break;

    case 'watch': {
      // 教師按「👁 監看」：本機螢幕以低頻 JPEG 回傳給教師（3 秒一張等級）。
      // 跟廣播／鎖定完全獨立；教師關掉監看或控制通道斷線就停止。
      const on = Boolean(message.on);
      if (on) {
        await startWatch(Number(message.intervalMs) || 3000);
      } else {
        log('info', '老師停止監看本機');
        stopWatch('teacher-stopped');
      }
      break;
    }

    case 'minimize': {
      log('info', message.on ? '收到最小化指令' : '收到還原視窗指令');
      if (message.on) {
        window.studentApi.hideToTray();
      } else {
        window.studentApi.showWindow();
      }
      break;
    }

    case 'fullscreen': {
      log('info', message.on ? '收到全螢幕指令' : '收到離開全螢幕指令');
      await window.studentApi.setFullscreen(Boolean(message.on));
      break;
    }

    case 'open-url': {
      const url = String(message.url ?? '').trim();
      if (!url) break;
      // 廣播進行中學生機會持續關閉瀏覽器；此時老師多半想讓學生離開廣播去看網站，
      // 仍然照開——若真的要關瀏覽器，老師停止廣播即可。
      log('info', `老師要求開啟網站：${url}`);
      const ok = await window.studentApi.openUrl(url);
      if (!ok) log('warn', '無法開啟網站（網址格式不支援）');
      break;
    }

    case 'demo-frame-begin': {
      demoB64 = {
        seq: Number(message.seq) || 0,
        total: Number(message.total) || 0,
        width: Number(message.width) || 0,
        height: Number(message.height) || 0,
        parts: new Map(),
      };
      setBanner('📡 正在接收示範畫面…', 'ok');
      break;
    }
    case 'demo-chunk': {
      if (demoB64 && Number(message.seq) === demoB64.seq) {
        demoB64.parts.set(Number(message.part) || 0, String(message.b64 ?? ''));
      }
      break;
    }
    case 'demo-frame-end': {
      if (demoB64 && Number(message.seq) === demoB64.seq) {
        try {
          let b64 = '';
          for (let p = 0; p < demoB64.total; p++) b64 += demoB64.parts.get(p) ?? '';
          const bytes = b64ToBytes(b64);
          const blob = new Blob([bytes.buffer as ArrayBuffer], { type: 'image/jpeg' });
          const url = URL.createObjectURL(blob);
          if (lastImgUrl) URL.revokeObjectURL(lastImgUrl);
          lastImgUrl = url;
          els.broadcastImg.src = url;
          if (!imgFirstFrameLogged) {
            imgFirstFrameLogged = true;
            log('info', '[demo/ctl] 收到第一張示範畫面（' + Math.round(blob.size / 1024) + ' KB）');
          }
        } catch (error) {
          log('warn', '示範畫面組幀失敗：' + (error instanceof Error ? error.message : String(error)));
        }
        demoB64 = null;
      }
      break;
    }
    case 'lock': {
      // 鎖定／解除鍵盤滑鼠（課堂秩序）。
      // 畫面刻意不動：正在廣播就繼續廣播（強制模式照常），沒在廣播就維持原畫面；
      // 這裡只封輸入，完全不碰 broadcast enforcement。
      const on = Boolean(message.on);
      inputLocked = on; // 心跳逾時自解時要知道本機是否還被鎖
      log(on ? 'info' : 'info', on ? '老師已鎖定本機鍵盤滑鼠' : '老師解除鎖定');
      setBanner(
        on ? '🔒 本機已鎖定（鍵盤滑鼠暫時無法操作）' : broadcastActive ? '已解除鎖定' : '已連線，等待教師廣播…',
        on ? 'warn' : 'ok'
      );
      try {
        const locked = await window.studentApi.setInputLock(on);
        if (locked !== on) log('warn', on ? '鎖定登記失敗，輸入未被封鎖' : '解除登記異常');
      } catch (error) {
        log('warn', '鎖定指令執行失敗：' + (error instanceof Error ? error.message : String(error)));
      }
      break;
    }

    case 'mute': {
      // 教師端獨立「靜音」指令（與廣播開關脫鉤；持續維持由主行程的迴圈作）
      const on = Boolean(message.on);
      muteActive = on; // 心跳逾時自解時要把靜音一併還原
      log(on ? 'info' : 'info', on ? '老師已將本機靜音（持續維持）' : '老師解除靜音');
      await window.studentApi.setMuted(on);
      break;
    }

    case 'close-browsers': {
      // 教師端獨立「關閉學生網頁」指令：一次關掉 Chrome／Edge
      log('info', '老師要求關閉 Chrome／Edge');
      await window.studentApi.closeBrowsers();
      break;
    }

    case 'apply-update': {
      log('warn', '老師要求套用更新（本機即將重啟）');
      try {
        const result = await window.studentApi.applyUpdate();
        if (!result.ok) {
          log('warn', `無法套用更新：${result.reason ?? '未知原因'}`);
        }
        // 無論套用中或被擋下，都回報教師機（不再無聲）
        sendEvt({
          t: 'update-result',
          ok: result.ok,
          stage: result.ok ? 'apply' : 'rejected',
          message: result.ok ? '解壓成功，本機即將重啟上新版' : result.reason,
        });
      } catch {
        // 主行程 relaunch+exit 後 IPC 回應拿不到是預期路徑之一；重啟後重連會帶回新 build 標記
        try {
          sendEvt({ t: 'update-result', ok: true, stage: 'restarting', message: '已開始套用（本機重啟中）' });
        } catch {
          /* 通道也斷就算了 */
        }
        log('info', '套用中：本機即將重啟上新版');
      }
      break;
    }

    case 'exec': {
      // 教師端「執行程式」：啟動本機上已存在的檔案。
      // 給教師機維護用途（跟「⬆ 升級全班」同一家族）。
      const target = String(message.path ?? '').trim();
      const args = Array.isArray(message.args) ? message.args.map(item => String(item)) : [];
      log('info', `教師要求執行：${target}${args.length ? ` (${args.join(' ')})` : ''}`);
      const result = await window.studentApi.execProgram(target, args);
      if (!result.ok) log('warn', `無法執行（${result.message ?? '未知原因'}）`);
      break;
    }

    case 'shutdown': {
      // 教師要求關機：改走 Windows 原生排程（30 秒），App 就算被結束也照樣關。
      // delaySec < 0＝取消已排定的關機。
      const delay = Number.isFinite(message.delaySec) ? Math.round(message.delaySec) : 30;
      if (delay < 0) {
        log('info', '老師取消了關機');
        await window.studentApi.requestShutdown(-1);
      } else {
        const delaySec = delay >= 0 ? delay : 30;
        log('warn', `老師要求這台電腦在 ${delaySec} 秒後關機（Windows 會顯示倒數提示）`);
        await window.studentApi.requestShutdown(delaySec);
      }
      break;
    }

    case 'uwf': {
      // 教師端「開機還原（UWF）」遙控：初始化／安裝／查狀態／維護開關／移除／加排除區。
      // 執行走 ProgramData 的 SYSTEM 排程任務（初始化時跳一次 UAC）；
      // 結果回報教師（evt 通道 uwf-result）。本端不自動重開機——教師端用「重開機全班」控制。
      const action = String(message.action ?? '');
      const exclPath = typeof message.path === 'string' ? message.path : undefined;
      log('info', `老師要求 UWF 動作：${action}${exclPath ? `（${exclPath}）` : ''}`);
      const result = await window.studentApi.uwfAction(
        action as 'setup' | 'install' | 'status' | 'maint-on' | 'maint-off' | 'remove' | 'set-exclusion',
        exclPath
      );
      log(result.ok ? 'info' : 'warn', `UWF：${result.text}`);
      sendEvt({ t: 'uwf-result', ok: result.ok, text: result.text, rebooting: result.rebooting });
      break;
    }

    case 'reboot': {
      // 教師端「重開機全班」：delaySec < 0＝取消已排定的重開/關機。
      const delay = Number.isFinite(message.delaySec) ? Math.round(message.delaySec) : 10;
      if (delay < 0) {
        log('info', '老師取消了重開/關機排程');
        await window.studentApi.requestReboot(-1);
      } else {
        log('warn', `老師要求這台電腦在 ${delay} 秒後重開機`);
        await window.studentApi.requestReboot(delay);
      }
      break;
    }

    default:
      break;
  }
}

// ───────────────────────────── 視窗內選單（☰）─────────────────────────────

/**
 * 托盤選單的另一個入口。
 *
 * 托盤圖示在 Windows 11 預設會被收進「隱藏的圖示」，學生看不到也就按不到；
 * 視窗內的 ☰ 一定要有一個看得到的出口，否則學生遇到狀況只能重開機。
 */
function toggleMenu(open: boolean): void {
  els.menu.hidden = !open;
  els.btnMenu.setAttribute('aria-expanded', String(open));
}

async function runMenuCommand(command: string): Promise<void> {
  toggleMenu(false);
  switch (command) {
    case 'reconnect':
      disconnect();
      await connect();
      break;
    case 'toggle-fullscreen':
      await window.studentApi.setFullscreen(!document.fullscreenElement);
      break;
    case 'settings':
      openSettings();
      break;
    case 'hide-to-tray':
      log('info', '已縮到系統匣；要再打開請啟動桌面上的「教室直播 — 學生機」捷徑。');
      window.studentApi.hideToTray();
      break;
    case 'quit':
      window.studentApi.quitApp();
      break;
    default:
      break;
  }
}

// ───────────────────────────── 設定面板 ─────────────────────────────

function openSettings(): void {
  els.settings.hidden = false;
}

function bindEvents(): void {
  els.btnGear.addEventListener('click', () => {
    els.settings.hidden = !els.settings.hidden;
  });

  els.btnCloseSettings.addEventListener('click', () => {
    els.settings.hidden = true;
  });

  els.btnMenu.addEventListener('click', event => {
    event.stopPropagation();
    toggleMenu(els.menu.hidden);
  });

  els.menu.addEventListener('click', event => {
    const button = (event.target as HTMLElement).closest('button[data-command]');
    if (!button) return;
    void runMenuCommand((button as HTMLButtonElement).dataset.command ?? '');
  });

  // 點畫面上其他地方就把選單收起來。
  document.addEventListener('click', () => {
    if (!els.menu.hidden) toggleMenu(false);
  });

  els.btnConnect.addEventListener('click', () => {
    void connect();
  });

  for (const input of [els.autoConnect, els.autoFullscreen, els.autoStart]) {
    input.addEventListener('change', () => {
      config = {
        ...config,
        autoConnect: els.autoConnect.checked,
        autoFullscreen: els.autoFullscreen.checked,
        autoStart: els.autoStart.checked,
      };
      void window.studentApi.saveConfig(config);
    });
  }

  // 收檔資料夾：原生的資料夾選擇對話框 → 存進個人層設定
  // 區網搜尋伺服器（手動）
  els.btnDiscover.addEventListener('click', () => void runDiscover(false));
  els.btnChooseDir.addEventListener('click', async () => {
    const dir = await window.studentApi.chooseSaveDir();
    if (!dir) return; // 使用者取消
    config = await window.studentApi.saveConfig({ fileSaveDir: dir });
    els.saveDir.value = config.fileSaveDir;
    els.saveDir.title = `教師機送來的檔案實際存到這裡。\n${config.fileSaveDir}`;
    log('info', `收檔資料夾已改為 ${config.fileSaveDir}`);
  });

  window.studentEvents.onCommand((command: HostCommand) => {
    switch (command) {
      case 'reconnect':
        disconnect();
        void connect();
        break;
      case 'toggle-fullscreen':
        void window.studentApi.setFullscreen(!document.fullscreenElement).then(() => undefined);
        break;
      default:
        break;
    }
  });

  // 主行程診斷日誌（鎖定鉤子 [lock] 等訊息）顯示到學生日誌，
  // 安裝版沒有 console，這是唯一看得到主行程狀態的窗口。
  window.studentEvents.onMainLog(line => {
    log('info', `[main] ${line}`);
  });

  // Esc 先收選單
  window.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    if (!els.menu.hidden) toggleMenu(false);
  });
}

// ───────────────────────────── 啟動 ─────────────────────────────

/**
 * 教師當機保護（心跳自解）：
 * 正常上課中教師約每 4 秒經 ctl 通道送一次 ping；本機若仍處於
 * 「廣播強制」或「鍵盤滑鼠鎖定」，但超過 15 秒（≈4 個心跳）沒收到心跳，
 * 視為教師已當機／非正常下線 → 自動解除全部強制狀態回待機。
 * 正常的「停止廣播／解除鎖定」走原指令，不會等到這裡。
 */
setInterval(() => {
  if (!lastPingAt) return; // 這輪從沒收過心跳（連線前／剛重連）不判斷
  if (!broadcastActive && !inputLocked && !muteActive) return; // 沒有需要保護的狀態
  if (Date.now() - lastPingAt <= 15_000) return;
  // 自解：只觸發一次（時間戳歸零），收到下一個心跳才重新武裝
  lastPingAt = 0;
  log('warn', '偵測不到教師心跳超過 15 秒：教師機可能已當機／關機，自動解除鎖定、靜音與廣播狀態。');
  broadcastActive = false;
  inputLocked = false;
  muteActive = false;
  stopWatch('teacher-stopped'); // 教師當機＝監看也失效，一起收掉
  void window.studentApi.setBroadcastMode(false);
  void window.studentApi.setInputLock(false);
  void window.studentApi.setMuted(false);
  showBroadcast(false, broadcastMode);
  setIdle('教師可能已離線', '（心跳逾時）已自動解除鎖定、靜音與廣播；教師重新上線後會恢復。');
}, 3000);

async function boot(): Promise<void> {
  config = await window.studentApi.getConfig();

  const info = await window.studentApi.appInfo();
  appVersion = info.version;
  buildStamp = info.build;
  platformInfo = info.platform;

  els.serverUrl.value = config.serverUrl;
  // 資訊組在部署設定把 serverUrl 鎖住時，位址輸入必須唯讀
  els.serverUrl.disabled = config.serverUrlLocked;
  els.classId.value = config.classId;
  els.studentName.value = config.studentName;
  els.saveDir.value = info.saveDir;
  nativeReadyFlag = Boolean(info.nativeReady);
  els.saveDir.title = `教師機送來的檔案實際存到這裡。可按「瀏覽…」改變；若資料夾不可寫會自動向下備援（下載資料夾 → 桌面「SETUP」）。部署層 config.json 的 fileSaveDir 變更時會重新套用。\n${info.saveDir}`;
  els.autoConnect.checked = config.autoConnect;
  els.autoFullscreen.checked = config.autoFullscreen;
  els.autoStart.checked = config.autoStart !== false;

  bindEvents();

  log('info', '學生機已啟動');
  log('info', `學生機 v${appVersion}${buildStamp ? `（build ${buildStamp.slice(0, 16).replace('T', ' ')}）` : ''}`);

  if (config.autoConnect && config.classId) {
    await connect();
  } else {
    els.settings.hidden = false;
  }
}

void boot();
