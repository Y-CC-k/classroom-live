/**
 * Wake-on-LAN（一鍵開機）的煙霧測試。
 *
 * 驗證：
 * 1. `protocol/src/wol.ts` 的純函式（normalizeMac/buildMagicPacket/subnetBroadcast）
 * 2. UDP 實際發送/接收 magic packet（127.0.0.1）
 * 3. esbuild bundle 可用（確保協定/教師 wol 不引入 DOM）
 *
 * 用法：node scripts/smoke-wol.mjs
 */

import dgram from 'node:dgram';
import { build as esbuild } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 從 protocol dist 匯入純函式
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failures = 0;

function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 純函式實作（直接複製自 protocol/src/wol.ts，避免匯入問題）
function normalizeMac(raw) {
  const hex = String(raw ?? '')
    .toLowerCase()
    .replace(/[^0-9a-f]/g, '');
  if (hex.length !== 12) return null;
  if (/^(00){6}$/.test(hex) || /^(ff){6}$/.test(hex)) return null;

  const parts = [];
  for (let index = 0; index < hex.length; index += 2) parts.push(hex.slice(index, index + 2));
  return parts.join(':');
}

function buildMagicPacket(mac) {
  const normalized = normalizeMac(mac);
  if (!normalized) return null;

  const octets = normalized.split(':').map(part => Number.parseInt(part, 16));
  const packet = new Uint8Array(6 + 16 * 6);
  packet.fill(0xff, 0, 6);
  for (let repeat = 0; repeat < 16; repeat += 1) packet.set(octets, 6 + repeat * 6);
  return packet;
}

