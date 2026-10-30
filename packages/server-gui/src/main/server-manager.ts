import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

import { app } from 'electron';

import type { ControlStatus, ServerRuntimeConfig } from '../shared/ipc.js';

/**
 * 管理 classroom-server.exe 的生命週期。
 *
 * - 伺服器以單檔執行檔（Node SEA）的形式隨控制台一起部署（resources/server/）。
 *   開發環境不存在 exe 時，改用 node（ELECTRON_RUN_AS_NODE）跑 dist/server.cjs 當備援。
 * - stdout/stderr 逐行轉發給 renderer（log 面板）。
 * - 停止用 taskkill /T 砍整棵 process tree，避免SEA 進程留下殘餘。
 *
 * 部署設定檔 config.json 一律放在執行檔同資料夾（伺服機端已支援讀取）：
 * 資訊組可以直接改檔，控制台也可以從 GUI 編輯，重啟伺服生效。
 */

const EXE_NAME = 'classroom-server.exe';

interface ServerManagerOptions {
  onLog: (line: string) => void;
  onStatusChange: () => void;
}

export class ServerManager {
  private child: ChildProcess | null = null;
  private startedAt: number | null = null;
  private manualStop = false;
  private lastExitCode: number | null = null;
  private lastExitSignal: string | null = null;
  private stopping = false;

  constructor(private readonly options: ServerManagerOptions) {}

  // ─────────────────────────── 位置解析 ───────────────────────────

  /** 找 classroom-server 執行檔（打包後在 resources/server/，開發時用 monorepo 相對路徑） */
  exePath(): string {
    const packaged = path.join(process.resourcesPath ?? '', 'server', EXE_NAME);
    if (app.isPackaged && existsSync(packaged)) return packaged;

    const devExe = path.join(app.getAppPath(), '..', 'server', 'dist', EXE_NAME);
    if (existsSync(devExe)) return devExe;

    // 備援：開發環境退回 node 跑 server.cjs
    return path.join(app.getAppPath(), '..', 'server', 'dist', 'server.cjs');
  }

  private isBundledCjs(): boolean {
    return !this.exePath().toLowerCase().endsWith('.exe');
  }

  /** 部署設定檔：與執行檔同資料夾 */
  configPath(): string {
    return path.join(path.dirname(this.exePath()), 'config.json');
  }

  runtimeConfig(): ServerRuntimeConfig {
    const defaults: ServerRuntimeConfig = { host: '0.0.0.0', port: 8787, maxStudentsPerRoom: 60 };
    try {
      const raw = JSON.parse(readFileSync(this.configPath(), 'utf8')) as Record<string, unknown>;
      const config = { ...defaults };
      if (typeof raw.host === 'string' && raw.host.trim()) config.host = raw.host.trim();
      if (typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port > 0) {
        config.port = raw.port;
      }
      if (typeof raw.maxStudentsPerRoom === 'number' && raw.maxStudentsPerRoom > 0) {
        config.maxStudentsPerRoom = Math.round(raw.maxStudentsPerRoom);
      }
      return config;
    } catch {
      return defaults;
    }
  }

  saveRuntimeConfig(patch: Partial<ServerRuntimeConfig>): ServerRuntimeConfig {
    let existing: Record<string, unknown> = {};
    try {
      existing = JSON.parse(readFileSync(this.configPath(), 'utf8')) as Record<string, unknown>;
    } catch {
      // 沒有檔案就建立新的
    }
    if (typeof patch.host === 'string' && patch.host.trim()) existing.host = patch.host.trim();
    if (typeof patch.port === 'number' && Number.isInteger(patch.port) && patch.port > 0) {
      existing.port = patch.port;
    }
    if (typeof patch.maxStudentsPerRoom === 'number' && patch.maxStudentsPerRoom > 0) {
      existing.maxStudentsPerRoom = Math.round(patch.maxStudentsPerRoom);
    }
    writeFileSync(this.configPath(), JSON.stringify(existing, null, 2), 'utf8');
    return this.runtimeConfig();
  }

  status(): ControlStatus {
    const config = this.runtimeConfig();
    const displayHost =
      !config.host || config.host === '0.0.0.0' || config.host === '::' ? localAddressHint() : config.host;
    return {
      running: this.child !== null && !this.stopping,
      pid: this.child !== null ? (this.child.pid ?? null) : null,
      startedAt: this.startedAt,
      exePath: this.exePath(),
      configPath: this.configPath(),
      host: config.host,
      port: config.port,
      serverUrl: `ws://${displayHost}:${config.port}`,
      lastExitCode: this.lastExitCode,
      lastExitSignal: this.lastExitSignal,
    };
  }

  // ─────────────────────────── 生命週期 ───────────────────────────

  async start(): Promise<ControlStatus> {
    if (this.child) return this.status();
    this.manualStop = false;
    this.lastExitCode = null;
    this.lastExitSignal = null;

    const exe = this.exePath();
    const exists = existsSync(exe);
    this.options.onLog(exists ? `[ctl] 啟動伺服機 ${exe}` : `[ctl] ⚠ 找不到執行檔 ${exe}`);
    if (!exists) {
      this.options.onLog('[ctl] 請先執行 npm run pack --workspace @classroom/server 產生 classroom-server.exe');
      return this.status();
    }

    const nodeMode = this.isBundledCjs();
    const child = spawn(
      exe,
      [],
      nodeMode
        ? {
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
            windowsHide: true,
          }
        : { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }
    );

    child.stdout?.on('data', (chunk: Buffer) => {
      for (const line of String(chunk).split(/\r?\n/).slice(0, -1)) {
        this.options.onLog(`[srv] ${line}`);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      for (const line of String(chunk).split(/\r?\n/).slice(0, -1)) {
        this.options.onLog(`[srv] ${line}`);
      }
    });
    child.on('exit', (code, signal) => {
      this.lastExitCode = code;
      this.lastExitSignal = signal;
      const stoppedByUser = this.manualStop;
      this.child = null;
      this.startedAt = null;
      this.options.onLog(
        stoppedByUser
          ? `[ctl] 伺服機已停止（exit=${code ?? signal ?? '?'}）`
          : `[ctl] ⚠ 伺服機自行結束（exit=${code ?? '?'} / signal=${signal ?? '-'}），請看上方 log`
      );
      this.options.onStatusChange();
    });

    this.child = child;
    this.startedAt = Date.now();
    this.options.onStatusChange();
    return this.status();
  }

  async stop(): Promise<ControlStatus> {
    if (!this.child) return this.status();
    const child = this.child;
    this.stopping = true;
    this.manualStop = true;

    // taskkill /T 一併移除所有子行程（Windows 沒有可靠的 tree kill API）
    await new Promise<void>(resolvePromise => {
      execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }, () =>
        resolvePromise()
      );
    });

    // 給 'exit' 事件一點時間觸發
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250));
    this.stopping = false;
    if (this.child === child) {
      this.child = null;
      this.startedAt = null;
      this.options.onStatusChange();
    }
    return this.status();
  }

  async restart(): Promise<ControlStatus> {
    await this.stop();
    return this.start();
  }

  async dispose(): Promise<void> {
    await this.stop();
  }
}

/** 找一個「應該跟別台機器連得上」的本機 IPv4 顯示用 */
function localAddressHint(): string {
  const addrs: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const entry of list ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      addrs.push(entry.address);
    }
  }
  const preferred = addrs.find(a => a.startsWith('192.168.')) ?? addrs.find(a => a.startsWith('10.'));
  return preferred ?? addrs[0] ?? '127.0.0.1';
}
