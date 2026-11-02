import { makeClassId, normalizeClassId } from '@classroom/protocol';

import { type CaptureSource, type TeacherConfig } from '../shared/ipc.js';
import { QUALITY_PRESETS, qualityPresetDef } from '../shared/ipc.js';
import { createMirrorFixer, type MirrorFixer } from './mirror.js';
import { TeacherSession, describe } from './webrtc/index.js';
import { MonitorWall } from './ui/monitor-wall.js';
import { Whiteboard, PEN_COLORS } from './ui/whiteboard.js';

/**
 * 教師機 renderer：負責所有 UI 與 WebRTC。
 *
 * 為什麼 WebRTC 放在 renderer 而不是主行程：
 *   - 視訊解碼與顯示必須在 renderer（<video> 元素）
 *   - 主行程只做「只有主行程能做」的事：desktopCapturer.getSources、設定檔
 *
 * 這個版本的功能僅限「廣播」：監看／鍵鼠接管／鎖定／文字輸入已整組移除。
 */

const $ = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`找不到 DOM 節點 #${id}`);
  return element as T;
};

// ───────────────────────────── 狀態 ─────────────────────────────

let config: TeacherConfig;
let sources: CaptureSource[] = [];
let session: TeacherSession | null = null;
let localStream: MediaStream | null = null;
/** 攝影機預覽用的鏡像修正（螢幕／視窗來源不會用到）。 */
let previewMirror: MirrorFixer | null = null;
/** 廣播中的攝影機鏡像修正（只有來源是攝影機時才有值）。 */
let cameraMirror: MirrorFixer | null = null;
/**
 * 已經被換掉、但輸出串流可能還掛在 `RTCRtpSender` 上的鏡像修正器。
 * 必須等 `setLocalStream()` 把 sender 換到新串流之後才能 dispose，
 * 否則學生機會先閃一格黑畫面。
 */
const staleMirrors: MirrorFixer[] = [];
/** 目前正在廣播的來源 id（用來決定攝影機預覽能否重用廣播串流）。 */
let broadcastingSourceId: string | null = null;
/** 遞增權杖：防止非同步的預覽擷取彼此覆蓋。 */
let previewToken = 0;
/** 監控牆 UI 組件（由 boot() 初始化） */
let monitorWall: MonitorWall | null = null;
/** 教師機自身版本（boot() 時從 appInfo 取得；學生機連線時比較用） */
let teacherAppVersion = '';
/** 白板筆（廣播中在來源預覽上標註，筆跡同步學生機） */
let whiteboard: Whiteboard | null = null;

/** 釋放已經被換掉的鏡像修正器（務必在 `setLocalStream()` 之後呼叫）。 */
function disposeStaleMirrors(): void {
  while (staleMirrors.length > 0) staleMirrors.pop()?.dispose();
}

/**
 * 需要時把串流接上鏡像修正（見 mirror.ts），回傳「該拿去播／去送」的串流。
 *
 * `flipCamera` 關掉時直接回傳原串流（連修正器都不建，不多一層 canvas 轉寫）。
 * `slot` 決定舊的修正器怎麼收：
 *   - `preview`：預覽的輸出沒人接管，直接 dispose。
 *   - `broadcast`：輸出可能還掛在 `RTCRtpSender` 上，排進 `staleMirrors`，
 *     等 `setLocalStream()` 換掉 sender 之後才 dispose。
 */
function fixMirror(source: MediaStream, fps: number, slot: 'preview' | 'broadcast'): MediaStream {
  if (slot === 'preview') {
    previewMirror?.dispose();
    previewMirror = null;
  } else if (cameraMirror) {
    staleMirrors.push(cameraMirror);
    cameraMirror = null;
  }

  if (!config.flipCamera) return source;

  const fixer = createMirrorFixer();
  if (slot === 'preview') previewMirror = fixer;
  else cameraMirror = fixer;
  return fixer.attach(source, fps);
}

// ───────────────────────────── 元素 ─────────────────────────────

const els = {
  serverUrl: $<HTMLInputElement>('server-url'),
  classId: $<HTMLInputElement>('class-id'),
  teacherName: $<HTMLInputElement>('teacher-name'),
  btnConnect: $<HTMLButtonElement>('btn-connect'),
  btnNewClass: $<HTMLButtonElement>('btn-new-class'),
  statusDot: $<HTMLSpanElement>('status-dot'),
  statusText: $<HTMLSpanElement>('status-text'),

  sourceSelect: $<HTMLSelectElement>('source-select'),
  btnRefresh: $<HTMLButtonElement>('btn-refresh-sources'),
  sourcePreview: $<HTMLImageElement>('source-preview'),
  sourceVideo: $<HTMLVideoElement>('source-video'),
  sourceWarning: $<HTMLParagraphElement>('source-warning'),
  flipCamera: $<HTMLInputElement>('flip-camera'),
  hardwareCodec: $<HTMLInputElement>('hardware-codec'),
  broadcastMode: $<HTMLSelectElement>('broadcast-mode'),
  qualityPreset: $<HTMLSelectElement>('quality-preset'),
  qualityFps: $<HTMLInputElement>('quality-fps'),
  qualityBitrate: $<HTMLInputElement>('quality-bitrate'),
  qualitySize: $<HTMLSelectElement>('quality-size'),
  qualitySharp: $<HTMLSelectElement>('quality-sharp'),
  qualityHint: $<HTMLParagraphElement>('quality-hint'),
  btnStart: $<HTMLButtonElement>('btn-start-broadcast'),
  btnStop: $<HTMLButtonElement>('btn-stop-broadcast'),

  studentGrid: $<HTMLDivElement>('student-grid'),
  studentCount: $<HTMLSpanElement>('student-count'),
  emptyStudents: $<HTMLParagraphElement>('empty-students'),
  scaleHint: $<HTMLParagraphElement>('scale-hint'),
  pumpStats: $<HTMLParagraphElement>('pump-stats'),
  pushUrl: $<HTMLInputElement>('push-url'),
  btnPushUrl: $<HTMLButtonElement>('btn-push-url'),
  btnBroadcastAll: $<HTMLButtonElement>('btn-broadcast-all'),
  broadcastTargetLabel: $<HTMLSpanElement>('broadcast-target-label'),
  perStudentBar: $<HTMLDivElement>('per-student-bar'),
  checkedCount: $<HTMLSpanElement>('checked-count'),
  btnLockChecked: $<HTMLButtonElement>('btn-lock-checked'),
  btnUnlockChecked: $<HTMLButtonElement>('btn-unlock-checked'),
  btnFileChecked: $<HTMLButtonElement>('btn-file-checked'),
  btnUrlChecked: $<HTMLButtonElement>('btn-url-checked'),
  btnExecChecked: $<HTMLButtonElement>('btn-exec-checked'),
  btnShutdownChecked: $<HTMLButtonElement>('btn-shutdown-checked'),
  btnRebootChecked: $<HTMLButtonElement>('btn-reboot-checked'),
  btnWatchChecked: $<HTMLButtonElement>('btn-watch-checked'),
  btnCastChecked: $<HTMLButtonElement>('btn-cast-checked'),
  btnUncheckAll: $<HTMLButtonElement>('btn-uncheck-all'),
  fileInput: $<HTMLInputElement>('file-input'),
  fileLabel: $<HTMLSpanElement>('file-label'),
  btnPickFile: $<HTMLButtonElement>('btn-pick-file'),
  btnSendFile: $<HTMLButtonElement>('btn-send-file'),
  execPath: $<HTMLInputElement>('exec-path'),
  execArgs: $<HTMLInputElement>('exec-args'),
  btnLock: $<HTMLButtonElement>('btn-lock'),
  btnUnlock: $<HTMLButtonElement>('btn-unlock'),
  btnShutdown: $<HTMLButtonElement>('btn-shutdown'),
  btnRebootAll: $<HTMLButtonElement>('btn-reboot-all'),
  btnMute: $<HTMLButtonElement>('btn-mute'),
  btnCloseBrowsers: $<HTMLButtonElement>('btn-close-browsers'),
  btnUwfSetup: $<HTMLButtonElement>('btn-uwf-setup'),
  btnUwfStatus: $<HTMLButtonElement>('btn-uwf-status'),
  btnUwfMaintOn: $<HTMLButtonElement>('btn-uwf-maint-on'),
  btnUwfMaintOff: $<HTMLButtonElement>('btn-uwf-maint-off'),
  btnSceneTeach: $<HTMLButtonElement>('btn-scene-teach'),
  btnSceneLearn: $<HTMLButtonElement>('btn-scene-learn'),
  monitorViewer: $<HTMLDivElement>('monitor-viewer'),
  monitorLabel: $<HTMLSpanElement>('monitor-label'),
  monitorMeta: $<HTMLSpanElement>('monitor-meta'),
  monitorImg: $<HTMLImageElement>('monitor-img'),
  btnMonitorStop: $<HTMLButtonElement>('btn-monitor-stop'),
  btnMonitorWall: $<HTMLButtonElement>('btn-monitor-wall'),
  monitorWall: $<HTMLDivElement>('monitor-wall'),

  // 學生機待機（開機初始）畫面
  idleTitleInput: $<HTMLInputElement>('idle-title'),
  idleTextInput: $<HTMLInputElement>('idle-text'),
  btnIdleScreen: $<HTMLButtonElement>('btn-idle-screen'),
  idleImageInput: $<HTMLInputElement>('idle-image-input'),
  penCanvas: $<HTMLCanvasElement>('pen-canvas'),
  whitebar: $<HTMLDivElement>('whitebar'),
  penWidth: $<HTMLSelectElement>('pen-width'),
  penUndo: $<HTMLButtonElement>('pen-undo'),
  penClear: $<HTMLButtonElement>('pen-clear'),
  btnIdleImage: $<HTMLButtonElement>('btn-idle-image'),
  idleImageLabel: $<HTMLSpanElement>('idle-image-label'),

  // 自適應畫質
  adaptiveQuality: $<HTMLInputElement>('adaptive-quality'),

  log: $<HTMLUListElement>('log'),
  btnClearLog: $<HTMLButtonElement>('btn-clear-log'),
};

