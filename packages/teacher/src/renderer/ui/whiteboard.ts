/**
 * 教師端白板筆：兩種模式共用同一套繪製邏輯。
 *
 * - overlay（疊加）：筆跡蓋在廣播畫面上；座標相對教師擷取畫面 0..1。
 * - standalone（獨立電子白板）：學生機全螢幕白底只顯示筆跡；
 *   白板邏輯比例固定 16:9，兩端 contain 對齊（白紙留白處不影響對位）。
 *
 * 座標正規化到 0..1，學生端按自己的顯示區域等比換算。
 * 本地筆跡保留 strokes 歷史：undo 用 pop + 全量重繪；
 * canvas 尺寸變化（縮放視窗）時也會重繪，筆跡不消失。
 */

export interface PenWire {
  t: 'pen' | 'pen-clear' | 'pen-undo' | 'board-pen' | 'board-clear' | 'board-undo';
  op?: 'down' | 'move' | 'up';
  color?: string;
  width?: number;
  x?: number;
  y?: number;
}

interface Point {
  x: number;
  y: number;
}
interface Stroke {
  color: string;
  width: number;
  points: Point[];
}

export const PEN_COLORS = ['#ff3b30', '#ffd60a', '#34c759', '#0a84ff', '#ffffff'] as const;
/** 獨立白板預設色（白底用深色筆） */
export const BOARD_COLORS = ['#111111', '#e11d2e', '#0a84ff', '#34c759', '#f0a93b'] as const;
/** 獨立白板的邏輯比例（兩端 contain 對齊用） */
export const BOARD_ASPECT = { w: 16, h: 9 };

export type WhiteboardMode = 'overlay' | 'standalone';

export interface WhiteboardOptions {
  mode: WhiteboardMode;
  send: (msg: PenWire) => void;
  /** 疊加模式：目前擷取畫面原始尺寸；獨立模式：固定 16:9 */
  getSourceSize: () => { w: number; h: number };
}

export class Whiteboard {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly opts: WhiteboardOptions;

  private enabled = false;
  private drawing = false;
  private tool: 'pen' | 'eraser' = 'pen';
  private color: string;
  private lineWidth = 6;
  private strokes: Stroke[] = [];
  private current: Stroke | null = null;
  private last: Point = { x: 0, y: 0 };
  /** move 節流：高頻 pointermove 每則都對 N 台送訊息，30ms 合併一次足夠平滑 */
  private lastSentAt = 0;
  private pendingMove: Point | null = null;

  constructor(canvas: HTMLCanvasElement, opts: WhiteboardOptions) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts;
    this.color = opts.mode === 'standalone' ? BOARD_COLORS[0] : PEN_COLORS[0];

