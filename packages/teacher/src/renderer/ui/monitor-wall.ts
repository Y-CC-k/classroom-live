/**
 * 教師端多螢幕監控牆 UI 組件。
 *
 * 以 CSS Grid 佈局同時顯示多台學生機的監看畫面（低頻 JPEG，台數越多
 * 節奏越慢、幀越小，見 WALL_PARAMS_FOR_COUNT）。
 * 支援 4／9／16 格分割，格子數量依監看台數自動調整。
 *
 * 整合方式（內嵌模式：直接住在中欄容器裡，隨名單自動同步）：
 *   import { MonitorWall } from './monitor-wall.js';
 *   const wall = new MonitorWall(container, session, onSnapshot, onControl, onDemo);
 *   wall.syncStudents();    // 與學生名單同步（學生異動／10 秒定時補看時呼叫）
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

/**
 * 依監看台數決定送圖節奏與幀寬上限。
 *
 * 內嵌在中欄的格子實際只有 200–400px 寬，收大圖是純浪費：預設一律
 * 壓在 480–640px（點選單格放大時才升到 960，見 FOCUS_MAX_WIDTH），
 * 間隔隨台數放寬，把「每秒湧入的張數×位元組」壓在教室網路舒服的範圍。
 *
 * 頻寬估算（480px、q0.62 一張約 10–20KB）：
 *   16 台 × 4 秒 ≈ 60–80 KB/s（約 0.6 Mbps）
 *   30 台 × 5 秒 ≈ 60–120 KB/s（約 1 Mbps）
 */
const WALL_PARAMS_FOR_COUNT = (count: number): { intervalMs: number; maxWidth: number } => {
  if (count <= 4) return { intervalMs: 3000, maxWidth: 640 };
  if (count <= 9) return { intervalMs: 3500, maxWidth: 480 };
  if (count <= 16) return { intervalMs: 4000, maxWidth: 480 };
  return { intervalMs: 5000, maxWidth: 480 };
};

/** 點選格子放大監看：高解析（16:9 → 約 960×540）＋快節奏 */
const FOCUS_INTERVAL_MS = 1500;
const FOCUS_MAX_WIDTH = 960;