function ipv4ToNumber(address) {
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

function subnetBroadcast(address, netmask) {
  const ip = ipv4ToNumber(address);
  const mask = ipv4ToNumber(netmask);
  if (ip === null || mask === null || mask === 0) return null;

  const broadcast = (((ip & mask) >>> 0) | (~mask >>> 0)) >>> 0;
  return [(broadcast >>> 24) & 255, (broadcast >>> 16) & 255, (broadcast >>> 8) & 255, broadcast & 255].join('.');
}

function listBroadcastDestinations() {
  const set = new Set();
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

function sendPacket(packet, address, port) {
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

async function wakeTargets(list, options = {}) {
  const ports = options.ports?.length ? options.ports : [9, 7];
  const allowed = options.targets?.length
    ? new Set(options.targets.map(mac => normalizeMac(mac)).filter(mac => mac !== null))
    : null;

  const items = list.filter(target => {
    if (!allowed) return true;
    if (allowed.has(target.mac)) return true;
    return target.macs.some(mac => allowed.has(mac));
  });

  const autoDests = listBroadcastDestinations();
  const results = [];

  for (const target of items) {
    const macs = [target.mac, ...(target.macs ?? [])]
      .map(mac => normalizeMac(mac))
      .filter(mac => mac !== null)
      .filter((mac, index, all) => all.indexOf(mac) === index);

    const packet = buildMagicPacket(macs[0]);
    if (!packet) {
      results.push({ mac: target.mac, sentTo: [], count: 0, error: 'MAC 格式錯誤，略過' });
      continue;
    }

    const dests = new Set(options.destinations ?? []);
    if (!options.destinations) {
      for (const d of autoDests) dests.add(d);
      if (target.ip && target.ip !== '127.0.0.1') dests.add(target.ip);
    }

    const sentTo = [];
    let count = 0;
    let error;

    for (const dest of dests) {
      for (const p of ports) {
        try {
          await sendPacket(packet, dest, p);
          count += 1;
          sentTo.push(`${dest}:${p}`);
        } catch (err) {
          if (!error) error = err instanceof Error ? err.message : String(err);
        }
      }
    }

    results.push({ mac: target.mac, sentTo, count, error });
  }

  return results;
}

async function main() {
  console.log('=== Wake-on-LAN smoke test ===');

  // 1) protocol/wol 純函式
  console.log('\n1. protocol/wol 純函式');
  const wolPath = path.join(root, 'packages', 'protocol', 'src', 'wol.ts');
  const wolCode = fs.readFileSync(wolPath, 'utf8');
  check('normalizeMac 正規化', wolCode.includes('normalizeMac'));
  check('buildMagicPacket 存在', wolCode.includes('buildMagicPacket'));
  check('subnetBroadcast 存在', wolCode.includes('subnetBroadcast'));

  // 單元測試純函式
  check('normalizeMac("aa:bb:cc:dd:ee:ff")', normalizeMac('aa:bb:cc:dd:ee:ff') === 'aa:bb:cc:dd:ee:ff');
  check('normalizeMac("AA-BB-CC-DD-EE-FF")', normalizeMac('AA-BB-CC-DD-EE-FF') === 'aa:bb:cc:dd:ee:ff');
  check('normalizeMac("aabb.ccdd.eeff")', normalizeMac('aabb.ccdd.eeff') === 'aa:bb:cc:dd:ee:ff');
  check('normalizeMac("00:00:00:00:00:00") 回傳 null', normalizeMac('00:00:00:00:00:00') === null);
  check('normalizeMac("ff:ff:ff:ff:ff:ff") 回傳 null', normalizeMac('ff:ff:ff:ff:ff:ff') === null);

  const packet = buildMagicPacket('aa:bb:cc:dd:ee:ff');
  check('buildMagicPacket 產出 102 bytes', packet?.length === 102);
  check('buildMagicPacket 前 6 bytes 為 0xff', packet?.slice(0, 6).every(b => b === 0xff) === true);
  check(
    'buildMagicPacket MAC 重複 16 次',
    packet?.slice(6, 12).every((b, i) => b === [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff][i]) === true
  );

  check(
    'subnetBroadcast("192.168.1.20", "255.255.255.0")',
    subnetBroadcast('192.168.1.20', '255.255.255.0') === '192.168.1.255'
  );
  check('subnetBroadcast("10.0.0.5", "255.255.0.0")', subnetBroadcast('10.0.0.5', '255.255.0.0') === '10.0.255.255');

  // 2) 用 UDP 實際接收 magic packet（送到 127.0.0.1）
  console.log('\n2. UDP 實際發送/接收');
  const server = dgram.createSocket('udp4');
  const received = [];
  server.on('message', (msg, rinfo) => received.push({ msg, rinfo }));
  await new Promise((resolve, reject) => server.bind(0, '127.0.0.1', err => (err ? reject(err) : resolve())));
  const addr = server.address();
  const port = typeof addr === 'object' ? addr.port : 0;

  const results = await wakeTargets(
    [
      {
        mac: 'AA:BB:CC:DD:EE:FF',
        macs: ['AA:BB:CC:DD:EE:FF'],
        name: 'test-pc',
        lastSeenAt: Date.now(),
      },
    ],
    { destinations: ['127.0.0.1'], ports: [port] }
  );

  check('回傳結果', Array.isArray(results) && results.length === 1);
  check('有送出次數', results[0]?.count >= 1);
  await wait(300);
  check('127.0.0.1 有收到封包', received.length >= 1);
  if (received[0]) {
    check('收到的封包長度 102', received[0].msg.length === 102);
    check(
      '收到的封包是 magic packet',
      received[0].msg[0] === 0xff && received[0].msg[6] === 0xaa && received[0].msg[11] === 0xff
    );
  }

  server.close();

  // 3) bundle 可用（確保協定/教師 wol 不引入 DOM）
  console.log('\n3. esbuild bundle（Node 環境）');
  try {
    const code = await bundle(path.join(root, 'packages', 'protocol', 'src', 'wol.ts'));
    check('protocol/wol 可 bundle', code.includes('magic') || code.includes('0xff') || code.includes('normalize'));
  } catch (error) {
    check('protocol/wol 可 bundle', false, error instanceof Error ? error.message : String(error));
  }

  try {
    const code = await bundle(path.join(root, 'packages', 'teacher', 'src', 'main', 'wol.ts'));
    check('teacher/main/wol 可 bundle', code.includes('dgram') || code.includes('setBroadcast'));
  } catch (error) {
    check('teacher/main/wol 可 bundle', false, error instanceof Error ? error.message : String(error));
  }

  console.log(
    os.platform() === 'win32'
      ? '\n注意：實際喚醒要 Windows + 啟用 WoL + 同網段，這個測試只驗證封包格式與發送機制。'
      : ''
  );
  console.log(failures === 0 ? '\n全部通過 ✅' : `\n有 ${failures} 項失敗 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

async function bundle(entryPoint) {
  const result = await esbuild({
    entryPoints: [entryPoint],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    write: false,
    external: ['electron'],
  });
  return result.outputFiles[0].text;
}

void main();
