import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';
import { normalizeMac } from '@classroom/protocol';

import type { WakeTarget } from '../shared/ipc.js';

/**
 * 一鍵開機名單持久化。
 *
 * 存在 `userData/wake-roster.json`（升級重裝不會覆蓋，和 teacher-config.json 同個位置）。
 * 鍵是「主 MAC」（macs[0]），同一台機器重複上線只更新 lastSeenAt/name/ip。
 * 名單上限 500 筆，超過時刪除最久沒見過的，避免無限膨脹。
 */

const FILE_NAME = 'wake-roster.json';
const MAX_ENTRIES = 500;

interface StoredRoster {
  version: 1;
  targets: WakeTarget[];
}

function filePath(): string {
  return path.join(app.getPath('userData'), FILE_NAME);
}

function load(): WakeTarget[] {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), 'utf8')) as Partial<StoredRoster>;
    if (!Array.isArray(raw.targets)) return [];
    const out: WakeTarget[] = [];
    for (const item of raw.targets) {
      if (!item || typeof item !== 'object') continue;
      const mac = normalizeMac(String((item as WakeTarget).mac ?? ''));
      if (!mac) continue;
      const macs = Array.isArray((item as WakeTarget).macs)
        ? ((item as WakeTarget).macs as string[])
            .map(value => normalizeMac(String(value)))
            .filter((value): value is string => value !== null)
            .filter((value, index, all) => all.indexOf(value) === index)
        : [mac];
      if (!macs.includes(mac)) macs.unshift(mac);
      out.push({
        mac,
        macs: macs.slice(0, 4),
        ip: typeof (item as WakeTarget).ip === 'string' ? (item as WakeTarget).ip : undefined,
        name: String((item as WakeTarget).name ?? mac),
        classId: typeof (item as WakeTarget).classId === 'string' ? (item as WakeTarget).classId : undefined,
        lastSeenAt: typeof (item as WakeTarget).lastSeenAt === 'number' ? (item as WakeTarget).lastSeenAt : Date.now(),
      });
    }
    return out;
  } catch {
    return [];
  }
}

function save(targets: WakeTarget[]): void {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    const payload: StoredRoster = { version: 1, targets };
    fs.writeFileSync(filePath(), JSON.stringify(payload, null, 2), 'utf8');
  } catch (error) {
    console.error('[wake-roster] 儲存名單失敗', error);
  }
}

function prune(targets: WakeTarget[]): WakeTarget[] {
  if (targets.length <= MAX_ENTRIES) return targets;
  const sorted = [...targets].sort((a, b) => (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0));
  return sorted.slice(0, MAX_ENTRIES);
}

export class WakeRoster {
  private targets = new Map<string, WakeTarget>();

  constructor() {
    for (const target of load()) this.targets.set(target.mac, target);
  }

  list(): WakeTarget[] {
    return [...this.targets.values()].sort((a, b) => {
      const at = b.lastSeenAt ?? 0;
      const bt = a.lastSeenAt ?? 0;
      if (at !== bt) return at - bt;
      return a.name.localeCompare(b.name);
    });
  }

  /** 合併學生端回報的 MAC（來自 hello/peers）：有的就更新、沒有的就新增 */
  merge(items: Array<Partial<WakeTarget> & { macs?: string[]; mac?: string }>): WakeTarget[] {
    let changed = false;

    for (const item of items) {
      const macs = [...(typeof item.mac === 'string' ? [item.mac] : []), ...(Array.isArray(item.macs) ? item.macs : [])]
        .map(value => normalizeMac(String(value)))
        .filter((value): value is string => value !== null)
        .filter((value, index, all) => all.indexOf(value) === index)
        .slice(0, 4);

      if (macs.length === 0) continue;
      const primary = macs[0]!;
      const existing = this.targets.get(primary);

      const next: WakeTarget = {
        mac: primary,
        macs,
        ip: typeof item.ip === 'string' && item.ip.trim() ? item.ip.trim() : existing?.ip,
        name:
          typeof item.name === 'string' && item.name.trim()
            ? item.name.trim().slice(0, 32)
            : (existing?.name ?? primary),
        classId: typeof item.classId === 'string' && item.classId.trim() ? item.classId.trim() : existing?.classId,
        lastSeenAt: Date.now(),
      };

      if (!existing) {
        this.targets.set(primary, next);
        changed = true;
        continue;
      }

      if (
        existing.ip !== next.ip ||
        existing.name !== next.name ||
        existing.classId !== next.classId ||
        JSON.stringify(existing.macs) !== JSON.stringify(next.macs)
      ) {
        this.targets.set(primary, next);
        changed = true;
      } else {
        // 只更新存活時間
        existing.lastSeenAt = next.lastSeenAt;
        changed = true;
      }
    }

    if (changed) {
      const pruned = prune(this.list());
      this.targets.clear();
      for (const target of pruned) this.targets.set(target.mac, target);
      save(pruned);
    }

    return this.list();
  }
}