// ───────────────────────────── 小工具 ─────────────────────────────
function log(level: 'info' | 'warn' | 'error', message: string): void {
  const item = document.createElement('li');
  item.className = level;
  const time = document.createElement('time');
  time.textContent = new Date().toLocaleTimeString('zh-TW', { hour12: false });
  item.append(time, document.createTextNode(message));
  els.log.prepend(item);
  while (els.log.childElementCount > 300) els.log.lastElementChild?.remove();
}

function setStatus(text: string, kind: 'idle' | 'ok' | 'warn' | 'err' = 'idle'): void {
  els.statusText.textContent = text;
  els.statusDot.className = `dot${kind === 'idle' ? '' : ` ${kind === 'ok' ? 'on' : kind}`}`;
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

// ───────────────────────────── 擷取來源 ─────────────────────────────

/**
 * 攝影機（含實物投影機）由 renderer 自己列舉。
 *
 * 主行程沒有列舉影音裝置的 API，而且 `getUserMedia` 本來就只能在 renderer 呼叫。
 * 首次使用時 `label` 可能是空的（Chromium 要等權限核發後才給名稱），
 * 所以這裡用「攝影機 N」當備援名稱；真正開始擷取後會再用 track.label 補正。
 */
async function listCameras(): Promise<CaptureSource[]> {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices
      .filter(device => device.kind === 'videoinput' && device.deviceId)
      .map((device, index) => ({
        id: `camera:${device.deviceId}`,
        name: device.label || `攝影機 ${index + 1}`,
        kind: 'camera' as const,
        thumbnail: '',
        appIcon: null,
        displayId: null,
      }));
  } catch (error) {
    log('warn', `列舉攝影機失敗：${describe(error)}`);
    return [];
  }
}

function sourceIcon(source: CaptureSource): string {
  if (source.kind === 'screen') return '🖥';
  if (source.kind === 'window') return '🪟';
  return '📷';
}

async function refreshSources(): Promise<void> {
  const previous = els.sourceSelect.value || config.lastSourceId || '';
  try {
    const [captured, cameras] = await Promise.all([window.teacherApi.listSources(), listCameras()]);
    sources = [...captured, ...cameras];
  } catch (error) {
    log('error', `列出擷取來源失敗：${describe(error)}`);
    return;
  }

  els.sourceSelect.replaceChildren();
  for (const source of sources) {
    const option = document.createElement('option');
    option.value = source.id;
    option.textContent = `${sourceIcon(source)} ${source.name}`;
    els.sourceSelect.append(option);
  }

  // 沒有沿用紀錄時一律預設「整個螢幕」：這是最常用的廣播來源。
  const match =
    sources.find(source => source.id === previous) ?? sources.find(source => source.kind === 'screen') ?? sources[0];
  if (match) els.sourceSelect.value = match.id;
  await updateSourcePreview();
}

function currentSource(): CaptureSource | null {
  return sources.find(source => source.id === els.sourceSelect.value) ?? null;
}

/** 關掉攝影機預覽串流（切換來源、開始廣播、離開時都要呼叫）。 */
function releasePreview(): void {
  previewToken += 1;
  // 預覽的輸出串流沒有交給 session 管，所以要連它一起 dispose。
  previewMirror?.dispose();
  previewMirror = null;
  els.sourceVideo.srcObject = null;
  els.sourceVideo.hidden = true;
}

/**
 * 更新來源預覽。
 *
 * 螢幕／視窗用主行程給的縮圖（`<img>`）；攝影機沒有縮圖，
 * 改成真的開一條低解析度的擷取串流（`<video>`）當即時預覽。
 * 正在廣播同一個攝影機時直接重用廣播串流，避免對同一台裝置開兩次擷取。
 */
async function updateSourcePreview(): Promise<void> {
  // 先關掉舊的（同時讓先前還在進行中的擷取失效），再取新的權杖。
  releasePreview();
  const token = previewToken;
  const source = currentSource();
  updateSourceWarning(source);

  if (source?.kind === 'camera') {
    els.sourcePreview.hidden = true;

    if (localStream && broadcastingSourceId === source.id) {
      els.sourceVideo.srcObject = localStream;
      els.sourceVideo.hidden = false;
      void els.sourceVideo.play().catch(() => undefined);
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          deviceId: { exact: source.id.replace(/^camera:/, '') },
          width: { ideal: 640 },
          height: { ideal: 360 },
        },
      });
      // 擷取期間老師可能又換了來源，那就把這條串流直接丟掉。
      if (token !== previewToken) {
        for (const track of stream.getTracks()) track.stop();
        return;
      }
      // 預覽也要翻正：預覽畫的就是學生等一下會看到的東西（見 mirror.ts）。
      const preview = fixMirror(stream, 15, 'preview');
      els.sourceVideo.srcObject = preview;
      els.sourceVideo.hidden = false;
      void els.sourceVideo.play().catch(() => undefined);
    } catch (error) {
      log('warn', `攝影機預覽失敗（仍可直接開始廣播）：${describe(error)}`);
      els.sourceVideo.hidden = true;
    }
    return;
  }

  els.sourcePreview.src = source?.thumbnail ?? '';
  els.sourcePreview.alt = source?.name ?? '無來源';
  els.sourcePreview.hidden = !source?.thumbnail;
}

/** 非「整個螢幕」的來源可以廣播，只是畫面範圍不如整個螢幕完整。 */
function updateSourceWarning(source: CaptureSource | null): void {
  if (!source || source.kind === 'screen') {
    els.sourceWarning.hidden = true;
    els.sourceWarning.textContent = '';
    return;
  }
  els.sourceWarning.hidden = false;
  els.sourceWarning.textContent =
    source.kind === 'window'
      ? '⚠ 目前來源是「單一視窗」：只會播這個視窗，不是整個螢幕。'
      : '⚠ 目前來源是「攝影機」：廣播影像畫面，沒有桌面內容。';
}

// ───────────────────────────── 畫質設定 ─────────────────────────────

/** 目前下拉選到的擷取尺寸上限；「原始」= 0（不縮放）。 */
function selectedCaptureSize(): [number, number] {
  const parts = els.qualitySize.value.split('x');
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  return [Number.isFinite(width) && width > 0 ? width : 0, Number.isFinite(height) && height > 0 ? height : 0];
}

function captureSizeText(width: number, height: number): string {
  return width > 0 && height > 0 ? `${width}×${height}` : '原始尺寸';
}

/** 畫質下拉選單的選項（定義在 shared/ipc.ts，介面文字與實際套用值不會各說各話）。 */
function fillQualityPresets(): void {
  const options = QUALITY_PRESETS.map(preset => {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    return option;
  });
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = '自訂';
  els.qualityPreset.replaceChildren(...options, custom);
}

