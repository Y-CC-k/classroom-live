import { FILE_CHUNK_SIZE } from '@classroom/protocol';

/**
 * 圖片廣播抽幀泵（教師端）：
 *
 *   隱藏的 <video>（來源串流）→ canvas 縮放 → JPEG
 *   → 各台學生機的 img 通道逐張送出（hdr JSON → 64KB 裸分片 → end JSON）。
 *
 * 與視訊路徑的根本差異：**沒有編碼佇列**。
 * 教師機來不及就「跳過這張」，永不分堆積；學生端看到的延遲
 * 恆定為「一張圖的送達時間」。
 *
 * 抽照的三道閘門（缺一不送）——「沒圖案的圖」問題就是曾經繞過它們：
 *   1. `play()` 成功且 `!video.paused`：MediaStream 來源即使播放失敗
 *      （自動播放被封）readyState 也會到達 4，但元素裡根本不放幀，
 *      drawImage 只會得到透明畫面 → JPEG 全黑。所以播放失敗要補踢
 *      retry，踢不成這張就不送（等下一拍再試）。
 *   2. `readyState >= 2` 且 `videoWidth > 0`：metadata 與幀真的已解出。
 *   3. 「同一張不重送」：64×64 取樣指紋相同就跳過（靜態簡報零流量）。
 *
 * 另外兩道保護：
 *   1. 通道堆積上限＝「約一張」：塞車就跳張（寧可少一張，不要晚幾秒）。
 *   2. 影片用「8px 縮到牆角＋近零透明度」而不是 display:none——
 *      Chromium 對 display:none / 不參與 composition 的 video
 *      可能暫停渲染出幀，會再次落入「全黑第一張」。
 *
 * 自適應節奏＋兩段畫質（讓「清楚」與「流暢」並存）：
 *   - 畫面靜止：完全不送（指紋閘門），頻寬接近零。
 *   - 畫面開始變化：立刻送一張全尺寸高品質「定影幀」（q0.85）。
 *   - 持續變化（捲動、操作中）：節奏加速到 6fps，改送 1280 寬的小張
 *     （q0.62）——動起來的畫面看不出細節差異，快比細重要。
 *   - 變化停止：補一張全尺寸 q0.85 的銳利定影幀（把停在螢幕上的
 *     最後一幕从他動態幀升級回高畫質），再回到省流節奏。
 *   → 頻寬平均不升反降（靜止零流量），主觀體感從「頓」變「跟手」。
 */

/** 抽照節奏（毫秒）：畫面靜止時的省流節奏，約 2 張／秒 */
const IMG_INTERVAL_MS = 490;
/** 爆發期節奏（毫秒）：畫面持續變化時加速到約 6 張／秒 */
const IMG_BURST_MS = 160;
/** 已連線學生機 ≥20 台時改用的爆發期節奏（多台共享頻寬，保守一點） */
const IMG_BURST_MS_MANY = 230;
/** 定影幀 JPEG 品質的預設值（可由設定檔 imgSharpQuality 覆寫，範圍 0.6–0.97） */
const IMG_SHARP_QUALITY = 0.85;
/** 動態幀 JPEG 品質：捲動／操作中，動起來看不出細節，小張快傳 */
const IMG_MOTION_QUALITY = 0.62;
/** 動態幀寬度上限：爆發期用小張保住速率 */
const IMG_MOTION_WIDTH = 1280;
/** 圖片寬度安全上限（擷取端已照品質設定縮過，這裡是最後一道防線） */
const IMG_MAX_WIDTH = 1920;
/** 第一張還沒量到大小前，允許通道堆積的量 */
const IMG_BACKLOG_FIRST = 768 * 1024;
/** 取樣板邊長（像素）。夠小才不拖慢送圖，也夠表現「有沒有動」 */
const SAMPLE_SIZE = 64;

interface ImagePumpLog {
  (line: string): void;
}

/** 影像統計（每 10 秒一筆） */
export interface ImagePumpStats {
  /** 簡報／捲動等總張數換算的幀率 */
  framesPerSec: number;
  /** 實的所有 img 通道每秒送出的 KB 總量 */
  kbPerSec: number;
  /** 開始廣播以來的累計張數 */
  frames: number;
}

export class ImagePump {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  /** 64×64 取樣板：算「畫面有沒有動」，比看檔案大小準 */
  private sample: HTMLCanvasElement | null = null;
  private lastSampleHash = -1;
  private lastFrameBytes = -1;
  private lastSentAt = 0;
  private busyTask = false;
  /** play() 一次失敗就提醒過的旗標，避免洗版記錄 */
  private playWarned = false;
  /** 成功送出第一張時報一次尺寸，方便對照學生端看到的畫面 */
  private firstSentLogged = false;
  /** 是否處於「畫面持續變化」的爆發期（ true = 動態幀節奏中） */
  private inBurst = false;
  /** 定影幀 JPEG 品質（從設定檔注入，0.6–0.97） */
  private sharpQuality = IMG_SHARP_QUALITY;

