import fs from 'node:fs';
import path from 'node:path';

import { DEFAULT_MAX_STUDENTS_PER_ROOM, DEFAULT_SERVER_PORT } from '@classroom/protocol';

export interface ServerConfig {
  host: string;
  port: number;
  maxStudentsPerRoom: number;
  /** 伺服器主動 ping 客戶端的間隔 */
  heartbeatIntervalMs: number;
  /** 連續幾次沒回應就判定離線 */
  heartbeatMissLimit: number;
  /** 閒置房間（無教師在線）保留多久後回收 */
  emptyRoomTtlMs: number;
  verbose: boolean;
}

/** 部署層：與執行檔同資料夾的 config.json */
function configFile(): Partial<ServerConfig> {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(path.dirname(process.execPath), 'config.json'), 'utf8')
    ) as Partial<ServerConfig>;
    const out: Partial<ServerConfig> = {};
    if (typeof raw.host === 'string' && raw.host.trim()) out.host = raw.host.trim();
    if (typeof raw.port === 'number' && Number.isInteger(raw.port) && raw.port > 0) out.port = raw.port;
    if (typeof raw.maxStudentsPerRoom === 'number' && raw.maxStudentsPerRoom > 0) {
      out.maxStudentsPerRoom = Math.round(raw.maxStudentsPerRoom);
    }
    if (typeof raw.heartbeatIntervalMs === 'number' && raw.heartbeatIntervalMs > 0) {
      out.heartbeatIntervalMs = Math.round(raw.heartbeatIntervalMs);
    }
    if (typeof raw.heartbeatMissLimit === 'number' && raw.heartbeatMissLimit > 0) {
      out.heartbeatMissLimit = Math.round(raw.heartbeatMissLimit);
    }
    if (typeof raw.emptyRoomTtlMs === 'number' && raw.emptyRoomTtlMs > 0) {
      out.emptyRoomTtlMs = Math.round(raw.emptyRoomTtlMs);
    }
    if (typeof raw.verbose === 'boolean') out.verbose = raw.verbose;
    return out;
  } catch {
    return {};
  }
}

function readInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function readBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (!raw) return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

export function loadConfig(): ServerConfig {
  const file = configFile();

  return {
    // 預設綁 0.0.0.0 才聽得到教室區網其他機器的連線；
    // 部署 config.json 的 host 或環境變數 CLASSROOM_HOST 都可覆蓋（單機測試就設 127.0.0.1）。
    host: process.env.CLASSROOM_HOST ?? file.host ?? '0.0.0.0',
    port: readInt('CLASSROOM_PORT', file.port ?? DEFAULT_SERVER_PORT),
    maxStudentsPerRoom: readInt('CLASSROOM_MAX_STUDENTS', file.maxStudentsPerRoom ?? DEFAULT_MAX_STUDENTS_PER_ROOM),
    heartbeatIntervalMs: readInt('CLASSROOM_HEARTBEAT_MS', file.heartbeatIntervalMs ?? 5000),
    heartbeatMissLimit: readInt('CLASSROOM_HEARTBEAT_MISS', file.heartbeatMissLimit ?? 3),
    emptyRoomTtlMs: readInt('CLASSROOM_EMPTY_ROOM_TTL_MS', file.emptyRoomTtlMs ?? 10 * 60 * 1000),
    verbose: readBool('CLASSROOM_VERBOSE', file.verbose ?? true),
  };
}
