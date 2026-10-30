import os from 'node:os';

import { normalizeMac } from '@classroom/protocol';

import type { NetworkInfo } from '../shared/ipc.js';

/**
 * 找出本機的 IPv4 位址——學生機的「本機名稱」就是這個，而且不開放修改。
 *
 * 為什麼用 IP 當名字：
 * - 老師的清單／事件記錄上直接看到 IP，就知道是哪一台機器，
 *   不必再靠學生自己取的名字（學生亂改名字會讓點名、廣播對象難以辨認）。
 * - 學生機不需要（也不應該）在設定裡改身分，所以欄位是唯讀的。
 *
 * 選擇順序：
 * 1. 私有網段（192.168.x.x、10.x.x.x、172.16～172.31.x.x）——校內網段幾乎都是這幾種；
 * 2. 其他非內部（非 127.0.0.1）的 IPv4；
 * 3. 都沒有就退回 127.0.0.1。
 *
 * 註：這裡取列舉順序的第一個。同一台機器若同時接了多張網卡
 * （例如有線 + 無線 + VPN／虛擬網卡），可能不會剛好挑到對外那張；
 * 屆時以「私有網段優先」決定，實務上校內單一網卡的情境不受影響。
 */
export function detectLocalIp(): string {
  const candidates: string[] = [];

  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      candidates.push(info.address);
    }
  }

  return candidates.find(isPrivate) ?? candidates[0] ?? '127.0.0.1';
}

function isPrivate(address: string): boolean {
  const parts = address.split('.').map(part => Number.parseInt(part, 10));
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  if (a === 10) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * 讀出本機的網卡資訊（一鍵開機用）。
 *
 * 與 `detectLocalIp` 同一套挑網卡的邏輯（私有網段優先），
 * 這樣「顯示名稱＝IP」跟「回報給伺服器的 IP」一定是同一張網卡，
 * 名字和 IP 不會對不上。
 *
 * MAC 清單為什麼不只一個：一台機器常有線上網卡 + 無線網卡 +
 * 虛擬網卡（VPN／Hyper-V）。喚醒封包是照 MAC 送的，而「關機後
 * 還能醒」通常只有有線網卡做得到——但我們事先分不出來，
 * 所以全部回報，教師端照單全發，發錯的封包不會有副作用。
 */
export function detectNetworkInfo(): NetworkInfo {
  const candidates: { address: string; mac: string }[] = [];

  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const mac = normalizeMac(info.mac ?? '');
      if (!mac) continue;
      candidates.push({ address: info.address, mac });
    }
  }

  const primary = candidates.find(item => isPrivate(item.address)) ?? candidates[0];

  const allMacs: string[] = [];
  for (const item of candidates) {
    if (!allMacs.includes(item.mac)) allMacs.push(item.mac);
  }

  // 主網卡排第一：教師端的名單主鍵就是它，其餘網卡只是備援
  const macs = primary ? [primary.mac, ...allMacs.filter(mac => mac !== primary.mac)].slice(0, 4) : allMacs.slice(0, 4);

  return {
    mac: primary?.mac ?? '',
    macs,
    ip: primary?.address ?? '127.0.0.1',
  };
}
