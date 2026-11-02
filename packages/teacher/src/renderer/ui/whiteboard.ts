/**
 * 教師端白板筆：在來源預覽上直接標註，筆跡即時同步到學生機。
 *
 * 座標正規化到 0..1（相對教師擷取畫面，與滑鼠控制同一套語義）；
 * 學生端按自己的顯示區域等比換算繪製（處理 object-fit 的 letterbox）。
 *
 * 本地筆跡保留 strokes 歷史：undo 用 pop + 全量重繪；
 * canvas 尺寸變化（縮放視窗）時也會重繪，筆跡不消失。
 */

export interface PenMessage {
  t: 'pen';
  op: 'down' | 'move' | 'up';
  color: string;
  width: number;
  x: number;
  y: number;
}
export type WhiteboardMessage = PenMessage | { t: 'pen-clear' } | { t: 'pen-undo' };

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

export class Whiteboard {
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly send: (msg: WhiteboardMessage) => void;
  /** 目前擷取畫面的原始尺寸（video.videoWidth 或 img.naturalWidth） */
  private readonly getSourceSize: () => { w: number; h: number };

  private enabled = false;
  private drawing = false;
  private color: string = PEN_COLORS[0];
  private lineWidth = 6;
  private strokes: Stroke[] = [];
  private current: Stroke | null = null;
  private last: Point = { x: 0, y: 0 };

  constructor(
    canvas: HTMLCanvasElement,
    send: (msg: WhiteboardMessage) => void,
    getSourceSize: () => { w: number; h: number }
  ) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.send = send;
    this.getSourceSize = getSourceSize;

    canvas.addEventListener('pointerdown', e => this.onDown(e));
    canvas.addEventListener('pointermove', e => this.onMove(e));
    canvas.addEventListener('pointerup', e => this.onUp(e));
    canvas.addEventListener('pointerleave', e => {
      if (this.drawing) this.onUp(e);
    });
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.canvas.style.pointerEvents = on ? 'auto' : 'none';
    if (!on) this.clear(true);
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setColor(color: string): void {
    this.color = color;
  }

  setLineWidth(px: number): void {
    this.lineWidth = px;
  }

  /** 清除全部筆跡（sync = 同步清學生端） */
  clear(sync: boolean): void {
    this.strokes = [];
    this.current = null;
    this.drawing = false;
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
    if (sync) this.send({ t: 'pen-clear' });
  }

  /** 復原最後一筆（sync = 同步學生端） */
  undo(sync: boolean): void {
    if (this.strokes.length === 0) return;
    this.strokes.pop();
    this.redraw();
    if (sync) this.send({ t: 'pen-undo' });
  }

  // ── 指標事件 ──

  private onDown(e: PointerEvent): void {
    if (!this.enabled) return;
    this.fit();
    const p = this.toNormalized(e);
    this.drawing = true;
    this.last = p;
    this.current = { color: this.color, width: this.lineWidth, points: [p] };
    // 畫一個起始圓點（單擊也有痕跡）
    this.localSegment(p, p, this.color, this.lineWidth);
    this.send({ t: 'pen', op: 'down', color: this.color, width: this.lineWidth, x: p.x, y: p.y });
  }

  private onMove(e: PointerEvent): void {
    if (!this.enabled || !this.drawing || !this.current) return;
    const p = this.toNormalized(e);
    this.localSegment(this.last, p, this.current.color, this.current.width);
    this.current.points.push(p);
    this.last = p;
    this.send({ t: 'pen', op: 'move', color: this.color, width: this.lineWidth, x: p.x, y: p.y });
  }

  private onUp(e: PointerEvent): void {
    if (!this.drawing || !this.current) return;
    const p = this.toNormalized(e);
    this.localSegment(this.last, p, this.current.color, this.current.width);
    this.current.points.push(p);
    this.strokes.push(this.current);
    this.current = null;
    this.drawing = false;
    this.send({ t: 'pen', op: 'up', color: this.color, width: this.lineWidth, x: p.x, y: p.y });
  }

  // ── 繪製 ──

  /** canvas 尺寸跟隨元素；變了就重繪（筆跡歷史都在） */
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
    const src = this.getSourceSize();
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
      // 單點筆畫畫圓點
      if (stroke.points.length === 1) {
        this.localSegment(stroke.points[0]!, stroke.points[0]!, stroke.color, stroke.width);
      }
    }
  }
}