/** 把目前的 config 同步到畫質控件（改完設定後也要呼叫，讓數字回到合法值）。 */
function renderQualityControls(): void {
  els.qualityPreset.value = config.qualityPreset;
  // 設定檔裡的預設名稱不在選單上（例如舊版殘值）→ 停在「自訂」
  if (els.qualityPreset.value !== config.qualityPreset) els.qualityPreset.value = 'custom';
  els.qualityFps.value = String(config.maxFramerate);
  els.qualityBitrate.value = String(config.maxBitrate / 1_000_000);
  // 定影幀品質：設定值不在選項中（例如手改 JSON）→ 停最近的一般值
  const sharpValue = String(config.imgSharpQuality);
  els.qualitySharp.value = [...els.qualitySharp.options].some(option => option.value === sharpValue)
    ? sharpValue
    : '0.85';

  if (config.maxCaptureWidth > 0 && config.maxCaptureHeight > 0) {
    const value = `${config.maxCaptureWidth}x${config.maxCaptureHeight}`;
    if (![...els.qualitySize.options].some(option => option.value === value)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = captureSizeText(config.maxCaptureWidth, config.maxCaptureHeight);
      els.qualitySize.append(option);
    }
    els.qualitySize.value = value;
  } else {
    els.qualitySize.value = '0';
  }

  const preset = qualityPresetDef(config.qualityPreset);
  els.qualityHint.textContent =
    (preset ? preset.hint : '自訂畫質：下面三個數字是手動設定的。秒差變大時，先降「幀率」與「尺寸上限」最有效。') +
    // 圖片模式下「幀率／頻寬」用不到，講清楚免得老師白調
    (config.broadcastMode === 'image' ? '（圖片模式：以「尺寸上限」決定解析度，「幀率／頻寬」不適用）' : '');
}

/**
 * 套用畫質設定。
 *
 * 幀率／頻寬上限走 `RTCRtpSender.setParameters`，可以即時生效、不用重新協商；
 * 但**擷取尺寸與擷取幀率**是 `getUserMedia` 的約束，必須重新擷取
 * （停止 → 開始廣播）才會套用，所以正在廣播時要提醒老師。
 */
async function applyQuality(patch: Partial<TeacherConfig>): Promise<void> {
  // 手動調整畫質時，自動關閉自適應畫質（避免互相干擾）
  if (session?.getAdaptiveQualityEnabled()) {
    patch = { ...patch, adaptiveQualityEnabled: false };
    els.adaptiveQuality.checked = false;
    log('info', '手動調整畫質，自適應畫質已停用');
  }
  config = await window.teacherApi.saveConfig(patch);
  renderQualityControls();
  await session?.updateEncoding(config.maxBitrate, config.maxFramerate);
  log(
    'info',
    `畫質已更新：${config.maxFramerate} fps · ${config.maxBitrate / 1_000_000} Mbps · ` +
      `${captureSizeText(config.maxCaptureWidth, config.maxCaptureHeight)}`
  );
  if (localStream) log('warn', '擷取尺寸／幀率要重新擷取才會生效：按「停止」再「開始廣播」。');
}

// ───────────────────────────── 廣播 ─────────────────────────────

/**
 * 取得廣播串流。
 *
 * 螢幕／視窗用 Electron 的 `chromeMediaSource: 'desktop'` 舊式約束，
 * 而不是 `getDisplayMedia()`：前者可以搭配自製的來源選擇器，
 * 後者會跳出系統的原生選擇視窗，在課堂上很干擾。
 *
 * 攝影機則走一般的 `deviceId` 約束（實物投影機就是這個）。
 */
async function captureSource(source: CaptureSource): Promise<MediaStream> {
  if (source.kind !== 'camera') {
    // 來源不是攝影機時，攝影機的鏡像修正就用不到了；
    // 但它的輸出可能還在 sender 上，所以排進待釋放清單（見 disposeStaleMirrors）。
    if (cameraMirror) {
      staleMirrors.push(cameraMirror);
      cameraMirror = null;
    }
  }

  if (source.kind === 'camera') {
    const deviceId = source.id.replace(/^camera:/, '');
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        deviceId: { exact: deviceId },
        width: { ideal: config.maxCaptureWidth || 1280 },
        height: { ideal: config.maxCaptureHeight || 720 },
        frameRate: { ideal: config.maxFramerate },
      },
    });
    // 有些攝影機送出的畫面本身是左右相反的鏡像，這裡翻回來（見 mirror.ts）。
    // 注意：翻轉後廣播出去的就不再是「裝置原始軌」，老師若換回正常方向的攝影機，
    // 把「修正攝影機鏡像」的勾勾取消即可。
    return fixMirror(stream, config.maxFramerate, 'broadcast');
  }

  // 圖片模式：抽幀泵每秒只畫 2 張靜態照，擷取端卻照舊跑「全解析度＋30fps」，
  // 這些 CPU 全是白燒的（解析度調大時尤其明顯——就是「圖片也會延遲」的元兇之一）。
  // 圖片模式把擷取幀率限到 5fps；尺寸上限照使用者的選擇，「原始」也抓 1920 封頂。
  const imageMode = config.broadcastMode === 'image';
  const captureMaxFps = imageMode ? 5 : config.maxFramerate;
  const captureMaxWidth = imageMode ? config.maxCaptureWidth || 1920 : config.maxCaptureWidth || 3840;
  const captureMaxHeight = imageMode ? config.maxCaptureHeight || 1080 : config.maxCaptureHeight || 2160;

  const constraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: 'desktop',
        chromeMediaSourceId: source.id,
        maxFrameRate: captureMaxFps,
        // 擷取尺寸上限（畫質預設的一部分）。以前寫死 4K 不設限：
        // 編碼像素量多 4 倍、頻寬上限卻只有 6 Mbps，編碼器來不及就開始排隊，
        // 於是秒差越上課越大。0（原始）時才退回大尺寸不縮放。
        maxWidth: captureMaxWidth,
        maxHeight: captureMaxHeight,
      },
    },
  } as unknown as MediaStreamConstraints;

  return navigator.mediaDevices.getUserMedia(constraints);
}

/**
 * 量出串流「真正的」畫面尺寸。
 *
 * 視窗來源因為停用了 WGC 視窗擷取（見主行程的 disable-features 說明），
 * `track.getSettings()` 會回報成螢幕的尺寸（例如 1920×1920），是錯的；
 * 只有實際解出來的視訊才有正確的 videoWidth / videoHeight。
 */
function measureStreamSize(stream: MediaStream): Promise<string> {
  const settings = stream.getVideoTracks()[0]?.getSettings();
  const fromSettings = `${settings?.width ?? '?'}×${settings?.height ?? '?'}`;

  return new Promise(resolve => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;

    const finish = (size: string): void => {
      window.clearTimeout(timer);
      video.srcObject = null;
      resolve(size);
    };
    // 有些來源不會觸發 loadedmetadata，逾時就用 track 回報的值。
    const timer = window.setTimeout(() => finish(fromSettings), 1500);

    video.addEventListener(
      'loadedmetadata',
      () => {
        const size = `${video.videoWidth || settings?.width || '?'}×${video.videoHeight || settings?.height || '?'}`;
        finish(size);
      },
      { once: true }
    );
    void video.play().catch(() => undefined);
  });
}

/** 攝影機第一次擷取成功後才會拿到裝置名稱，順手把下拉選單補正。 */
function syncCameraLabel(source: CaptureSource, label: string | undefined): void {
  if (!label || label === source.name) return;
  source.name = label;
  const option = [...els.sourceSelect.options].find(item => item.value === source.id);
  if (option) option.textContent = `${sourceIcon(source)} ${label}`;
  void updateSourcePreview();
}

async function startBroadcast(): Promise<void> {
  if (!session) {
    log('warn', '請先按「連線」加入班級');
    return;
  }
  const source = currentSource();
  if (!source) {
    log('warn', '請選擇一個擷取來源');
    return;
  }

  try {
    // 先放掉預覽，避免同一台攝影機被開兩次擷取（部分驅動會直接失敗）。
    releasePreview();
    const stream = await captureSource(source);
    // 告訴編碼器這是「要看得清楚文字」的畫面：寧可掉幀（frames 沒那麼多就不用排隊）
    // 也不要糊掉，與 tuneSender 的 maintain-resolution 同方向。
    for (const track of stream.getVideoTracks()) track.contentHint = 'detail';
    localStream = stream;
    broadcastingSourceId = source.id;
    await session.setLocalStream(stream);
    // sender 已經換到新串流了，這時候才能真的放掉舊的鏡像修正串流。
    disposeStaleMirrors();
    config = await window.teacherApi.saveConfig({ lastSourceId: source.id });

    const track = stream.getVideoTracks()[0];
    if (source.kind === 'camera') syncCameraLabel(source, track?.label);
    // 白板筆可用（蓋在來源預覽上，筆跡同步學生機）
    els.whitebar.hidden = false;
    whiteboard?.setEnabled(true);
    log('info', `已開始廣播「${source.name}」（${await measureStreamSize(stream)}）`);
    els.btnStart.disabled = true;
    els.btnStop.disabled = false;
    // 學生卡片上的「廣播」標籤要跟著更新（不然會一直停在「未廣播」）。
    renderStudents();
    // 攝影機：預覽改顯示廣播中的串流（同裝置不再開第二次擷取）。
    void updateSourcePreview();
  } catch (error) {
    log('error', `開始擷取失敗：${describe(error)}`);
    void updateSourcePreview();
  }
}

