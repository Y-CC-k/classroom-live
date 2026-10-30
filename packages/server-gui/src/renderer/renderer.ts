import type { ClassroomLiveStat, ControlStatus, ServerLiveStats, ServerRuntimeConfig } from '../shared/ipc.js';

interface ControlApi {
  status: () => Promise<ControlStatus>;
  start: () => Promise<ControlStatus>;
  stop: () => Promise<ControlStatus>;
  restart: () => Promise<ControlStatus>;
  getConfig: () => Promise<ServerRuntimeConfig>;
  saveConfig: (
    patch: Partial<ServerRuntimeConfig>
  ) => Promise<{ ok: boolean; message: string; config: ServerRuntimeConfig }>;
  appInfo: () => Promise<{ version: string; platform: string; electron: string }>;
}

declare global {
  interface Window {
    controlApi: ControlApi;
    controlEvents: {
      onStatus: (callback: (status: ControlStatus) => void) => void;
      onLog: (callback: (line: string) => void) => void;
      onStats: (callback: (stats: ServerLiveStats | null) => void) => void;
    };
  }
}

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
}

const els = {
  dot: $<HTMLSpanElement>('status-dot'),
  text: $('status-text'),
  detail: $('status-detail'),
  connectLine: $('connect-line'),
  start: $<HTMLButtonElement>('btn-start'),
  stop: $<HTMLButtonElement>('btn-stop'),
  restart: $<HTMLButtonElement>('btn-restart'),
  host: $<HTMLInputElement>('cfg-host'),
  port: $<HTMLInputElement>('cfg-port'),
  max: $<HTMLInputElement>('cfg-max'),
  save: $<HTMLButtonElement>('btn-save'),
  saveMessage: $('save-message'),
  configPath: $('config-path'),
  version: $('version'),
  log: $<HTMLPreElement>('log'),
  clearLog: $<HTMLButtonElement>('btn-clear-log'),
  liveStats: $('live-stats'),
};

let busy = false;

function renderStatus(status: ControlStatus): void {
  els.dot.className = `dot ${status.running ? 'on' : 'off'}`;
  els.text.textContent = status.running ? '伺服機執行中' : '伺服機已停止';
  const uptime = status.startedAt != null ? '，已運行 ' + formatUptime(Date.now() - status.startedAt) : '';
  const crashed =
    !status.running && status.lastExitCode != null
      ? `（上次非正常結束：exit=${status.lastExitCode}${status.lastExitSignal ? ` / ${status.lastExitSignal}` : ''}）`
      : '';
  els.detail.textContent = status.running ? `PID ${status.pid}${uptime}` : crashed || '按「啟動」開始服務';

  els.connectLine.innerHTML = `連線位址（給機器設定用）：<b>${escapeHtml(status.serverUrl)}</b> ${escapeHtml(
    `host=${status.host} port=${status.port}`
  )}`;

  els.start.disabled = busy || status.running;
  els.stop.disabled = busy || !status.running;
  els.restart.disabled = busy || !status.running;
  for (const input of [els.host, els.port, els.max]) input.disabled = status.running;
}

function formatUptime(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return h > 0 ? `${h} 小時 ${m} 分` : m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

async function action(kind: 'start' | 'stop' | 'restart'): Promise<void> {
  if (busy) return;
  busy = true;
  renderStatusLock(true);
  try {
    const status = await window.controlApi[kind]();
    renderStatus(status);
  } finally {
    busy = false;
    const status = await window.controlApi.status();
    renderStatus(status);
  }
}

function renderStatusLock(value: boolean): void {
  els.start.disabled = value || els.start.disabled;
  els.stop.disabled = value || !els.start.disabled;
  els.restart.disabled = value;
}

function appendLogLine(line: string): void {
  els.log.textContent += `${line}\n`;
  els.log.scrollTop = els.log.scrollHeight;
}

/** 教室在線統計：每班一行（教師在線／學生人數），空班級不列出 */
function renderStats(stats: ServerLiveStats | null): void {
  if (!stats || !stats.ok) {
    els.liveStats.textContent = '引擎未執行或尚未回應（每 5 秒更新）';
    els.liveStats.classList.add('muted');
    return;
  }
  els.liveStats.classList.remove('muted');
  const rooms = stats.classrooms as ClassroomLiveStat[];
  if (rooms.length === 0) {
    els.liveStats.textContent = '目前沒有任何班級上線。';
    return;
  }
  const lines: string[] = [];
  for (const room of rooms) {
    lines.push(
      `${room.classId} 教師：${room.teacherOnline ? `${room.teacherName} 在線` : '未在線'} 學生：${room.students} 台`
    );
  }
  els.liveStats.innerHTML = lines.map(line => escapeHtml(line).replace('教師：', '<b>教師：</b>')).join('<br />');
}

async function boot(): Promise<void> {
  const info = await window.controlApi.appInfo();
  els.version.textContent = `v${info.version}（Electron ${info.electron}）`;

  const config = await window.controlApi.getConfig();
  els.host.value = config.host;
  els.port.valueAsNumber = config.port;
  els.max.valueAsNumber = config.maxStudentsPerRoom;

  const status = await window.controlApi.status();
  els.configPath.textContent = `設定檔：${status.configPath}`;

  renderStatus(status);

  window.controlEvents.onStatus(renderStatus);
  window.controlEvents.onLog(line => appendLogLine(line));
  window.controlEvents.onStats(renderStats);

  els.start.addEventListener('click', () => void action('start'));
  els.stop.addEventListener('click', () => void action('stop'));
  els.restart.addEventListener('click', () => void action('restart'));

  els.save.addEventListener('click', async () => {
    const host = els.host.value.trim();
    const port = els.port.valueAsNumber;
    const maxStudentsPerRoom = els.max.valueAsNumber;
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(host) && host !== '0.0.0.0') {
      els.saveMessage.textContent = '綁定位址請填 IPv4（例如 0.0.0.0 或 192.168.10.5）';
      return;
    }
    if (!(port >= 1 && port <= 65535)) {
      els.saveMessage.textContent = 'PORT 需在 1–65535 之間';
      return;
    }
    const result = await window.controlApi.saveConfig({ host, port, maxStudentsPerRoom });
    els.saveMessage.textContent = result.message;
    els.host.value = result.config.host;
    els.port.valueAsNumber = result.config.port;
    els.max.valueAsNumber = result.config.maxStudentsPerRoom;

    const status = await window.controlApi.status();
    renderStatus(status);
  });

  els.clearLog.addEventListener('click', () => {
    els.log.textContent = '';
  });

  // 運行中的長時間時間戳更新
  window.setInterval(async () => {
    const status = await window.controlApi.status();
    if (status.running) renderStatus(status);
  }, 15_000);
}

void boot();
