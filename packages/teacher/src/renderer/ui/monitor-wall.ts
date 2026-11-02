/**
 * 教師端多螢幕監控牆 UI 組件。
 *
 * 以 CSS Grid 佈局同時顯示多台學生機的監看畫面（每 3 秒一張 JPEG）。
 * 支援 4／9／16 格分割，格子數量依監看台數自動調整。
 *
 * 整合方式：
 *   import { MonitorWall } from './monitor-wall.js';
 *   const wall = new MonitorWall(container, session);
 *   wall.toggle();          // 開啟／關閉
 *   wall.setStudents(ids);  // 設定監看名單
 */

import { TeacherSession } from '../webrtc/index.js';

/** 監控牆格子數對應的 CSS grid 欄數 */
const COLUMNS_FOR_COUNT: Record<number, string> = {
  1: '1fr',
  2: '1fr 1fr',
  3: '1fr 1fr 1fr',
  4: '1fr 1fr 1fr 1fr',
  5: '1fr 1fr 1fr 1fr 1fr',
  6: '1fr 1fr 1fr 1fr 1fr 1fr',
  7: 'repeat(4, 1fr)',
  8: 'repeat(4, 1fr)',
  9: 'repeat(3, 1fr)',
  10: 'repeat(5, 1fr)',
  11: 'repeat(5, 1fr)',
  12: 'repeat(6, 1fr)',
  13: 'repeat(6, 1fr)',
  14: 'repeat(6, 1fr)',
  15: 'repeat(5, 1fr)',
  16: 'repeat(4, 1fr)',
};

/** 監控牆容器樣式（注入到 document head） */
const WALL_STYLE = `
#monitor-wall {
  /* fixed 全螢幕覆蓋層：main 已佔滿 body 且 overflow hidden，
     一般區塊會被擠出視窗外完全看不到 */
  position: fixed;
  top: 61px;   /* 避開 topbar（與 .layout 的 calc(100% - 61px) 一致） */
  left: 0;
  right: 0;
  bottom: 0;
  display: none;
  grid-template-columns: repeat(4, 1fr);
  grid-auto-rows: minmax(140px, 1fr);   /* 每格最小高度，否則格子塌縮為 0 */
  gap: 8px;
  padding: 8px;
  background: #0d1117;
  border-top: 1px solid var(--line);
  z-index: 500;
  overflow: auto;
}
#monitor-wall.visible {
  display: grid;
}
.wall-cell {
  background: #000;
  border: 1px solid var(--line);
  border-radius: 6px;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
}
.wall-cell.active {
  border-color: var(--ok);
}
.wall-cell.inactive {
  opacity: 0.6;
}
.wall-cell img {
  width: 100%;
  height: 100%;
  object-fit: contain;
  display: block;
}
.wall-cell-name {
  padding: 4px 6px;
  font-size: 11px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  background: rgba(0, 0, 0, 0.55);
  color: var(--text);
}
.wall-cell-meta {
  padding: 2px 6px;
  font-size: 10px;
  color: var(--muted);
  background: rgba(0, 0, 0, 0.45);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.wall-cell.placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted);
  font-size: 12px;
}
`;

/** 監控牆單一格子 */
class WallCell {
  private readonly peerId: string;
  private readonly element: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly nameEl: HTMLElement;
  private readonly metaEl: HTMLElement;
  private currentUrl: string | null = null;

  constructor(peerId: string, studentName: string) {
    this.peerId = peerId;

    this.element = document.createElement('div');
    this.element.className = 'wall-cell inactive';
    this.element.dataset.peerId = peerId;

    this.img = document.createElement('img');
    this.img.alt = studentName;

    this.nameEl = document.createElement('div');
    this.nameEl.className = 'wall-cell-name';
    this.nameEl.textContent = studentName;

    this.metaEl = document.createElement('div');
    this.metaEl.className = 'wall-cell-meta';
    this.metaEl.textContent = '等待畫面…';

    this.element.append(this.img, this.nameEl, this.metaEl);
  }

  get elementRef(): HTMLElement {
    return this.element;
  }

  /** 更新畫面（來自 onWatchFrame 回調） */
  updateFrame(frame: { url: string; width: number; height: number; seq: number }): void {
    // 釋放舊的 blob URL
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
    }
    this.currentUrl = frame.url;
    this.img.src = frame.url;
    this.element.classList.remove('inactive');
    this.element.classList.add('active');
    this.metaEl.textContent = `第 ${frame.seq} 張 · ${frame.width}×${frame.height}`;
  }

  /** 設定為待機（沒有畫面） */
  setIdle(): void {
    this.img.src = '';
    this.element.classList.remove('active');
    this.element.classList.add('inactive');
    this.metaEl.textContent = '未監看';
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
  }

  /** 移除格子 */
  remove(): void {
    this.setIdle();
    this.element.remove();
  }
}

