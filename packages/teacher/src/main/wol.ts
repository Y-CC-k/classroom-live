import dgram from 'node:dgram';
import os from 'node:os';

import { buildMagicPacket, normalizeMac, subnetBroadcast } from '@classroom/protocol';

import type { WakeSendResult, WakeTarget } from '../shared/ipc.js';

/**
 * 從教師機主行程發送 Wake-on-LAN magic packet。
 *
 * 使用者選擇「只從教師機發」：不走伺服器、不新增訊息型別。
 * 為了提高命中率，會同時發往：
 * - `255.255.255.255:port`（全域廣播）
 * - 各張實體網卡的子網廣播位址（例如 192.168.1.255）
 * - 名單裡記錄的 IP（單播，保險）
 * 跳過 loopback，預設埠 9（也支援 7）。
 *
 * `options.targets/ports` 主要用於煙霧測試走 127.0.0.1，不污染區網。
 */

export interface WakeOptions {
  targets?: string[];
  ports?: number[];
  /** 僅用於測試：送到這些位址而不是自動偵測 */
  destinations?: string[];
}

function listBroadcastDestinations(): string[] {
  const set = new Set<string>();
  set.add('255.255.255.255');

  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const info of ifaces[name] ?? []) {
      if (info.family !== 'IPv4' || info.internal || !info.address || !info.netmask) continue;
      const bcast = subnetBroadcast(info.address, info.netmask);
      if (bcast) set.add(bcast);
    }
  }

  return [...set];
}

function sendPacket(packet: Uint8Array, address: string, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket('udp4');
    socket.once('error', error => {
      try {
        socket.close();
      } catch {
        // 忽略關閉錯誤
      }
      reject(error);
    });
    socket.bind(() => {
      try {
        socket.setBroadcast(true);
      } catch {
        // 忽略 setBroadcast 錯誤
      }
      socket.send(packet, port, address, error => {
        try {
          socket.close();
        } catch {
          // 忽略關閉錯誤
        }
        if (error) reject(error);
        else resolve(1);
      });
    });
  });
}

export async function wakeTargets(list: WakeTarget[], options: WakeOptions = {}): Promise<WakeSendResult[]> {
  const ports = options.ports?.length ? options.ports : [9, 7];
  const allowed = options.targets?.length
    ? new Set(options.targets.map(mac => normalizeMac(mac)).filter((mac): mac is string => mac !== null))
    : null;

  const items = list.filter(target => {
    if (!allowed) return true;
    if (allowed.has(target.mac)) return true;
    return target.macs.some(mac => allowed.has(mac));
  });

  const autoDests = listBroadcastDestinations();
  const results: WakeSendResult[] = [];

  for (const target of items) {
    const macs = [target.mac, ...(target.macs ?? [])]
      .map(mac => normalizeMac(mac))
      .filter((mac): mac is string => mac !== null)
      .filter((mac, index, all) => all.indexOf(mac) === index);

    const packet = buildMagicPacket(macs[0]!);
    if (!packet) {
      results.push({ mac: target.mac, sentTo: [], count: 0, error: 'MAC 格式錯誤，略過' });
      continue;
    }

    const dests = new Set<string>(options.destinations ?? []);
    if (!options.destinations) {
      for (const d of autoDests) dests.add(d);
      if (target.ip && target.ip !== '127.0.0.1') dests.add(target.ip);
    }

    const sentTo: string[] = [];
    let count = 0;
    let error: string | undefined;

    for (const dest of dests) {
      for (const port of ports) {
        try {
          await sendPacket(packet, dest, port);
          count += 1;
          sentTo.push(`${dest}:${port}`);
        } catch (err) {
          if (!error) error = err instanceof Error ? err.message : String(err);
        }
      }
    }

    results.push({ mac: target.mac, sentTo, count, error });
  }

  return results;
}