  // ── 頻寬統計（每 10 秒回報一次，供教師機介面顯示「網路還是編碼卡哪邊」） ──
  /** 統計窗（10 秒）內送出的張數（全班總和） */
  private statsFrames = 0;
  /** 統計窗內所有 img 通道送出的位元組總量 */
  private statsBytes = 0;
  /** 開始廣播以來的累計張數 */
  private statsTotalFrames = 0;
  /** 統計窗起點（0 = 尚未開始計） */
  private statsWindowStart = 0;

  constructor(
    private readonly getChannels: () => RTCDataChannel[],
    private readonly log: ImagePumpLog = () => undefined,
    private readonly onStats?: (stats: ImagePumpStats) => void
  ) {}

  /** 開始抽幀；stream 由呼叫端負責生命週期，這裡只跟著播出與停播 */
  start(stream: MediaStream): void {
    this.stop();
    try {
      const video = document.createElement('video');
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      // 8px 縮在牆角＋近零透明度：仍在 composition 管線裡、會出幀，
      // 但使用者完全看不到（蓋在全黑 stage 外一樣看不出差異）。
      video.style.cssText =
        'position:fixed;left:0;bottom:0;width:8px;height:8px;opacity:0.01;z-index:-1;pointer-events:none;';
      document.body.append(video);
      video.srcObject = stream;
      void this.ensurePlaying(video);

      const canvas = document.createElement('canvas');
      const sample = document.createElement('canvas');
      sample.width = SAMPLE_SIZE;
      sample.height = SAMPLE_SIZE;

      this.video = video;
      this.canvas = canvas;
      this.sample = sample;
      this.lastFrameBytes = -1;
      this.lastSampleHash = -1;
      this.lastSentAt = 0;
      this.playWarned = false;
      this.firstSentLogged = false;
      this.inBurst = false;
      this.statsFrames = 0;
      this.statsBytes = 0;
      this.statsTotalFrames = 0;
      this.statsWindowStart = 0;

      this.scheduleTick(IMG_INTERVAL_MS);
      this.log('[image] 圖片廣播啟動（自適應：靜止省流／動態約 6 張/秒＋兩段畫質）');
    } catch (error) {
      this.log(`[image] 圖片廣播啟動失敗：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  stop(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.video) this.video.srcObject = null;
    this.video?.remove();
    this.video = null;
    this.canvas = null;
    this.sample = null;
    this.lastFrameBytes = -1;
    this.lastSampleHash = -1;
    this.lastSentAt = 0;
    this.busyTask = false;
    this.inBurst = false;
    this.statsFrames = 0;
    this.statsBytes = 0;
    this.statsTotalFrames = 0;
    this.statsWindowStart = 0;
  }

  /**
   * 每 10 秒回報一次統計窗（張數／位元組總量／累計張數）。
   * 靜止零流量時不會送出幀，統計窗自然拉長——回報值會反映真實平均。
   */
  private emitStats(now: number): void {
    if (!this.onStats) return;
    const elapsed = (now - this.statsWindowStart) / 1000;
    if (elapsed < 10) return;
    this.onStats({
      framesPerSec: Math.round((this.statsFrames / elapsed) * 10) / 10,
      kbPerSec: Math.round(this.statsBytes / 1024 / elapsed),
      frames: this.statsTotalFrames,
    });
    this.statsFrames = 0;
    this.statsBytes = 0;
    this.statsWindowStart = now;
  }

  /** 播放沒起來就補踢；成功靜默，失敗第一次之後不重複洗記錄 */
  private async ensurePlaying(video: HTMLVideoElement): Promise<void> {
    if (!video.paused) return;
    try {
      await video.play();
      this.playWarned = false;
    } catch (error) {
      if (!this.playWarned) {
        this.playWarned = true;
        this.log(`[image] 播放未啟動（${error instanceof Error ? error.name : 'unknown'}），持續重試中`);
      }
    }
  }

  /**
   * 允許通道堆積的上限（約一張）。
   * 定影幀較大給 1.5 張寬限；動態幀較小給 2 張寬限。
   * 永遠不可能積出數秒延遲；塞車的台跳張、不塞車的照收。
   */
  private backlogCeiling(mode: 'sharp' | 'motion'): number {
    const headroom = mode === 'motion' ? 2 : 1.5;
    return this.lastFrameBytes > 0 ? Math.round(this.lastFrameBytes * headroom) + 128 * 1024 : IMG_BACKLOG_FIRST;
  }

  /** 上張 vs 這張的畫面指紋（64×64 縮圖的加總差），完全相同視為畫面沒動 */
  private sampleHash(video: HTMLVideoElement): number {
    const sample = this.sample;
    if (!sample) return -1;
    const ctx = sample.getContext('2d', { willReadFrequently: true });
    if (!ctx) return -2;
    ctx.drawImage(video, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    let hash = 0;
    for (let i = 0; i < data.length; i += 4) {
      hash = (hash + (data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0)) % 0x7fffffff;
    }
    return hash;
  }

  /** 下一次抽照節拍（自適應泵改用自排程喚醒，而非固定間隔） */
  private scheduleTick(delay: number): void {
    this.timer = setTimeout(() => void this.pumpOne(), delay);
  }

  /** 由設定注入定影幀品質；寫碼後立即生效（下一次定影幀就用新值） */
  setSharpQuality(quality: number): void {
    if (!Number.isFinite(quality)) return;
    this.sharpQuality = Math.min(0.97, Math.max(0.6, quality));
  }

  private async pumpOne(): Promise<void> {
    // 保險：上一張壓縮超時還沒跑完也別讓泵斷弦，快拍叫醒
    if (this.busyTask) {
      this.scheduleTick(IMG_BURST_MS);
      return;
    }
    this.busyTask = true;
    let nextDelay = IMG_INTERVAL_MS;
    try {
      const video = this.video;
      const canvas = this.canvas;
      if (!video || !canvas) return;

      // 閘門 1：影片必須「真的在播」。自動播放被封時補踢一次。
      if (video.paused) {
        void this.ensurePlaying(video);
        return; // 沒在播就不送（送出去也只是黑图）
      }

      // 閘門 2：幀真的解出來了才准抽
      if (video.readyState < 2 || video.videoWidth === 0) return;

      const channels = this.getChannels().filter(channel => channel.readyState === 'open');
      if (channels.length === 0) return;

      // 畫面指紋：判定「有沒有動」與「動了之後停了沒」
      let hash = -1;
      try {
        hash = this.sampleHash(video);
      } catch {
        hash = -1; // 取樣失敗 → 不判定，照送
      }
      const changed = hash >= 0 && hash !== this.lastSampleHash;

      // 自適應狀態機：決定這拍要不要送、送哪一種幀
      let mode: 'sharp' | 'motion' | null = null;
      if (changed) {
        if (!this.inBurst) {
          // 變化剛開始（靜止→動）：先送一張高品質定影幀，同時進入爆發期
          mode = 'sharp';
          this.inBurst = true;
        } else {
          // 已在爆發期：持續變化中的動態幀（小張快傳）
          mode = 'motion';
        }
        const burst = channels.length >= 20 ? IMG_BURST_MS_MANY : IMG_BURST_MS;
        nextDelay = burst;
      } else if (this.inBurst) {
        // 動作停了：補一張銳利定影幀把停留的最後一幕升回高畫質，再回省流節奏
        mode = 'sharp';
        this.inBurst = false;
        nextDelay = IMG_INTERVAL_MS;
      } else {
        return; // 完全靜止：什麼都不送（頻寬零）
      }

      const widthCap = mode === 'motion' ? IMG_MOTION_WIDTH : IMG_MAX_WIDTH;
      const quality = mode === 'motion' ? IMG_MOTION_QUALITY : this.sharpQuality;
      const videoWidth = video.videoWidth || IMG_MAX_WIDTH;
      const videoHeight = video.videoHeight || 900;
      const scale = Math.min(1, widthCap / videoWidth);
      canvas.width = Math.round(videoWidth * scale);
      canvas.height = Math.round(videoHeight * scale);

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>(resolve => {
        canvas.toBlob(resolve, 'image/jpeg', quality);
      });
      if (!blob || blob.size === 0) return;

      const buffer = await blob.arrayBuffer();
      let sentCount = 0;
      for (const channel of channels) {
        // 每台自己的堆積檢查：塞車的不送（跳張），其他台照常收到
        if (channel.bufferedAmount > this.backlogCeiling(mode)) continue;
        channel.send(JSON.stringify({ t: 'img-hdr', size: buffer.byteLength }));
        for (let offset = 0; offset < buffer.byteLength; offset += FILE_CHUNK_SIZE) {
          channel.send(buffer.slice(offset, Math.min(offset + FILE_CHUNK_SIZE, buffer.byteLength)));
        }
        channel.send(JSON.stringify({ t: 'img-end' }));
        sentCount++;
      }
      if (sentCount > 0) {
        this.lastFrameBytes = buffer.byteLength;
        this.lastSampleHash = hash;
        this.lastSentAt = Date.now();
        // 統計累計：張數按「拍」計，位元組按各台實送總量計
        const now = Date.now();
        if (this.statsWindowStart === 0) this.statsWindowStart = now;
        this.statsFrames += 1;
        this.statsTotalFrames += 1;
        this.statsBytes += buffer.byteLength * sentCount;
        this.emitStats(now);
      } else {
        // 全部塞車：留在爆發期快一點重試（避免定影幫永遠送不出去）
        nextDelay = IMG_BURST_MS;
      }

      if (!this.firstSentLogged) {
        this.firstSentLogged = true;
        this.log(`[image] 首張已送出 ${canvas.width}×${canvas.height}px（${Math.round(buffer.byteLength / 1024)} KB）`);
      }
    } catch (error) {
      this.log(`[image] 抽幀失敗：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.busyTask = false;
      this.inBurst = false;
      this.scheduleTick(nextDelay);
    }
  }
}
