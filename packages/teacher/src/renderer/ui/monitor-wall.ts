/**
 * 教師端多螢幕監控牆 UI 組件。
 *
 * 以 CSS Grid 佈局同時顯示多台學生機的監看畫面（低頻 JPEG，台數越多
 * 節奏越慢、幀越小，見 WALL_PARAMS_FOR_COUNT）。
 * 支援 4／9／16 格分割，格子數量依監看台數自動調整。
 *
 * 整合方式：
 *   import { MonitorWall } from './monitor-wall.js';
 *   const wall = new MonitorWall(container, session);
 *   wall.toggle();          // 開啟／關閉
 *   wall.setStudents(ids);  // 設定監看名單
 */

import { TeacherSession } from '../webrtc/index.js';

/**
 * 依監看台數決定送圖節奏與幀寬上限。
 *
 * 監控牆統一採「每 3 秒一張」以上的節奏（不傳每秒多張），避免頻寬與
 * 主執行緒解碼爆量。台數多時幀寬再縮小，牆上格子實際只有 200–500px
 * 寬，收 960px 幀是純浪費；間隔隨台數放寬，把「每秒湧入的張數×位元組」
 * 壓在教室網路舒服的範圍（配合學生端錯開相位，不會爆量）。
 *
 * 頻寬估算（480px、q0.62 一張約 10–20KB）：
 *   16 台 × 4 秒 ≈ 60–80 KB/s（約 0.6 Mbps）
 *   30 台 × 5 秒 ≈ 60–120 KB/s（約 1 Mbps）——960px/3 秒時是 3+ Mbps
 */