/** 監控牆容器樣式（注入到 document head） */
const WALL_STYLE = `
#monitor-wall {
  /* 內嵌模式：直接住在中欄「學生機」面板裡（flex column 的子項），
     永遠顯示——不再有全螢幕覆蓋層與開關按鈕 */
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  grid-auto-rows: minmax(120px, 1fr);   /* 每格最小高度，否則格子塌縮為 0 */
  gap: 8px;
  padding: 4px 2px;
  overflow: auto;
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
.wall-cell-status {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  padding: 2px 6px 4px;
  background: rgba(0, 0, 0, 0.45);
}
.wall-cell.focused {
  grid-column: span 2;
  grid-row: span 2;
  border-color: var(--ok);
  box-shadow: 0 0 0 2px var(--ok);
  z-index: 1;
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
  /** 狀態標籤列（廣播狀態／鎖定／錯誤） */
  private readonly statusEl: HTMLElement;
  private readonly snapBtn: HTMLButtonElement;
  /** 收藏回調（由 MonitorWall 注入） */
  onSnapshot?: (peerId: string, name: string, blob: Blob) => void;
  /** 接管回調（由 MonitorWall 注入） */
  onControl?: (peerId: string, name: string) => void;
  private readonly controlBtn: HTMLButtonElement;
  /** 示範回調（由 MonitorWall 注入）：把這台的畫面轉發給全班 */
  onDemo?: (peerId: string, name: string) => void;
  private readonly demoBtn: HTMLButtonElement;
  /** 點擊格子（不含按鈕）：放大／還原監看（由 MonitorWall 注入） */
  onFocusToggle?: (peerId: string) => void;
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

    this.statusEl = document.createElement('div');
    this.statusEl.className = 'wall-cell-status';

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

    // 點擊格子本體：放大該台（960×540 高解析）；再點一次還原。按鈕已 stopPropagation。
    this.element.addEventListener('click', () => this.onFocusToggle?.(this.peerId));
    this.element.title = '點擊放大監看（960×540）';
    this.snapBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (this.lastBlob) this.onSnapshot?.(this.peerId, this.studentName, this.lastBlob);
    });

    this.element.append(
      this.img, this.nameEl, this.metaEl, this.statusEl, this.snapBtn, this.controlBtn, this.demoBtn
    );
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

  /** 狀態標籤（廣播狀態／鎖定／錯誤）——由 bootstrap 的 renderStudents 更新 */
  setStatus(tags: HTMLElement[]): void {
    this.statusEl.replaceChildren(...tags);
  }

  /** 放大／還原的顯示狀態（格線跨 2×2＋高亮＋提示文字） */
  setFocused(on: boolean): void {
    this.element.classList.toggle('focused', on);
    this.element.title = on ? '點擊還原成牆的節奏' : '點擊放大監看（960×540）';
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
  /** 已成功送出 watch 的台（ctl 未開時 watchStudent 回 false，由 syncStudents 補看） */
  private readonly watched = new Set<string>();
  /** 暫停監看中（接管／白板模式釋放頻寬）：syncStudents 不動作 */
  private suspended = false;
  /** 目前放大監看的台（點選格子；null = 沒有） */
  private focusedPeer: string | null = null;
  /** 幀逾時檢查：每 10 秒掃一次，20 秒沒收到幀的格子標記為離線 */
  private frameCheckTimer: ReturnType<typeof setInterval> | null = null;
  /** 📸 收藏回調：peerId、學生名、當前幀 Blob */
  private readonly onSnapshot: (peerId: string, name: string, blob: Blob) => void;
  /** 🎮 接管回調：peerId、學生名 */
  private readonly onControl: (peerId: string, name: string) => void;
  /** 📢 示範回調：peerId、學生名（把這台的畫面轉發給全班） */
  private readonly onDemo: (peerId: string, name: string) => void;
  /** 目前這面牆的送圖節奏（示範結束後重掛示範者時沿用） */
  private currentIntervalMs = 3000;
  /** 目前這面牆要求的幀寬上限（同上） */
  private currentMaxWidth = 960;

  constructor(
    container: HTMLElement,
    session: TeacherSession,
    onSnapshot: (peerId: string, name: string, blob: Blob) => void,
    onControl: (peerId: string, name: string) => void,
    onDemo: (peerId: string, name: string) => void
  ) {
    this.container = container;
    this.session = session;
    this.onSnapshot = onSnapshot;
    this.onControl = onControl;
    this.onDemo = onDemo;

    // 注入樣式（連線會重建實例：以 id 檢查避免 style 標籤累積）
    if (!document.getElementById('monitor-wall-style')) {
      const styleEl = document.createElement('style');
      styleEl.id = 'monitor-wall-style';
      styleEl.textContent = WALL_STYLE;
      document.head.appendChild(styleEl);
    }

    // 幀逾時檢查（持續運作，學生機離線的格子會標「訊號中斷」）
    this.frameCheckTimer = setInterval(() => this.checkFrameTimeouts(), 10_000);
  }

  /**
   * 與目前學生名單同步（內嵌牆永遠顯示，不需開關）：
   * 新連上的台建立格子並開始監看；離線的台收掉格子；
   * ctl 尚未開的台 watchStudent 回 false，由下次 sync 補看
   * （學生加入後 ctl 協商需 1~2 秒，bootstrap 每 10 秒定期 sync 補上）。
   */
  syncStudents(): void {
    if (this.suspended || !this.session.isConnected) return;
    const students = this.session.students();
    const connected = new Set(this.session.getConnectedStudentIds());
    const targets = students.map(s => s.info.id).filter(id => connected.has(id));

    // 收掉已離線的格子
    for (const [id, cell] of [...this.cells]) {
      if (!connected.has(id)) {
        this.session.watchStudent(id, false);
        cell.remove();
        this.cells.delete(id);
        this.watched.delete(id);
      }
    }

    // 台數越多節奏越慢、幀越小（見 WALL_PARAMS_FOR_COUNT 的頻寬估算）；
    // 跨過檔位（4/9/16 台）時全部重掛，讓新節奏生效。
    const params = WALL_PARAMS_FOR_COUNT(targets.length);
    if (params.intervalMs !== this.currentIntervalMs || params.maxWidth !== this.currentMaxWidth) {
      this.session.unwatchAllStudents();
      this.watched.clear();
      this.currentIntervalMs = params.intervalMs;
      this.currentMaxWidth = params.maxWidth;
      this.log('info', `監看節奏調整：每 ${Math.round(params.intervalMs / 1000)} 秒/張（${targets.length} 台）`);
    }

    // 建立新格子＋開始／補看：成功才記 watched，失敗（ctl 未開）由下次 sync 補看
    for (const peerId of targets) {
      if (!this.cells.has(peerId)) {
        const name = students.find(s => s.info.id === peerId)?.info.name ?? peerId;
        const cell = new WallCell(peerId, name);
        cell.onSnapshot = (pid, nm, blob) => this.onSnapshot(pid, nm, blob);
        cell.onControl = (pid, nm) => this.onControl(pid, nm);
        cell.onDemo = (pid, nm) => this.onDemo(pid, nm);
        cell.onFocusToggle = pid => this.focus(pid);
        cell.setFocused(pid === this.focusedPeer);
        this.cells.set(peerId, cell);
        this.container.appendChild(cell.elementRef);
      }
      if (!this.watched.has(peerId)) {
        if (this.session.watchStudent(peerId, true, this.currentIntervalMs, this.currentMaxWidth)) {
          this.watched.add(peerId);
        }
      }
    }

    this.renderGrid();
  }

  /** 全部收掉（斷線用）：停止監看、清空格子 */
  reset(): void {
    this.session.unwatchAllStudents();
    this.cells.forEach(cell => cell.remove());
    this.cells.clear();
    this.watched.clear();
    this.suspended = false;
    this.renderGrid();
  }

  /** 暫停監看但保留格子（接管／白板模式釋放頻寬用） */
  suspend(): void {
    this.session.unwatchAllStudents();
    this.watched.clear();
    this.suspended = true;
    this.cells.forEach(cell => cell.setIdle());
  }

  /** 恢復監看（依目前名單重新掛起） */
  resume(): void {
    this.suspended = false;
    this.syncStudents();
  }

  /** 釋放資源（斷線後實例不再使用）：停止定時器並清空格子 */
  dispose(): void {
    if (this.frameCheckTimer !== null) {
      clearInterval(this.frameCheckTimer);
      this.frameCheckTimer = null;
    }
    this.reset();
  }

  /** 逾時檢查：20 秒沒收到幀的格子標記為「訊號中斷」 */
  private checkFrameTimeouts(): void {
    if (this.cells.size === 0) return;
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

  /** 處理收到的監看幀；回傳是否有格子消費（false = 呼叫端應 revoke URL 免得洩漏） */
  handleWatchFrame(
    peerId: string,
    frame: { url: string; width: number; height: number; seq: number; blob: Blob }
  ): boolean {
    const cell = this.cells.get(peerId);
    if (!cell) return false;
    cell.updateFrame(frame);
    return true;
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    // 透過 dispatch 自定事件讓 bootstrap 接收並記錄到日誌
    const event = new CustomEvent('monitor-wall-log', {
      detail: { level, message },
    });
    window.dispatchEvent(event);
  }

  /** 目前牆的送圖間隔（示範結束後要把示範者重掛回牆的節奏用） */
  get watchIntervalMs(): number {
    return this.currentIntervalMs;
  }

  /** 目前牆要求的幀寬上限（同上） */
  get watchMaxWidth(): number {
    return this.currentMaxWidth;
  }

  /** 更新某台的狀態標籤（廣播狀態／鎖定／錯誤；沒有格子時忽略） */
  setStatus(peerId: string, tags: HTMLElement[]): void {
    this.cells.get(peerId)?.setStatus(tags);
  }
}