/** 多螢幕監控牆 */
export class MonitorWall {
  private readonly container: HTMLElement;
  private readonly session: TeacherSession;
  private readonly cells = new Map<string, WallCell>();
  private visible = false;
  private readonly toggleBtn: HTMLButtonElement;
  /** 回傳要監看的學生 ID 列表（勾選的台優先，否則全部已連線學生機） */
  private readonly getWatchTargets: () => string[];

  constructor(
    container: HTMLElement,
    session: TeacherSession,
    toggleBtn: HTMLButtonElement,
    getWatchTargets: () => string[]
  ) {
    this.container = container;
    this.session = session;
    this.toggleBtn = toggleBtn;
    this.getWatchTargets = getWatchTargets;

    // 注入樣式
    const styleEl = document.createElement('style');
    styleEl.textContent = WALL_STYLE;
    document.head.appendChild(styleEl);

    // 初始隱藏
    this.container.hidden = true;

    // 綁定開關按鈕
    this.toggleBtn.addEventListener('click', () => this.toggle());

    // 監看幀回調：由 session 傳入
    // 注意：session 的 onWatchFrame 已在 bootstrap 設定，
    // 這裡我們透過 session 取得 currently watching 的 peerId 來決定顯示哪些格子
  }

  /** 開啟／關閉監控牆 */
  toggle(): void {
    if (this.visible) {
      this.hide();
    } else {
      this.show(this.getWatchTargets());
    }
  }

  /** 顯示監控牆並開始監看指定學生 */
  show(peerIds?: string[]): void {
    const targets = peerIds ?? [];
    if (targets.length === 0) {
      this.log('warn', '沒有可監看的學生機：請先勾選學生機，或等學生機連線。');
      return;
    }
    this.setStudents(targets);
    this.container.hidden = false;
    this.container.classList.add('visible');
    this.visible = true;
    this.toggleBtn.textContent = '✕ 隱藏監控牆';
    this.toggleBtn.classList.add('danger');
    this.renderGrid();
    this.log('info', `監控牆已開啟，監看 ${this.cells.size} 台`);
  }

  /** 隱藏監控牆並停止所有監看 */
  hide(): void {
    this.session.unwatchAllStudents();
    this.cells.forEach(cell => cell.setIdle());
    this.container.hidden = true;
    this.container.classList.remove('visible');
    this.visible = false;
    this.toggleBtn.textContent = '🖥 監控牆';
    this.toggleBtn.classList.remove('danger');
    this.log('info', '監控牆已關閉');
  }

  /** 設定監看名單（會立即開始監看這些學生） */
  setStudents(peerIds: string[]): void {
    // 先停止所有舊的監看
    this.session.unwatchAllStudents();
    this.cells.forEach(cell => cell.remove());
    this.cells.clear();

    // 建立新格子並開始監看
    const students = this.session.students();
    for (const peerId of peerIds) {
      const name = students.find(s => s.info.id === peerId)?.info.name ?? peerId;
      const cell = new WallCell(peerId, name);
      this.cells.set(peerId, cell);
      this.container.appendChild(cell.elementRef);
    }

    // 開始監看（間隔 3000ms）
    if (peerIds.length > 0) {
      this.session.watchStudents(peerIds, 3000);
    }

    this.renderGrid();
  }

  /** 根據 cells 數量調整 grid 欄數 */
  private renderGrid(): void {
    const count = this.cells.size;
    if (count === 0) {
      this.container.style.gridTemplateColumns = '1fr';
      return;
    }
    // 找最接近的欄數（不超過 6）
    const entries = Object.entries(COLUMNS_FOR_COUNT) as [string, string][];
    for (const [nStr, template] of entries) {
      const n = Number(nStr);
      if (count <= n) {
        this.container.style.gridTemplateColumns = template;
        return;
      }
    }
    // 超過 16 台：固定 6 欄
    this.container.style.gridTemplateColumns = 'repeat(6, 1fr)';
  }

  /** 處理收到的監看幀 */
  handleWatchFrame(peerId: string, frame: { url: string; width: number; height: number; seq: number }): void {
    const cell = this.cells.get(peerId);
    if (cell) {
      cell.updateFrame(frame);
    }
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    // 透過 dispatch 自定事件讓 bootstrap 接收並記錄到日誌
    const event = new CustomEvent('monitor-wall-log', {
      detail: { level, message },
    });
    window.dispatchEvent(event);
  }

  get isVisible(): boolean {
    return this.visible;
  }
}