const WALL_PARAMS_FOR_COUNT = (count: number): { intervalMs: number; maxWidth: number } => {
  if (count <= 4) return { intervalMs: 3000, maxWidth: 960 }; // 每 3 秒一張，格子大，維持清楚度
  if (count <= 9) return { intervalMs: 3000, maxWidth: 640 };
  if (count <= 16) return { intervalMs: 4000, maxWidth: 480 };
  return { intervalMs: 5000, maxWidth: 480 };
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
  max-width: 100%;
  max-height: 100%;
  width: auto;
  height: auto;
  object-fit: contain;
  display: block;
  margin: auto;
  /* 圖片切換時淡入淡出，避免瞬間閃爍 */
  transition: opacity 0.25s ease-in-out;
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
  private readonly studentName: string;
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
    this.studentName = studentName;

    this.element = document.createElement('div');
    this.element.className = 'wall-cell inactive';
    this.element.dataset.peerId = peerId;

    this.img = document.createElement('img');
    this.img.alt = studentName;
    // 非同步解碼：幀到達時不阻塞主執行緒（台數多時一次解碼多張會卡 UI）
    this.img.decoding = 'async';

    this.nameEl = document.createElement('div');
    this.nameEl.className = 'wall-cell-name';
    // IP 前加電腦圖示；回呼（收藏／接管／示範）一律用 this.studentName，避免檔名混進圖示
    this.nameEl.textContent = `🖥 ${studentName}`;

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
      this.onControl?.(this.peerId, this.studentName);
    });
    // 📢 示範按鈕：hover 顯示，點擊把這台的畫面轉發給全班
    this.demoBtn = document.createElement('button');
    this.demoBtn.type = 'button';
    this.demoBtn.className = 'wall-cell-demo';
    this.demoBtn.textContent = '📢';
    this.demoBtn.title = '學生示範：把這台的畫面播給全班看';
    this.demoBtn.addEventListener('click', e => {
      e.stopPropagation();
      this.onDemo?.(this.peerId, this.studentName);
    });
    this.snapBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (this.lastBlob) this.onSnapshot?.(this.peerId, this.studentName, this.lastBlob);
    });

    this.element.append(this.img, this.nameEl, this.metaEl, this.snapBtn, this.controlBtn, this.demoBtn);
  }

  get elementRef(): HTMLElement {
    return this.element;
  }

  /** 更新畫面（來自 onWatchFrame 回調） */
  updateFrame(frame: { url: string; width: number; height: number; seq: number; blob: Blob }): void {
    this.lastBlob = frame.blob;
    this.lastFrameAt = Date.now();
    this.element.classList.remove('inactive');
    this.element.classList.add('active');
    // 不顯示張數及畫面大小
    this.metaEl.textContent = '';

    // Crossfade：先淡出當前圖，新圖載入後再淡入，
    // 避免切換瞬間出現空白/黑色閃爍。
    this.img.style.opacity = '0';
    this.img.src = frame.url;

    const oldUrl = this.currentUrl;
    this.currentUrl = frame.url;

    const onLoaded = () => {
      this.img.style.opacity = '1';
      this.img.removeEventListener('load', onLoaded);
      this.img.removeEventListener('error', onLoaded);
      // 新圖顯示後再釋放舊 blob URL，避免記憶體洩漏
      if (oldUrl) {
        try {
          URL.revokeObjectURL(oldUrl);
        } catch {
          /* 已被釋放或無效，忽略 */
        }
      }
    };
    if (this.img.complete && this.img.naturalWidth > 0) {
      onLoaded();
    } else {
      this.img.addEventListener('load', onLoaded, { once: true });
      this.img.addEventListener('error', onLoaded, { once: true });
    }
  }

  /** 設定為待機（沒有畫面） */
  setIdle(): void {
    this.lastBlob = null;
    // 淡出後再清空圖片，避免瞬間閃爍
    this.img.style.opacity = '0';
    setTimeout(() => {
      this.img.src = '';
      this.element.classList.remove('active');
      this.element.classList.add('inactive');
      this.metaEl.textContent = '未監看';
      if (this.currentUrl) {
        try {
          URL.revokeObjectURL(this.currentUrl);
        } catch {
          /* 忽略 */
        }
        this.currentUrl = null;
      }
    }, 250);
  }

  /** 標記為離線（逾時未收到幀）：灰底＋明確文字，不再像是「應該有影像」 */
  markOffline(): void {
    this.lastBlob = null;
    this.img.style.opacity = '0';
    setTimeout(() => {
      if (this.currentUrl) {
        try {
          URL.revokeObjectURL(this.currentUrl);
        } catch {
          /* 忽略 */
        }
        this.currentUrl = null;
      }
      this.img.src = '';
      this.element.classList.remove('active');
      this.element.classList.add('inactive');
      this.metaEl.textContent = '訊號中斷';
    }, 250);
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
  /** 目前這面牆的送圖節奏（示範結束後重掛示範者時沿用） */
  private currentIntervalMs = 3000;
  /** 目前這面牆要求的幀寬上限（同上） */
  private currentMaxWidth = 960;

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
      this.log('warn', '沒有可監看的學生機：請等學生機連線（控制通道連上即可）。');
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

    // 台數越多節奏越慢、幀越小（見 WALL_PARAMS_FOR_COUNT 的頻寬估算）；
    // 學生端會再錯開各自的取樣相位，N 台的幀不會同一拍湧入。
    const params = WALL_PARAMS_FOR_COUNT(watchable.length);
    this.currentIntervalMs = params.intervalMs;
    this.currentMaxWidth = params.maxWidth;
    if (watchable.length > 0) {
      this.session.watchStudents(watchable, params.intervalMs, params.maxWidth);
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

  /** 根據 cells 數量與容器寬度動態調整 grid 欄數 */
  private renderGrid(): void {
    const count = this.cells.size;
    if (count === 0) {
      this.container.style.gridTemplateColumns = '1fr';
      return;
    }

    // 容器寬度（沒有則先用預設 1200px 估算）
    const containerWidth = this.container.clientWidth || 1200;
    // 每格最小寬度：小於 240px 就不再增加欄數，避免格子擠在一起看不清
    const minCellWidth = 240;
    // 理論上可放的欄數
    let idealCols = Math.floor(containerWidth / minCellWidth);
    if (idealCols < 1) idealCols = 1;
    if (idealCols > 6) idealCols = 6;

    // 欄數不能超過格子數
    const cols = Math.min(idealCols, count);

    this.container.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
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

  /** 目前牆的送圖間隔（示範結束後要把示範者重掛回牆的節奏用） */
  get watchIntervalMs(): number {
    return this.currentIntervalMs;
  }

  /** 目前牆要求的幀寬上限（同上） */
  get watchMaxWidth(): number {
    return this.currentMaxWidth;
  }
}