async function stopBroadcast(): Promise<void> {
  if (!session) return;
  await session.setLocalStream(null);
  localStream = null;
  broadcastingSourceId = null;
  // 廣播停了：攝影機的鏡像修正（含底層攝影機裝置）也要放掉。
  cameraMirror?.dispose();
  cameraMirror = null;
  disposeStaleMirrors();
  els.btnStart.disabled = false;
  els.btnStop.disabled = true;
  // 白板筆跟著廣播收：本地與學生端筆跡一併清除
  els.whitebar.hidden = true;
  whiteboard?.setEnabled(false);
  log('info', '已停止廣播');
  renderStudents();
  // 停止後若選的是攝影機，重新開一條預覽串流。
  void updateSourcePreview();
}

// ───────────────────────────── 學生清單 ─────────────────────────────

/**
 * 把 RTCPeerConnection 的狀態翻成中文。
 * 這些值原本直接印在學生卡上（例如「廣播:idle」），
 * 對老師來說是看不懂的英文雜字。
 */
function connectionLabel(state: RTCPeerConnectionState | 'idle'): string {
  switch (state) {
    case 'idle':
      return '未開始';
    case 'new':
      return '建立中';
    case 'connecting':
      return '連線中';
    case 'connected':
      return '已連線';
    case 'disconnected':
      return '已中斷';
    case 'failed':
      return '失敗';
    case 'closed':
      return '已關閉';
    default:
      return String(state);
  }
}

/** 當前正在監看的學生機（一次一台；null = 沒有在監看） */
let watchingPeer: string | null = null;
/** 監看窗顯示中的物件 URL（換幀時要收掉避免洩漏） */
let monitorUrl: string | null = null;

/** 關閉監看：通知學生機停止送圖、收掉浮動窗與監控牆 */
function closeMonitor(): void {
  if (monitorWall?.isVisible) {
    monitorWall.hide();
  }
  if (watchingPeer && session?.isConnected) session.watchStudent(watchingPeer, false);
  watchingPeer = null;
  if (monitorUrl) {
    URL.revokeObjectURL(monitorUrl);
    monitorUrl = null;
  }
  els.monitorViewer.hidden = true;
  els.monitorImg.src = '';
}

/** 收到一幀監看畫面：若監控牆可見，送給監控牆；否則顯示單台浮動窗 */
function showMonitorFrame(peerId: string, frame: { url: string; width: number; height: number; seq: number }): void {
  // 監控牆優先：若監控牆可見且該台在監看名單內，交給監控牆處理
  if (monitorWall?.isVisible) {
    monitorWall.handleWatchFrame(peerId, frame);
    return;
  }
  // 單台浮動窗：只顯示還在監看的那台
  if (watchingPeer !== peerId) {
    URL.revokeObjectURL(frame.url);
    return;
  }
  if (monitorUrl) URL.revokeObjectURL(monitorUrl);
  monitorUrl = frame.url;
  els.monitorImg.src = frame.url;
  els.monitorMeta.textContent = `第 ${frame.seq} 張 · ${frame.width}×${frame.height} · 3 秒/張`;
}

/** 開始監看勾選的那一台（單機功能列的「👁 監看」按鈕） */
function toggleWatchChecked(): void {
  if (!session?.isConnected) {
    log('warn', '尚未連線；請先按「連線」再監看。');
    return;
  }
  if (checkedPeers.size !== 1) {
    log('warn', '監看一次一台：請只勾選一台（目前已勾 ' + checkedPeers.size + ' 台）。');
    return;
  }
  const peerId = [...checkedPeers][0]!;
  const student = session.students().find(item => item.info.id === peerId);
  if (!student) {
    log('warn', '這台已經離線了。');
    return;
  }
  if (watchingPeer === peerId) {
    closeMonitor();
    log('info', '已停止監看。');
    renderStudents();
    return;
  }
  // 換台：先通知上一台停止，避免兩台同時送圖
  closeMonitor();
  if (!session.watchStudent(peerId, true, 3000)) {
    log('warn', '監看送出失敗：控制通道還沒連上這台。');
    return;
  }
  watchingPeer = peerId;
  els.monitorViewer.hidden = false;
  els.monitorLabel.textContent = `監看中：${student.info.name}`;
  els.monitorMeta.textContent = '等待第一張畫面…（3 秒/張）';
  log('info', `已開始監看 ${student.info.name}（每 3 秒一張，關閉浮動窗即停止）。`);
  renderStudents();
}

// ───────────── 課堂場景鍵：教學活動／學習操作 ─────────────

/** 教學活動場景：廣播中＋全班鎖定＋全班靜音 */
function refreshSceneButtons(): void {
  const teaching = Boolean(localStream) && Boolean(session?.lockActive) && Boolean(session?.muteActive);
  const learning = !localStream && !session?.lockActive && !session?.muteActive;
  els.btnSceneTeach.classList.toggle('primary', teaching);
  els.btnSceneTeach.classList.toggle('ghost', !teaching);
  els.btnSceneLearn.classList.toggle('primary', learning);
  els.btnSceneLearn.classList.toggle('ghost', !learning);
}

async function applyScene(scene: 'teach' | 'learn'): Promise<void> {
  if (!session?.isConnected) {
    log('warn', '尚未連線；請先按「連線」再切換課堂場景。');
    return;
  }
  if (scene === 'teach') {
    if (!localStream) await startBroadcast();
    const locked = session.lockAll(true);
    const muted = session.muteAll(true);
    log(
      'info',
      `▶ 教學活動：廣播 ${localStream ? '進行中' : '（未開啟來源，稍後手動開）'}＋鎖定 ${locked} 台＋靜音 ${muted} 台。`
    );
  } else {
    if (localStream) await stopBroadcast();
    const unlocked = session.lockAll(false);
    const unmuted = session.muteAll(false);
    // 收攏到系統匣：學習操作要讓學生機從右下角消失，
    // 回到自己的桌面（重新開始廣播時學生機會自己拉回全螢幕）。
    session.minimizeAll();
    log('info', `🖐 學習操作：已停止廣播＋解除 ${unlocked} 台鎖定＋解除 ${unmuted} 台靜音＋學生機已收攏到系統匣。`);
  }
  renderStudents();
}

