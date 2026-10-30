/**
 * 攝影機畫面的鏡像修正。
 *
 * 有部分攝影機（或它的驅動程式）送出來的畫面本身就是左右相反的（像照鏡子），
 * Chromium 不會幫我們翻回來。這裡不能在 CSS 上用 `transform: scaleX(-1)` 解決：
 * CSS 只翻得到「教師機預覽」那個 <video>，學生機收到的是同一條（鏡像的）視訊軌，
 * 畫面依然是反的；而且同一個 <video> 在「廣播中」會改播已經翻正過的串流，
 * 加了 CSS 反而會把它翻回鏡像。所以必須在**訊框層級**處理。
 *
 * 做法：把來源畫面接到一個隱藏的 <video>，每一格重新畫到 canvas 上
 * （左右翻轉後才畫），再用 `canvas.captureStream()` 產生一條方向正確的新串流。
 * 廣播與預覽都改用這條新串流，老師與學生看到的就都是正的。
 */

/** 預設輸出影格率（攝影機通常就是 30fps）。 */
const DEFAULT_FPS = 30;
/** 下限 1：畫質預設的「每秒 2 張截圖模式」要能真的輸出 2fps。 */
const MIN_FPS = 1;
const MAX_FPS = 60;

export interface MirrorFixer {
  /**
   * 接上（或換上）來源串流，回傳一條左右已修正的新串流。
   *
   * 舊的來源與輸出串流會先被停掉，所以同一個修正器只會有一條來源。
   * 換來源時若舊的輸出串流還在 `RTCRtpSender` 上，請在 `replaceTrack`
   * 之後再 `dispose()`（見 renderer.ts 的 `disposeStaleMirrors`），
   * 否則學生機可能會閃一格黑畫面。
   */
  attach(source: MediaStream, fps?: number): MediaStream;
  /** 停止繪製並釋放來源與輸出串流。重複呼叫是安全的。 */
  dispose(): void;
}

/**
 * 建立一個「左右翻轉」修正器。
 *
 * 為什麼用 `setInterval` 而不是 `requestAnimationFrame`：
 * rAF 在視窗被最小化、或完全被其他視窗蓋住時會被暫停，學生機的畫面會整條凍住。
 * 教師機主視窗已設 `backgroundThrottling: false`（見 main/index.ts），
 * 計時器不會被節流，所以最小化時畫面仍會繼續更新。
 */
export function createMirrorFixer(): MirrorFixer {
  // 這個 <video> 只是「解碼來源」，不會給使用者看。
  // 刻意留在 DOM 裡、放在畫面外（2×2 像素），而不是 display:none：
  // Chromium 對「沒有渲染」的媒體元素可能整個暫停解碼，畫到 canvas 上就沒畫面。
  const video = document.createElement('video');
  video.muted = true;
  video.autoplay = true;
  video.playsInline = true;
  video.setAttribute('aria-hidden', 'true');
  video.style.cssText = 'position:fixed;left:-10px;top:-10px;width:2px;height:2px;opacity:0;pointer-events:none;';
  document.body.append(video);

  const canvas = document.createElement('canvas');
  const context = canvas.getContext('2d', { alpha: false });

  let source: MediaStream | null = null;
  let output: MediaStream | null = null;
  let timer: number | null = null;

  const paint = (): void => {
    const width = video.videoWidth;
    const height = video.videoHeight;
    // 還沒解出第一格時 videoWidth 是 0，沒有東西可以畫。
    if (!width || !height || !context) return;

    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }

    context.save();
    context.translate(width, 0);
    context.scale(-1, 1);
    context.drawImage(video, 0, 0, width, height);
    context.restore();
  };

  const stopTracks = (stream: MediaStream | null): void => {
    if (!stream) return;
    for (const track of stream.getTracks()) track.stop();
  };

  const dispose = (): void => {
    if (timer !== null) {
      window.clearInterval(timer);
      timer = null;
    }
    stopTracks(source);
    stopTracks(output);
    source = null;
    output = null;
    video.srcObject = null;
  };

  return {
    attach(next: MediaStream, fps = DEFAULT_FPS): MediaStream {
      dispose();

      const rate = Math.min(MAX_FPS, Math.max(MIN_FPS, Math.round(fps) || DEFAULT_FPS));

      source = next;
      video.srcObject = next;
      void video.play().catch(() => undefined);

      output = canvas.captureStream(rate);
      timer = window.setInterval(paint, Math.round(1000 / rate));
      return output;
    },
    dispose,
  };
}
