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
  private readonly snapBtn: HTMLButtonElement;
  /** 收藏回調（由 MonitorWall 注入） */
  onSnapshot?: (peerId: string, name: string, blob: Blob) => void;
  /** 接管回調（由 MonitorWall 注入） */
  onControl?: (peerId: string, name: string) => void;
  private readonly controlBtn: HTMLButtonElement;
  /** 示範回調（由 MonitorWall 注入）：把這台的畫面轉發給全班 */
  onDemo?: (peerId: string, name: string) => void;
  private readonly demoBtn: HTMLButtonElement;
  private currentUrl: string | null = null;
  /** 最後一幀的 Blob（📸 收藏用） */
  lastBlob: Blob | null = null;
  /** 最後一次收到幀的時間（0 = 從未收到）；逾時未更新視為離線 */
  lastFrameAt = 0;

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

    // 📸 收藏按鈕：hover 格子顯示，點擊收藏當前畫面
    this.snapBtn = document.createElement('button');
    this.snapBtn.type = 'button';
    this.snapBtn.className = 'wall-cell-snap';
    this.snapBtn.textContent = '📸';
    this.snapBtn.title = '收藏這張畫面';

    // 🎮 接管按鈕：hover 顯示，點擊進入遠端接管
    this.controlBtn = document.createElement('button');
    this.controlBtn.type = 'button';
    this.controlBtn.className = 'wall-cell-control';
    this.controlBtn.textContent = '🎮';
    this.controlBtn.title = '遠端接管（指導操作）';
    this.controlBtn.addEventListener('click', e => {
      e.stopPropagation();
      this.onControl?.(this.peerId, this.nameEl.textContent ?? this.peerId);
    });
    // 📢 示範按鈕：hover 顯示，點擊把這台的畫面轉發給全班
    this.demoBtn = document.createElement('button');
    this.demoBtn.type = 'button';
    this.demoBtn.className = 'wall-cell-demo';
    this.demoBtn.textContent = '📢';
    this.demoBtn.title = '學生示範：把這台的畫面播給全班看';
    this.demoBtn.addEventListener('click', e => {
      e.stopPropagation();
      this.onDemo?.(this.peerId, this.nameEl.textContent ?? this.peerId);
    });
    this.snapBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (this.lastBlob) this.onSnapshot?.(this.peerId, this.nameEl.textContent ?? this.peerId, this.lastBlob);
    });

    this.element.append(this.img, this.nameEl, this.metaEl, this.snapBtn, this.controlBtn, this.demoBtn);
  }

  get elementRef(): HTMLElement {
    return this.element;
  }

  /** 更新畫面（來自 onWatchFrame 回調） */
  updateFrame(frame: { url: string; width: number; height: number; seq: number; blob: Blob }): void {
    this.lastBlob = frame.blob;
    // 釋放舊的 blob URL
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
    }
    this.currentUrl = frame.url;
    this.lastFrameAt = Date.now();
    this.img.src = frame.url;
    this.element.classList.remove('inactive');
    this.element.classList.add('active');
    this.metaEl.textContent = `第 ${frame.seq} 張 · ${frame.width}×${frame.height}`;
  }

  /** 設定為待機（沒有畫面） */
  setIdle(): void {
    this.lastBlob = null;
    this.img.src = '';
    this.element.classList.remove('active');
    this.element.classList.add('inactive');
    this.metaEl.textContent = '未監看';
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
  }

  /** 標記為離線（逾時未收到幀）：灰底＋明確文字，不再像是「應該有影像」 */
  markOffline(): void {
    this.lastBlob = null;
    if (this.currentUrl) {
      URL.revokeObjectURL(this.currentUrl);
      this.currentUrl = null;
    }
    this.img.src = '';
    this.element.classList.remove('active');
    this.element.classList.add('inactive');
    this.metaEl.textContent = '訊號中斷';
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
  /** 幀逾時檢查：每 10 秒掃一次，20 秒沒收到幀的格子標記為離線 */
  private frameCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** 回傳要監看的學生 ID 列表（勾選的台優先，否則全部已連線學生機） */
  private readonly getWatchTargets: () => string[];
  /** 📸 收藏回調：peerId、學生名、當前幀 Blob */
  private readonly onSnapshot: (peerId: string, name: string, blob: Blob) => void;
  /** 🎮 接管回調：peerId、學生名 */
  private readonly onControl: (peerId: string, name: string) => void;
  /** 📢 示範回調：peerId、學生名（把這台的畫面轉發給全班） */
  private readonly onDemo: (peerId: string, name: string) => void;
  /** 監控牆顯示／隱藏時同步視窗全螢幕 */
  private readonly onVisibilityChange: (visible: boolean) => void;

  constructor(
    container: HTMLElement,
    session: TeacherSession,
    toggleBtn: HTMLButtonElement,
    getWatchTargets: () => string[],
    onSnapshot: (peerId: string, name: string, blob: Blob) => void,
    onControl: (peerId: string, name: string) => void,
    onVisibilityChange: (visible: boolean) => void,
    onDemo: (peerId: string, name: string) => void
  ) {
    this.container = container;
    this.session = session;
    this.toggleBtn = toggleBtn;
    this.onSnapshot = onSnapshot;
    this.onControl = onControl;
    this.onVisibilityChange = onVisibilityChange;
    this.onDemo = onDemo;
    this.getWatchTargets = getWatchTargets;

    // 注入樣式
    const styleEl = document.createElement('style');
    styleEl.textContent = WALL_STYLE;
    document.head.appendChild(styleEl);

    // 初始隱藏
    this.container.hidden = true;

    // 綁定開關按鈕
    this.toggleBtn.addEventListener('click', () => this.toggle());

    // 幀逾時檢查（監控牆開啟期間持續運作，學生機離線的格子會標「訊號中斷」）
    this.frameCheckTimer = setInterval(() => this.checkFrameTimeouts(), 10_000);

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
    this.onVisibilityChange(true);
  }

  /** 隱藏監控牆並停止所有監看 */
  hide(): void {
    this.session.unwatchAllStudents();
    // 清空所有格子：不留殘留舊資料，下次開啟乾淨重建
    this.cells.forEach(cell => cell.remove());
    this.cells.clear();
    this.container.hidden = true;
    this.container.classList.remove('visible');
    this.visible = false;
    this.toggleBtn.textContent = '🖥 監控牆';
    this.toggleBtn.classList.remove('danger');
    this.log('info', '監控牆已關閉');
    this.onVisibilityChange(false);
  }

  /** 設定監看名單（會立即開始監看這些學生） */
  setStudents(peerIds: string[]): void {
    // 先停止所有舊的監看，並清空格子與容器（不留殘留舊資料）
    this.session.unwatchAllStudents();
    this.cells.forEach(cell => cell.remove());
    this.cells.clear();
    this.container.replaceChildren();

    // 只為 ctl 通道已連線的台建立格子：
    // 離線機建了格子也不會有影像，只會累積出一堆空格。
    const connected = new Set(this.session.getConnectedStudentIds());
    const watchable = peerIds.filter(id => connected.has(id));
    const skipped = peerIds.length - watchable.length;
    if (skipped > 0) {
      this.log('warn', `${skipped} 台控制通道未連線，已從監控牆排除。`);
    }

    // 建立新格子並開始監看
    const students = this.session.students();
    for (const peerId of watchable) {
      const name = students.find(s => s.info.id === peerId)?.info.name ?? peerId;
      const cell = new WallCell(peerId, name);
      cell.onSnapshot = (pid, nm, blob) => this.onSnapshot(pid, nm, blob);
      cell.onControl = (pid, nm) => this.onControl(pid, nm);
      cell.onDemo = (pid, nm) => this.onDemo(pid, nm);
      this.cells.set(peerId, cell);
      this.container.appendChild(cell.elementRef);
    }

    // 5 秒一張：29 台同時監看時總下行約 1.5 Mbps（3 秒時為 3+ Mbps），
    // 監控牆用途（確認學生在不在/做什麼）不需要更快。
    if (watchable.length > 0) {
      this.session.watchStudents(watchable, 3000);
    }

    this.renderGrid();
  }

  /** 逾時檢查：20 秒沒收到幀的格子標記為「訊號中斷」 */
  private checkFrameTimeouts(): void {
    if (!this.visible) return;
    const now = Date.now();
    for (const cell of this.cells.values()) {
      if (cell.lastFrameAt > 0 && now - cell.lastFrameAt > 20_000) {
        cell.markOffline();
      }
    }
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
  handleWatchFrame(
    peerId: string,
    frame: { url: string; width: number; height: number; seq: number; blob: Blob }
  ): void {
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