function renderStudents(): void {
  const students = session?.students() ?? [];
  els.studentCount.textContent = String(students.length);
  els.emptyStudents.hidden = students.length > 0;

  // 直播狀態：有指定名單時表頭出現「回到全班」按鈕
  const targets = session?.getBroadcastTargets() ?? null;
  if (targets) {
    const names =
      students
        .filter(student => targets.has(student.info.id))
        .map(student => student.info.name)
        .join('、') || `${targets.size} 台`;
    els.broadcastTargetLabel.textContent = names.length > 30 ? `${names.slice(0, 30)}…` : names;
    els.btnBroadcastAll.hidden = false;
  } else {
    els.btnBroadcastAll.hidden = true;
  }
  // 台數多時提示畫質：延遲主要是教師機編碼負載，降畫質與硬體編碼是最有效的兩件事
  els.scaleHint.hidden = students.length < 15;
  if (students.length >= 20) {
    els.scaleHint.textContent =
      '⚠ 已超過 19 台：建議把畫質降到「講課簡報（5fps）」或「每秒 2 張」，並開啟 H.264 硬體編碼，否則教師機編碼會塞車、畫面延遲會變大。';
  } else if (students.length >= 15) {
    els.scaleHint.textContent = '⚠ 學生機已 15 台以上：若發現延遲變大，先降畫質或確認已開啟 H.264 硬體編碼。';
  } else {
    els.scaleHint.textContent = '';
  }
  els.studentGrid.replaceChildren();

  // 勾選名單跟著現在一波清單修整：已下線的台自動移出勾選
  const peerIds = new Set(students.map(student => student.info.id));
  for (const id of [...checkedPeers]) {
    if (!peerIds.has(id)) checkedPeers.delete(id);
  }
  updateStudentBar();

  // 正在監看的那台離線了：自動收掉監看（避免窗一直停在舊畫面）
  if (watchingPeer && !peerIds.has(watchingPeer)) {
    const name = session?.students().find(item => item.info.id === watchingPeer)?.info.name ?? watchingPeer;
    closeMonitor();
    log('warn', `監看的學生機（${name}）已離線，監看窗已自動關閉。`);
  }
  refreshSceneButtons();

  for (const student of students) {
    const card = document.createElement('div');
    card.className = 'card';

    // 勾選框：勾起來的台才能用「單機功能列」（中欄最下方）
    const peerId = student.info.id;
    const pickLine = document.createElement('div');
    pickLine.className = 'pick-line';
    const pick = document.createElement('input');
    pick.type = 'checkbox';
    pick.className = 'pick';
    pick.title = '勾選後可用最下方的單機功能列（點卡片也可以勾／取消）';
    pick.checked = checkedPeers.has(peerId);
    pick.addEventListener('change', () => {
      if (pick.checked) checkedPeers.add(peerId);
      else checkedPeers.delete(peerId);
      card.classList.toggle('checked', pick.checked);
      updateStudentBar();
    });
    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = student.info.name;
    name.title = `${student.info.name} (${student.info.id})`;
    pickLine.append(pick, name);
    // 點卡片任意處＝切換勾選（點勾選框本身除外）
    card.addEventListener('click', event => {
      if (event.target === pick) return;
      pick.checked = !pick.checked;
      pick.dispatchEvent(new Event('change'));
    });

    const meta = document.createElement('div');
    meta.className = 'meta';
    const broadcasting = Boolean(localStream);
    const videoArrived = broadcasting && student.broadcastState === 'connected';
    const broadcastText = videoArrived
      ? '畫面已送達'
      : broadcasting
        ? `廣播：${connectionLabel(student.broadcastState)}`
        : targets?.has(peerId) === false
          ? '直播排除'
          : '未廣播';

    const broadcastTagClass = videoArrived ? 'tag ok' : targets?.has(peerId) === false ? 'tag' : 'tag';
    meta.append(tag(broadcastText, broadcastTagClass));
    if (session?.lockActive) meta.append(tag('已鎖定', 'tag err'));
    if (watchingPeer === peerId) meta.append(tag('👁 正在監看', 'tag ok'));
    if (student.lastError) meta.append(tag(`錯誤：${student.lastError}`, 'tag err'));

    card.append(pickLine, meta);
    if (pick.checked) card.classList.add('checked');
    els.studentGrid.append(card);
  }
}

function tag(text: string, className: string): HTMLSpanElement {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = text;
  return span;
}

/** 勾選要進行「單機功能」的學生機（卡片勾選框；勾選名單獨立於廣播名單） */
const checkedPeers = new Set<string>();

/** 單機功能列顯示：沒勾任何一台時整列收起 */
function updateStudentBar(): void {
  const count = checkedPeers.size;
  els.perStudentBar.hidden = count === 0;
  els.checkedCount.textContent = `已選 ${count} 台`;
}

// ───────────────────────────── 連線 ─────────────────────────────

/** 靜音按鈕狀態：跟著 session.muteActive 的意圖換標籤（斷線自動復原） */
function refreshMuteButton(): void {
  const active = Boolean(session?.muteActive);
  els.btnMute.textContent = active ? '🔊 解除靜音' : '🔇 靜音全班';
  els.btnMute.classList.toggle('warn', !active);
  els.btnMute.classList.toggle('primary', active);
}

async function connect(): Promise<void> {
  if (session) {
    closeMonitor();
    session.disconnect();
    session = null;
    els.btnConnect.textContent = '連線';
    setStatus('已中斷連線');
    els.btnStart.disabled = true;
    els.btnStop.disabled = true;
    els.pumpStats.hidden = true;
    refreshMuteButton();
    renderStudents();
    return;
  }

  const classId = normalizeClassId(els.classId.value);
  if (!classId) {
    log('error', '班級代碼必須是 6 位數字，例如 123-456');
    els.classId.focus();
    return;
  }
  els.classId.value = classId;

  const serverUrl = els.serverUrl.value.trim();
  const teacherName = els.teacherName.value.trim() || '教師機';

  config = await window.teacherApi.saveConfig({ serverUrl, teacherName, classId });

  session = new TeacherSession({
    serverUrl: config.serverUrl,
    teacherName: config.teacherName,
    classId: config.classId,
    maxBitrate: config.maxBitrate,
    maxFramerate: config.maxFramerate,
    hardwareCodec: config.hardwareCodec,
    appVersion: teacherAppVersion,
    adaptiveQualityEnabled: config.adaptiveQualityEnabled,
    broadcastMode: config.broadcastMode,
    // 注入設定檔的定影幀品質（每次重連都套一次，避免 session 重建後回到預設）
    imgSharpQuality: config.imgSharpQuality,
    // 圖片廣播頻寬統計（每 10 秒一筆）：顯示在畫質設定下方的提示列
    onImageStats: stats => {
      els.pumpStats.hidden = false;
      els.pumpStats.textContent = `📡 影像統計：${stats.framesPerSec} 張/秒 · ${stats.kbPerSec} KB/秒（累計 ${stats.frames} 張）— 教師機出口流量`;
    },
    // 單台螢幕監看：每 3 秒一張，組完幀即顯示在右下角浮動小窗
    onWatchFrame: (peerId, frame) => showMonitorFrame(peerId, frame),
    onStatus: (status, detail) => {
      switch (status) {
        case 'connected':
          setStatus(`已連線 · 班級 ${config.classId}`, 'ok');
          break;
        case 'connecting':
          setStatus('連線中…', 'warn');
          break;
        case 'reconnecting':
          setStatus(`重新連線中（${detail ?? ''}）`, 'warn');
          break;
        default:
          setStatus('未連線');
      }
    },
    onStudentsChanged: () => {
      renderStudents();
    },
    onLog: (level, message) => log(level, message),
  });

  session.connect();
  els.btnConnect.textContent = '斷線';
  els.btnStart.disabled = false;

  // 初始化監控牆（session 已建立）
  // 監控牆：勾選的台優先；沒勾選則監看全部已連線學生機
  const activeSession = session;
  monitorWall = new MonitorWall(els.monitorWall, activeSession, els.btnMonitorWall, () => {
    if (checkedPeers.size > 0) return [...checkedPeers];
    return activeSession.students().map(s => s.info.id);
  });

  // 白板筆：擷取畫面尺寸來源（video 或 img 預覽）
  whiteboard = new Whiteboard(
    els.penCanvas,
    msg => {
      if (msg.t === 'pen') session?.sendPen(msg.op, msg.color, msg.width, msg.x, msg.y);
      else if (msg.t === 'pen-clear') session?.penClearAll();
      else session?.penUndoAll();
    },
    () => {
      const v = els.sourceVideo;
      if (!v.hidden && v.videoWidth > 0) return { w: v.videoWidth, h: v.videoHeight };
      const img = els.sourcePreview;
      if (img.naturalWidth > 0) return { w: img.naturalWidth, h: img.naturalHeight };
      return { w: 16, h: 9 };
    }
  );
  els.penCanvas.hidden = false;

  // 應用自適應畫質設定
  session.setAdaptiveQualityEnabled(els.adaptiveQuality.checked);

  log('info', `連線到 ${config.serverUrl}，班級 ${config.classId}`);
}

// ───────────────────────────── 事件綁定 ─────────────────────────────

