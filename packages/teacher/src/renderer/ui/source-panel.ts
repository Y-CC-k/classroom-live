import { type CaptureSource } from '../../shared/ipc.js';
import { els } from './elements.js';
import type { MirrorFixer } from '../mirror.js';

/** 攝影機預覽用的鏡像修正（螢幕／視窗來源不會用到）。 */
export let previewMirror: MirrorFixer | null = null;
/** 廣播中的攝影機鏡像修正（只有來源是攝影機時才有值）。 */
export let cameraMirror: MirrorFixer | null = null;
/** 目前正在廣播的來源 id（用來決定攝影機預覽能否重用廣播串流）。 */
export const broadcastingSourceId: string | null = null;
/** 遞增權杖：防止非同步的預覽擷取彼此覆蓋。 */
export let previewToken = 0;

/** 釋放已經被換掉的鏡像修正器（務必在 `setLocalStream()` 之後呼叫）。 */
export function disposeStaleMirrors(staleMirrors: MirrorFixer[]): void {
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
export function fixMirrorSource(
  source: MediaStream,
  fps: number,
  slot: 'preview' | 'broadcast',
  flipCamera: boolean,
  staleMirrors: MirrorFixer[]
): MediaStream {
  if (slot === 'preview') {
    previewMirror?.dispose();
    previewMirror = null;
  } else if (cameraMirror) {
    staleMirrors.push(cameraMirror);
    cameraMirror = null;
  }

  if (!flipCamera) return source;

  const fixer = createMirrorFixer();
  if (slot === 'preview') previewMirror = fixer;
  else cameraMirror = fixer;
  return fixer.attach(source, fps);
}

function createMirrorFixer(): MirrorFixer {
  return {
    attach: (_source: MediaStream, _fps: number): MediaStream => _source,
    dispose: () => {},
  };
}

/** 攝影機（含實物投影機）由 renderer 自己列舉。 */
export async function listCameras(
  log: (level: 'info' | 'warn' | 'error', message: string) => void
): Promise<CaptureSource[]> {
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
    log('warn', `列舉攝影機失敗：${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

export function sourceIcon(source: CaptureSource): string {
  if (source.kind === 'screen') return '🖥';
  if (source.kind === 'window') return '🪟';
  return '📷';
}

export async function refreshSources(
  teacherApi: { listSources(): Promise<CaptureSource[]> },
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
  setSources: (sources: CaptureSource[]) => void,
  setPrevious: (previous: string) => void,
  updatePreview: () => Promise<void>
): Promise<void> {
  try {
    const [captured, cameras] = await Promise.all([teacherApi.listSources(), listCameras(log)]);
    setSources([...captured, ...cameras]);
  } catch (error) {
    log('error', `列出擷取來源失敗：${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  els.sourceSelect.replaceChildren();

  // 沒有沿用紀錄時一律預設「整個螢幕」：這是最常用的廣播來源。
  const screenSource = Array.from(els.sourceSelect.options).find(o => o.value === 'screen:');
  if (screenSource) els.sourceSelect.value = screenSource.value;
  await updatePreview();
}

export function currentSource(sources: CaptureSource[]): CaptureSource | null {
  return sources.find(source => source.id === els.sourceSelect.value) ?? null;
}

/** 關掉攝影機預覽串流（切換來源、開始廣播、離開時都要呼叫）。 */
export function releasePreview(): void {
  previewToken += 1;
  previewMirror?.dispose();
  previewMirror = null;
  els.sourceVideo.srcObject = null;
  els.sourceVideo.hidden = true;
}

/**
 * 更新來源預覽。
 *
 * 螢幕／視窗用主行程給的縮圖（``）；攝影機沒有縮圖，
 * 改成真的開一條低解析度的擷取串流（`<video>`）當即時預覽。
 * 正在廣播同一個攝影機時直接重用廣播串流，避免對同一台裝置開兩次擷取。
 */
export async function updateSourcePreview(
  source: CaptureSource | null,
  localStream: MediaStream | null,
  broadcastingSourceId: string | null,
  flipCamera: boolean,
  staleMirrors: MirrorFixer[],
  log: (level: 'info' | 'warn' | 'error', message: string) => void
): Promise<void> {
  // 先關掉舊的（同時讓先前還在進行中的擷取失效），再取新的權杖。
  releasePreview();
  const token = previewToken;
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
      const preview = fixMirrorSource(stream, 15, 'preview', flipCamera, staleMirrors);
      els.sourceVideo.srcObject = preview;
      els.sourceVideo.hidden = false;
      void els.sourceVideo.play().catch(() => undefined);
    } catch (error) {
      log('warn', `攝影機預覽失敗（仍可直接開始廣播）：${error instanceof Error ? error.message : String(error)}`);
      els.sourceVideo.hidden = true;
    }
    return;
  }

  els.sourcePreview.src = source?.thumbnail ?? '';
  els.sourcePreview.alt = source?.name ?? '無來源';
  els.sourcePreview.hidden = !source?.thumbnail;
}

/** 非「整個螢幕」的來源可以廣播，只是畫面範圍不如整個螢幕完整。 */
export function updateSourceWarning(source: CaptureSource | null): void {
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

/** 攝影機第一次擷取成功後才會拿到裝置名稱，順手把下拉選單補正。 */
export function syncCameraLabel(
  source: CaptureSource,
  label: string | undefined,
  flipCamera: boolean,
  staleMirrors: MirrorFixer[],
  updatePreview: () => Promise<void>
): void {
  if (!label || label === source.name) return;
  source.name = label;
  const option = [...els.sourceSelect.options].find(item => item.value === source.id);
  if (option) option.textContent = `${sourceIcon(source)} ${label}`;
  void updatePreview();
}

/**
 * 取得廣播串流。
 *
 * 螢幕／視窗用 Electron 的 `chromeMediaSource: 'desktop'` 舊式約束，
 * 而不是 `getDisplayMedia()`：前者可以搭配自製的來源選擇器，
 * 後者會跳出系統的原生選擇視窗，在課堂上很干擾。
 *
 * 攝影機則走一般的 `deviceId` 約束（實物投影機就是這個）。
 */
export async function captureSource(
  source: CaptureSource,
  config: {
    maxCaptureWidth: number;
    maxCaptureHeight: number;
    maxFramerate: number;
    broadcastMode: 'video' | 'image' | 'sfu';
  },
  flipCamera: boolean,
  staleMirrors: MirrorFixer[],
  _log: (level: 'info' | 'warn' | 'error', message: string) => void
): Promise<MediaStream> {
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
    return fixMirrorSource(stream, config.maxFramerate, 'broadcast', flipCamera, staleMirrors);
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
export function measureStreamSize(stream: MediaStream): Promise<string> {
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
