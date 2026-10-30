/**
 * Wake-on-LAN（一鍵開機）用的純函式。
 *
 * 這裡刻意只做「算封包／算位址」這種純運算：不 import `node:dgram`、
 * 不碰 DOM，所以同一份程式碼能同時被伺服器（Node）與兩端 Electron 引用。
 * 真正把 UDP 送出去的程式碼放在各自的主行程（目前只有教師機：
 * `packages/teacher/src/main/wol.ts`），因為喚醒封包必須從
 * **跟學生機同一個區網**的機器發出。
 */

/** 正規化 MAC：接受 `:`、`-`、`.` 分隔與大小寫混用，回傳 `aa:bb:cc:dd:ee:ff`。 */
export function normalizeMac(raw: string): string | null {
  const hex = String(raw ?? '')
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  // 全 0 = 網卡沒有 MAC；全 f = 廣播位址。兩者都不是可喚醒的目標。
  if (/^(00){6}$/.test(hex) || /^(ff){6}$/.test(hex)) return null;

  const parts: string[] = [];
  for (let index = 0; index < hex.length; index += 2) parts.push(hex.slice(index, index + 2));
  return parts.join(':');
}

/**
 * 組 Wake-on-LAN 的 magic packet：
 * 6 個 `0xFF` + 目標 MAC 重複 16 次 = 固定 102 bytes。
 * MAC 不合法回傳 null（呼叫端要跳過這一台，不能送出畸形封包）。
 */
export function buildMagicPacket(mac: string): Uint8Array | null {
  const normalized = normalizeMac(mac);
  if (!normalized) return null;

  const octets = normalized.split(':').map(part => Number.parseInt(part, 16));
  const packet = new Uint8Array(6 + 16 * 6);
  packet.fill(0xff, 0, 6);
  for (let repeat = 0; repeat < 16; repeat += 1) packet.set(octets, 6 + repeat * 6);
  return packet;
}

function ipv4ToNumber(address: string): number | null {
  const parts = String(address).split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    value = value * 256 + octet;
  }
  return value;
}

/**
 * 由 IPv4 與子網遮罩算出子網廣播位址。
 * 例：`('192.168.1.20', '255.255.255.0')` → `'192.168.1.255'`。
 *
 * 為什麼需要：`255.255.255.255` 這種全域廣播不一定會被轉發到
 * 子網廣播位址（路由器／AP 常只認後者），兩種都送命中率較高。
 * 遮罩是 /0 時回傳 null——那算出來就是 `255.255.255.255`，重複了。
 */
export function subnetBroadcast(address: string, netmask: string): string | null {
  const ip = ipv4ToNumber(address);
  const mask = ipv4ToNumber(netmask);
  if (ip === null || mask === null || mask === 0) return null;

  const broadcast = (((ip & mask) >>> 0) | (~mask >>> 0)) >>> 0;
  return [(broadcast >>> 24) & 255, (broadcast >>> 16) & 255, (broadcast >>> 8) & 255, broadcast & 255].join('.');
}