function bindEvents(): void {
  els.btnConnect.addEventListener('click', () => {
    void connect();
  });

  els.btnNewClass.addEventListener('click', () => {
    els.classId.value = makeClassId();
  });

  // 網站推播：把網址送給所有已連線學生機，由它們的預設瀏覽器開啟。
  const pushUrl = (): void => {
    const raw = els.pushUrl.value.trim();
    if (!raw) return;
    if (!session?.isConnected) {
      log('warn', '尚未連線；請先按「連線」再推網址。');
      return;
    }

    // 沒寫 scheme 就補 https://，方便直接貼 moodle.example.edu/xxx
    const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      log('warn', `網址格式不正確：${raw}`);
      return;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      log('warn', '只支援 http/https 網址');
      return;
    }

    const sent = session.openUrlAll(parsed.toString());
    if (sent > 0) {
      log('info', `已要求 ${sent} 台學生機開啟 ${parsed.host}`);
    } else {
      log('warn', '沒有學生機收到網址（控制通道尚未連上任何一台）。');
    }
  };

  els.btnPushUrl.addEventListener('click', pushUrl);
  els.pushUrl.addEventListener('keydown', event => {
    if (event.key === 'Enter') pushUrl();
  });

  // 檔案傳送：挑檔 → 送給所有已連線學生機（落地位置由學生機 config.json 決定）
  els.btnPickFile.addEventListener('click', () => els.fileInput.click());
  els.fileInput.addEventListener('change', () => {
    const files = Array.from(els.fileInput.files ?? []);
    const has = files.length > 0;
    els.fileLabel.textContent = has
      ? files.length === 1
        ? `${files[0]?.name ?? ''}`
        : `${files.length} 個檔案（共 ${formatBytes(files.reduce((sum, file) => sum + file.size, 0))}）`
      : '尚未選擇檔案';
    // 按鈕常開：同一顆按鈕在「無檔案但路徑有值」時走遠端執行分支
  });
  // 「送檔／執行」一站式分流：選了檔案 → 送檔／升級；沒選檔案但路徑有值 → 遠端執行。
  // 遠端執行＝對所有已連線學生機啟動「學生機上已有的檔案」（ctl exec），
  // 與檔案傳送同一家族的管理類指令，全部在 App 內完成、不必用 PsExec。
  els.btnSendFile.addEventListener('click', () => {
    const files = Array.from(els.fileInput.files ?? []);
    const target = els.execPath.value.trim();
    if (files.length === 0 && !target) {
      log('warn', '先「選擇檔案…」（送檔／升級），或在路徑欄填學生機上已有的檔案（執行）。');
      return;
    }
    if (files.length > 0) {
      // ── 送檔／升級 分支 ──
      if (!session?.isConnected) {
        log('warn', '尚未連線；請先按「連線」再送檔。');
        return;
      }
      const pack = files.length === 1 ? files.find(file => isUpgradePackage(file.name)) : undefined;
      if (pack) {
        const count = session.sendUpgrade(pack);
        if (count > 0) {
          log('info', `偵測到升級包 ${pack.name}：已送出給 ${count} 台；各台寫入成功會自動套用並重啟。`);
        } else {
          log('warn', '沒有學生機可升級（檔案通道尚未連上任何一台）。');
        }
        return;
      }
      const count = session.sendFiles(files);
      if (count > 0) {
        log('info', `開始送 ${files.length} 個檔案給 ${count} 台學生機；每台的完成結果會顯示在下方記錄。`);
      } else {
        log('warn', '沒有學生機可送（檔案通道尚未連上任何一台）。');
      }
      return;
    }
    // ── 執行 分支 ──
    if (!session?.isConnected) {
      log('warn', '尚未連線；請先按「連線」再執行。');
      return;
    }
    const args = els.execArgs.value
      .trim()
      .split(/\s+/)
      .filter(item => item.length > 0);
    const count = session.execAll(target, args);
    if (count > 0) {
      log(
        'info',
        `已送出執行指令（${target}${args.length ? ` ${args.join(' ')}` : ''}）給 ${count} 台；是否成功看各台 ☰ 記錄。`
      );
    } else {
      log('warn', '沒有學生機可執行（控制通道尚未連上任何一台）。');
    }
  });

  /** 升級包判定：檔名含「升級包」的 .zip（例：學生機升級包.zip、學生機升級包(3).zip） */
  function isUpgradePackage(name: string): boolean {
    const lower = name.toLowerCase();
    return lower.endsWith('.zip') && name.includes('升級包');
  }

  // 直播 → 解除，回到全班
  els.btnBroadcastAll.addEventListener('click', () => {
    if (!session?.getBroadcastTargets()) return;
    session.clearBroadcastTargets();
    renderStudents();
    log('info', '已恢復全班廣播。');
  });

  // ─── 單機功能列：只對卡片勾選的台生效 ───
  let barShutdownArmed = false;
  els.btnLockChecked.addEventListener('click', () => {
    let sent = 0;
    for (const peerId of checkedPeers) {
      if (session?.lockStudent(peerId, true)) sent++;
    }
    log('info', `已鎖定勾選的 ${sent} 台學生機鍵盤滑鼠`);
  });
  els.btnUnlockChecked.addEventListener('click', () => {
    let sent = 0;
    for (const peerId of checkedPeers) {
      if (session?.lockStudent(peerId, false)) sent++;
    }
    log('info', `已解除勾選的 ${sent} 台鎖定（其餘台不在勾選名單內）`);
  });
  els.btnFileChecked.addEventListener('click', () => {
    if (checkedPeers.size === 0) return;
    const files = Array.from(els.fileInput.files ?? []);
    if (files.length === 0) {
      log('warn', '請先在工作設定用「選擇檔案…」挑好要送的檔案。');
      return;
    }
    let sent = 0;
    for (const peerId of checkedPeers) {
      if (session?.sendFilesToStudent(peerId, files)) sent++;
    }
    log(
      sent > 0 ? 'info' : 'warn',
      `開始送 ${files.length} 個檔案給勾選的 ${sent}／${checkedPeers.size} 台（未送成的台是檔案通道未連上）。`
    );
  });
  els.btnUrlChecked.addEventListener('click', () => {
    if (checkedPeers.size === 0) return;
    const url = els.pushUrl.value.trim();
    if (!url) {
      log('warn', '請先在工作設定「網站推播」欄填好網址。');
      els.pushUrl.focus();
      return;
    }
    let sent = 0;
    for (const peerId of checkedPeers) {
      if (session?.pushUrlStudent(peerId, url)) sent++;
    }
    log(sent > 0 ? 'info' : 'warn', `已要求勾選的 ${sent}／${checkedPeers.size} 台開啟網址。`);
  });
  els.btnExecChecked.addEventListener('click', () => {
    if (checkedPeers.size === 0) return;
    const target = els.execPath.value.trim();
    if (!target) {
      log('warn', '請先填入要執行的檔案路徑（該檔案必須已在學生機上，例如 D:\\t.bat）。');
      els.execPath.focus();
      return;
    }
    const args = els.execArgs.value
      .trim()
      .split(/\s+/)
      .filter(item => item.length > 0);
    let sent = 0;
    for (const peerId of checkedPeers) {
      if (session?.execStudent(peerId, target, args)) sent++;
    }
    log(
      sent > 0 ? 'info' : 'warn',
      `已送出執行 ${target} 給勾選的 ${sent}／${checkedPeers.size} 台；是否成功看各台 ☰ 記錄。`
    );
  });
  els.btnShutdownChecked.addEventListener('click', () => {
    if (checkedPeers.size === 0) return;
    // 兩按確認：第一次按進入確認（5 秒），第二次按＝立即關機（不倒數）
    if (!barShutdownArmed) {
      barShutdownArmed = true;
      els.btnShutdownChecked.textContent = '⚠ 確定關機';
      els.btnShutdownChecked.classList.add('growing');
      setTimeout(() => {
        barShutdownArmed = false;
        els.btnShutdownChecked.textContent = '⏻ 關機';
        els.btnShutdownChecked.classList.remove('growing');
      }, 5000);
      return;
    }
    barShutdownArmed = false;
    els.btnShutdownChecked.textContent = '⏻ 關機';
    els.btnShutdownChecked.classList.remove('growing');
    let sent = 0;
    for (const peerId of checkedPeers) {
      if (session?.shutdownStudent(peerId, 0)) sent++;
    }
    log(sent > 0 ? 'info' : 'warn', `勾選的 ${sent}／${checkedPeers.size} 台已立即關機。`);
  });
  els.btnCastChecked.addEventListener('click', () => {
    if (checkedPeers.size === 0) return;
    const ids = [...checkedPeers];
    const ok = session?.setBroadcastTargetIds(ids) ?? false;
    if (!ok) {
      log(
        'warn',
        session?.isConnected
          ? '直播失敗：目前模式不是「圖片逐張」。請先在工作設定把廣播模式切到圖片逐張（斷線→連線）再試。'
          : '直播失敗：尚未連線（先按「連線」再指播）。'
      );
      return;
    }
    renderStudents();
    log('info', `直播：畫面只送勾選的 ${ids.length} 台；標題列可按「回到全班」解除。`);
  });
  els.btnWatchChecked.addEventListener('click', () => {
    toggleWatchChecked();
  });
  els.btnMonitorStop.addEventListener('click', () => {
    closeMonitor();
    log('info', '已停止監看。');
    renderStudents();
  });
  els.btnUncheckAll.addEventListener('click', () => {
    checkedPeers.clear();
    renderStudents();
    log('info', '已取消全部勾選。');
  });
  els.btnLock.addEventListener('click', () => {
    if (!session?.isConnected) {
      log('warn', '尚未連線；請先按「連線」再鎖定。');
      return;
    }
    const sent = session.lockAll(true);
    if (sent > 0) {
      log('info', `已鎖定 ${sent} 台學生機鍵盤滑鼠`);
    } else {
      log('warn', '沒有學生機可鎖（控制通道尚未連上任何一台）。');
    }
    renderStudents();
  });

  els.btnUnlock.addEventListener('click', () => {
    if (!session?.isConnected) {
      log('warn', '尚未連線；請先按「連線」再解除鎖定。');
      return;
    }
    const sent = session.lockAll(false);
    log('info', `已解除 ${sent} 台學生機的鎖定`);
    renderStudents();
  });

  // ─── 獨立管理：靜音／關閉學生網頁（與廣播開關脫鉤） ───
  els.btnMute.addEventListener('click', () => {
    if (!session?.isConnected) {
      log('warn', '尚未連線；請先按「連線」再控制靜音。');
      return;
    }
    const next = !session.muteActive;
    const sent = session.muteAll(next);
    refreshMuteButton();
    refreshSceneButtons();
    log(
      sent > 0 ? 'info' : 'warn',
      sent > 0
        ? next
          ? `已靜音 ${sent} 台（持續維持）；再按一次解除`
          : `已解除 ${sent} 台靜音`
        : '沒有學生機可控制（控制通道尚未連上任何一台）。'
    );
  });

  // 重開機（勾選的學生機）：與勾選列關機同一套兩按確認
  let barRebootTimer: number | null = null;
  let barRebootArmed = false;
  const resetBarReboot = (): void => {
    if (barRebootTimer !== null) window.clearTimeout(barRebootTimer);
    barRebootArmed = false;
    barRebootTimer = null;
    els.btnRebootChecked.textContent = '⏻ 重開機';
  };
  els.btnRebootChecked.addEventListener('click', () => {
    if (checkedPeers.size === 0) return;
    if (!barRebootArmed) {
      barRebootArmed = true;
      els.btnRebootChecked.textContent = '⚠ 確定重開';
      els.btnRebootChecked.classList.add('growing');
      barRebootTimer = window.setTimeout(resetBarReboot, 5000);
      return;
    }
    resetBarReboot();
    let sent = 0;
    for (const peerId of checkedPeers) {
      if (session?.rebootStudent(peerId, 10)) sent++;
    }
    if (sent > 0) {
      log('warn', `勾選的 ${sent} 台已排定 10 秒後重開機（學生機螢幕會顯示 Windows 倒數提示）`);
    } else {
      log('warn', '沒有在線的勾選學生機可重開（離線的請先連線）');
    }
  });

  // ─── 課堂場景鍵：教學活動／學習操作 ───
  els.btnSceneTeach.addEventListener('click', () => {
    void applyScene('teach');
  });
  els.btnSceneLearn.addEventListener('click', () => {
    void applyScene('learn');
  });

  els.btnCloseBrowsers.addEventListener('click', () => {
    if (!session?.isConnected) {
      log('warn', '尚未連線；請先按「連線」再關閉網頁。');
      return;
    }
    const sent = session.closeBrowsersAll();
    log(
      sent > 0 ? 'info' : 'warn',
      sent > 0 ? `已要求 ${sent} 台關閉 Chrome／Edge（一次性動作）` : '沒有學生機可控制（控制通道尚未連上任何一台）。'
    );
  });

  // ─── 開機還原設定 ───
  // 送指令到全部已連線學生機；結果（uwf-result）由 evt 通道回來後列在記錄。
  // 安裝／移除／加排除區仍在協定與學生端支援，但目前 UI 只開放這四個最常用動作；
  // 一律不自動重開機——需要重開機生效的動作請接「重開機全班」。
  const uwfLabels = {
    setup: '初始化還原',
    status: '查還原狀態',
    'maint-on': '維護 開',
    'maint-off': '維護 關',
  } as const;
  const sendUwf = (action: keyof typeof uwfLabels): void => {
    if (!session?.isConnected) {
      log('warn', '尚未連線；請先按「連線」再控制開機還原。');
      return;
    }
    const sent = session.uwfAll(action);
    log(
      sent > 0 ? 'info' : 'warn',
      sent > 0
        ? `已送出「${uwfLabels[action]}」給 ${sent} 台學生機${action === 'setup' ? '（每台螢幕會跳一次 UAC，請按是）' : ''}；結果稍後列在記錄`
        : '沒有學生機可控制（控制通道尚未連上任何一台）。'
    );
  };
  els.btnUwfSetup.addEventListener('click', () => sendUwf('setup'));
  els.btnUwfStatus.addEventListener('click', () => sendUwf('status'));
  els.btnUwfMaintOn.addEventListener('click', () => sendUwf('maint-on'));
  els.btnUwfMaintOff.addEventListener('click', () => sendUwf('maint-off'));

  // 下課收攏：全班關機（不倒數）
  // 狀態流：idle →（第一次按）arm 5 秒 →（第二次按）送出「立即關機」
  let shutdownTimer: number | null = null;
  let shutdownPhase: 'idle' | 'arm' = 'idle';

  const resetShutdownButton = (): void => {
    if (shutdownTimer !== null) {
      window.clearTimeout(shutdownTimer);
      shutdownTimer = null;
    }
    shutdownPhase = 'idle';
    els.btnShutdown.textContent = '⏻ 全班關機';
  };

  els.btnShutdown.addEventListener('click', () => {
    if (!session?.isConnected) {
      log('warn', '尚未連線；請先按「連線」再關機。');
      resetShutdownButton();
      return;
    }

    if (shutdownPhase === 'arm') {
      // 第二次按：立即關機（delaySec=0，不倒數、不可取消）
      const sent = session.shutdownAll(0);
      if (sent > 0) {
        log('info', `已立即關機 ${sent} 台學生機`);
      } else {
        log('warn', '沒有學生機可關機（控制通道尚未連上任何一台）。');
      }
      resetShutdownButton();
      return;
    }

    // 第一次按：進入確認階段（防誤按），5 秒內再按一次＝送出
    shutdownPhase = 'arm';
    els.btnShutdown.textContent = '⚠ 確定關機';
    shutdownTimer = window.setTimeout(() => {
      shutdownTimer = null;
      shutdownPhase = 'idle';
      els.btnShutdown.textContent = '⏻ 全班關機';
    }, 5000);
  });

  // ─── 全班重開機（與全班關機同一套兩按確認；UWF 的重開時機由這裡統一掌控） ───
  let rebootTimer: number | null = null;
  let rebootPhase: 'idle' | 'arm' = 'idle';

  const resetRebootButton = (): void => {
    if (rebootTimer !== null) {
      window.clearTimeout(rebootTimer);
      rebootTimer = null;
    }
    rebootPhase = 'idle';
    els.btnRebootAll.textContent = '⟳ 重開機';
  };

  els.btnRebootAll.addEventListener('click', () => {
    if (!session?.isConnected) {
      log('warn', '尚未連線；請先按「連線」再重開機。');
      resetRebootButton();
      return;
    }

    if (rebootPhase === 'arm') {
      // 第二次按：送出（10 秒倒數，學生機螢幕會顯示提示）
      const sent = session.rebootAll(10);
      if (sent > 0) {
        log('info', `已排定 ${sent} 台學生機 10 秒後重開機`);
      } else {
        log('warn', '沒有學生機可重開（控制通道尚未連上任何一台）。');
      }
      resetRebootButton();
      return;
    }

    rebootPhase = 'arm';
    els.btnRebootAll.textContent = '⚠ 確定重開';
    rebootTimer = window.setTimeout(() => {
      rebootTimer = null;
      rebootPhase = 'idle';
      els.btnRebootAll.textContent = '⟳ 重開機';
    }, 5000);
  });

  els.btnRefresh.addEventListener('click', () => {
    void refreshSources();
  });

  els.sourceSelect.addEventListener('change', () => {
    void updateSourcePreview();
    void window.teacherApi.saveConfig({ lastSourceId: els.sourceSelect.value });
  });

  els.flipCamera.addEventListener('change', async () => {
    const on = els.flipCamera.checked;
    await window.teacherApi.saveConfig({ flipCamera: on });
    log('info', on ? '已啟用攝影機鏡像修正' : '已停用攝影機鏡像修正');
    // 如果正在廣播攝影機，需要重新啟動廣播以套用設定
    if (localStream && broadcastingSourceId?.startsWith('camera:')) {
      log('info', '攝影機鏡像設定變更，重新啟動廣播...');
      await stopBroadcast();
      await startBroadcast();
    }
  });

  // H.264 優先：編碼偏好是「開場協商」決定的，改勾追要下一次重新連線才生效
  els.hardwareCodec.addEventListener('change', async () => {
    const on = els.hardwareCodec.checked;
    config = await window.teacherApi.saveConfig({ hardwareCodec: on });
    log(
      'info',
      on ? '已啟用 H.264 硬體編碼（重連或按「斷線」再「連線」後生效）' : '已停用 H.264 優先，回到預設編碼（重連後生效）'
    );
  });

  // 廣播模式：視訊／圖片逐張。協商方式不同（image 模式不建視訊收發器），
  // 改了要按「斷線」再「連線」才生效。
  els.broadcastMode.addEventListener('change', async () => {
    const mode = els.broadcastMode.value === 'image' ? 'image' : 'video';
    config = await window.teacherApi.saveConfig({ broadcastMode: mode });
    log(
      'info',
      mode === 'image'
        ? '已選「圖片逐張」：無編碼佇列、延遲恆定，學生機 2 張／秒（重連後生效）'
        : '已選「即時畫面」：WebRTC 視訊（重連後生效）'
    );
  });

  els.qualityPreset.addEventListener('change', () => {
    const preset = qualityPresetDef(els.qualityPreset.value);
    // 選到「自訂」只改標籤，數字沿用現值
    if (!preset) {
      void applyQuality({ qualityPreset: 'custom' });
      return;
    }
    void applyQuality({
      qualityPreset: preset.id,
      maxFramerate: preset.maxFramerate,
      maxBitrate: preset.maxBitrate,
      maxCaptureWidth: preset.maxCaptureWidth,
      maxCaptureHeight: preset.maxCaptureHeight,
    });
  });

  // 手動調過任何一個數字就不再是預設，改標籤成「自訂」
  const applyCustomQuality = (): void => {
    const [width, height] = selectedCaptureSize();
    void applyQuality({
      qualityPreset: 'custom',
      maxFramerate: Number(els.qualityFps.value),
      maxBitrate: Math.round(Number(els.qualityBitrate.value) * 1_000_000),
      maxCaptureWidth: width,
      maxCaptureHeight: height,
    });
  };
  els.qualityFps.addEventListener('change', applyCustomQuality);
  els.qualityBitrate.addEventListener('change', applyCustomQuality);
  els.qualitySize.addEventListener('change', applyCustomQuality);

  // 定影幀畫質（圖片模式）：與幀率／頻寬／尺寸各跑各的，不動「自訂」標籤；
  // 泵每一拍都會重新取值，改了下一張定影幀就生效。
  els.qualitySharp.addEventListener('change', () => {
    const quality = Number(els.qualitySharp.value) || 0.85;
    session?.setImgSharpQuality(quality);
    void applyQuality({ imgSharpQuality: quality });
    log('info', `停留幀畫質已設為 ${quality}（下一張定影幀起生效）`);
  });

  // 學生機待機（開機初始）畫面：遠端更換
  els.btnIdleScreen.addEventListener('click', () => {
    if (!session?.isConnected) {
      log('warn', '尚未連線；請先按「連線」再更新待機畫面。');
      return;
    }
    const title = els.idleTitleInput.value.trim();
    const text = els.idleTextInput.value.trim();
    if (!title && !text) {
      log('warn', '請先輸入標題或內容。');
      return;
    }
    const count = session.setIdleScreenAll(title, text);
    log(
      count > 0 ? 'info' : 'warn',
      `待機畫面已送出給 ${count} 台學生機（未廣播的台立即顯示；全部存檔，下次開機也顯示）。`
    );
  });

  // 更換學生機待機底圖：選圖 → 走檔案通道送出（固定檔名「待機畫面.xxx」）
  els.btnIdleImage.addEventListener('click', () => els.idleImageInput.click());
  els.idleImageInput.addEventListener('change', () => {
    const file = els.idleImageInput.files?.[0];
    if (!file) return;
    if (!session?.isConnected) {
      log('warn', '尚未連線；請先按「連線」再更換待機圖。');
      return;
    }
    const count = session.sendIdleImageAll(file);
    els.idleImageLabel.textContent = `${file.name} → ${count} 台`;
    log(count > 0 ? 'info' : 'warn', `待機圖已開始送給 ${count} 台；各台落地後自動套用（取代內建守則海報）。`);
    els.idleImageInput.value = '';
  });

  // ── 白板筆工具列 ──
  document.querySelectorAll<HTMLButtonElement>('.pen-color').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll<HTMLButtonElement>('.pen-color').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      whiteboard?.setColor(btn.dataset.color ?? PEN_COLORS[0]);
    });
  });
  els.penWidth.addEventListener('change', () => whiteboard?.setLineWidth(Number(els.penWidth.value) || 6));
  els.penUndo.addEventListener('click', () => whiteboard?.undo(true));
  els.penClear.addEventListener('click', () => whiteboard?.clear(true));

  // 自適應畫質開關
  els.adaptiveQuality.addEventListener('change', () => {
    const enabled = els.adaptiveQuality.checked;
    session?.setAdaptiveQualityEnabled(enabled);
    log(enabled ? 'info' : 'info', enabled ? '已啟用自適應畫質（網路擁塞時自動降低畫質）' : '已停用自適應畫質');
  });

  els.btnStart.addEventListener('click', () => {
    void startBroadcast();
  });

  els.btnStop.addEventListener('click', () => {
    void stopBroadcast().then(() => {
      // 停止廣播後把所有學生機縮到系統匣
      session?.minimizeAll();
      log('info', '已將全部學生機縮到系統匣');
    });
  });

  els.btnClearLog.addEventListener('click', () => els.log.replaceChildren());

  // 監控牆日誌事件（由 MonitorWall 發送）
  window.addEventListener('monitor-wall-log', (event: Event) => {
    const customEvent = event as CustomEvent<{ level: 'info' | 'warn' | 'error'; message: string }>;
    const { level, message } = customEvent.detail;
    log(level, message);
  });

  // 監控牆開關按鈕（由 MonitorWall 內部綁定 toggle，這裡只做額外初始化）
  els.btnMonitorWall.addEventListener('click', () => {
    // MonitorWall 已在 constructor 處理 toggle，這裡僅確保 session 存在
    if (!session?.isConnected) {
      log('warn', '尚未連線；請先按「連線」再開啟監控牆。');
      if (monitorWall?.isVisible) monitorWall.hide();
    }
  });

  window.addEventListener('beforeunload', () => {
    session?.disconnect();
  });
}