    canvas.addEventListener('pointerdown', e => this.onDown(e));
    canvas.addEventListener('pointermove', e => this.onMove(e));
    canvas.addEventListener('pointerup', e => this.onUp(e));
    canvas.addEventListener('pointerleave', e => {
      if (this.drawing) this.onUp(e);
    });
  }

  private emit(kind: 'pen' | 'clear' | 'undo', pt?: Point): void {
    const prefix = this.opts.mode === 'standalone' ? 'board-' : '';
    if (kind === 'clear') {
      this.opts.send({ t: `${prefix}clear` } as PenWire);
    } else if (kind === 'undo') {
      this.opts.send({ t: `${prefix}undo` } as PenWire);
    } else if (pt) {
      const wireColor = this.tool === 'eraser' ? 'eraser' : this.color;
      this.opts.send({
        t: `${prefix}pen`,
        op: 'move',
        color: wireColor,
        width: this.lineWidth,
        x: pt.x,
        y: pt.y,
      } as PenWire);
    }
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.canvas.style.pointerEvents = on ? 'auto' : 'none';
    if (!on) this.clear(false);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  /** 切換工具：eraser 以 destination-out 擦除（筆跡歷史照存，重繪仍正確） */
  setTool(tool: 'pen' | 'eraser'): void {
    this.tool = tool;
  }

  setColor(color: string) {
    this.color = color;
  }

  setLineWidth(px: number): void {
    this.lineWidth = px;
  }

  /** 清除全部筆跡（sync = 同步學生端） */
  clear(sync: boolean): void {
    this.strokes = [];
    this.current = null;
    this.drawing = false;
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (sync) this.emit('clear');
  }

  /** 復原最後一筆（sync = 同步學生端） */
  undo(sync: boolean): void {
    if (this.strokes.length === 0) return;
    this.strokes.pop();
    this.redraw();
    if (sync) this.emit('undo');
  }

  // ── 指標事件 ──

  private onDown(e: PointerEvent): void {
    if (!this.enabled) return;
    this.fit();
    const p = this.toNormalized(e);
    this.drawing = true;
    this.last = p;
    const wireColor = this.tool === 'eraser' ? 'eraser' : this.color;
    this.current = { color: wireColor, width: this.lineWidth, points: [p] };
    this.localSegment(p, p, wireColor, this.lineWidth);
    this.opts.send({
      t: (this.opts.mode === 'standalone' ? 'board-pen' : 'pen') as PenWire['t'],
      op: 'down',
      color: wireColor,
      width: this.lineWidth,
      x: p.x,
      y: p.y,
    });
  }

  private onMove(e: PointerEvent): void {
    if (!this.enabled || !this.drawing || !this.current) return;
    // 先累積，節流送出：60Hz 滑鼠 x N 台連線會把主執行緒/頻寬塞滿
    this.pendingMove = this.toNormalized(e);
    const now = performance.now();
    if (now - this.lastSentAt < 30) return;
    this.lastSentAt = now;
    this.flushMove();
  }

  /** 送出累積的移動點（節流用；onUp 前也會 flush，確保最後位置不丟） */
  private flushMove(): void {
    if (!this.drawing || !this.current || !this.pendingMove) return;
    const p = this.pendingMove;
    this.pendingMove = null;
    this.localSegment(this.last, p, this.current.color, this.current.width);
    this.current.points.push(p);
    this.last = p;
    this.emit('pen', p);
  }

  private onUp(e: PointerEvent): void {
    if (!this.drawing || !this.current) return;
    this.flushMove(); // 節流期間累積的最後位置補送
    const p = this.toNormalized(e);
    this.localSegment(this.last, p, this.current.color, this.current.width);
    this.current.points.push(p);
    this.strokes.push(this.current);
    this.current = null;
    this.drawing = false;
    this.opts.send({
      t: (this.opts.mode === 'standalone' ? 'board-pen' : 'pen') as PenWire['t'],
      op: 'up',
      color: 'eraser' === this.tool ? 'eraser' : this.color,
      width: this.lineWidth,
      x: p.x,
      y: p.y,
    });
  }

  // ── 繪製 ──

  private fit(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(rect.width * (window.devicePixelRatio || 1)));
    const h = Math.max(1, Math.round(rect.height * (window.devicePixelRatio || 1)));
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.redraw();
    }
  }

  /** object-fit: contain 的實際繪製區（寬高與偏移），元素像素座標 */
  private fitBox(): { drawW: number; drawH: number; ox: number; oy: number } {
    const rect = this.canvas.getBoundingClientRect();
    const src = this.opts.mode === 'standalone' ? { w: BOARD_ASPECT.w, h: BOARD_ASPECT.h } : this.opts.getSourceSize();
    const srcAr = src.w > 0 && src.h > 0 ? src.w / src.h : 16 / 9;
    const boxAr = rect.width / Math.max(1, rect.height);
    if (srcAr > boxAr) {
      const drawH = rect.width / srcAr;
      return { drawW: rect.width, drawH, ox: 0, oy: (rect.height - drawH) / 2 };
    }
    const drawW = rect.height * srcAr;
    return { drawW, drawH: rect.height, ox: (rect.width - drawW) / 2, oy: 0 };
  }

  private toNormalized(e: PointerEvent): Point {
    const rect = this.canvas.getBoundingClientRect();
    const { drawW, drawH, ox, oy } = this.fitBox();
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left - ox) / Math.max(1, drawW)));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top - oy) / Math.max(1, drawH)));
    return { x, y };
  }

  private localSegment(from: Point, to: Point, color: string, width: number): void {
    if (!this.ctx) return;
    this.fit();
    const scale = window.devicePixelRatio || 1;
    const { drawW, drawH, ox, oy } = this.fitBox();
    if (color === 'eraser') {
      // 橡皮擦：挖掉已畫內容；筆寬放大 3 倍才擦得乾淨
      this.ctx.globalCompositeOperation = 'destination-out';
      this.ctx.lineWidth = Math.max(1, width * 3 * scale);
      this.ctx.lineCap = 'round';
      this.ctx.lineJoin = 'round';
      this.ctx.beginPath();
      this.ctx.moveTo((ox + from.x * drawW) * scale, (oy + from.y * drawH) * scale);
      this.ctx.lineTo((ox + to.x * drawW) * scale, (oy + to.y * drawH) * scale);
      this.ctx.stroke();
      this.ctx.globalCompositeOperation = 'source-over';
      return;
    }
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = Math.max(1, width * scale);
    this.ctx.lineCap = 'round';
    this.ctx.lineJoin = 'round';
    this.ctx.beginPath();
    this.ctx.moveTo((ox + from.x * drawW) * scale, (oy + from.y * drawH) * scale);
    this.ctx.lineTo((ox + to.x * drawW) * scale, (oy + to.y * drawH) * scale);
    this.ctx.stroke();
  }

  private redraw(): void {
    if (!this.ctx) return;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    for (const stroke of this.strokes) {
      for (let i = 1; i < stroke.points.length; i++) {
        this.localSegment(stroke.points[i - 1]!, stroke.points[i]!, stroke.color, stroke.width);
      }
      if (stroke.points.length === 1) {
        this.localSegment(stroke.points[0]!, stroke.points[0]!, stroke.color, stroke.width);
      }
    }
  }
}