// ───────────────────────────── 啟動 ─────────────────────────────

async function boot(): Promise<void> {
  config = await window.teacherApi.getConfig();
  els.serverUrl.value = config.serverUrl;
  // 資訊組在部署設定把 serverUrl 鎖住時，位址輸入必須唯讀
  els.serverUrl.disabled = config.serverUrlLocked;
  els.teacherName.value = config.teacherName;
  els.classId.value = config.classId || makeClassId();
  els.flipCamera.checked = config.flipCamera ?? false;
  els.hardwareCodec.checked = config.hardwareCodec;
  els.broadcastMode.value = config.broadcastMode === 'image' ? 'image' : 'video';
  fillQualityPresets();
  renderQualityControls();
  els.adaptiveQuality.checked = config.adaptiveQualityEnabled;
  log(
    'info',
    `目前畫質：${qualityPresetDef(config.qualityPreset)?.label ?? '自訂'}（${config.maxFramerate} fps · ` +
      `${config.maxBitrate / 1_000_000} Mbps · ${captureSizeText(config.maxCaptureWidth, config.maxCaptureHeight)}）`
  );

  const info = await window.teacherApi.appInfo();
  teacherAppVersion = info.version;
  log('info', `教師機 v${info.version}（Electron ${info.electron} / Chrome ${info.chrome}）`);
  log('info', '按「連線」加入班級，然後選擇來源並按「開始廣播」。');

  bindEvents();
  await refreshSources();
  renderStudents();
}

void boot();
