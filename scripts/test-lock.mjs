// 本地實測：提取 INPUT_BLOCKER_PS_SCRIPT 並執行（3 秒後殺掉）
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const src = fs.readFileSync('D:/classroom-live/packages/student/src/main/input-lock.ts', 'utf8');
const start = src.indexOf('`', src.indexOf('INPUT_BLOCKER_PS_SCRIPT'));
const end = src.indexOf('`.trim()', start);
if (start < 0 || end < 0) {
  console.log('提取失敗');
  process.exit(1);
}
const script = src.substring(start + 1, end);
console.log('--- PS 腳本長度:', script.length, '---');

const enc = Buffer.from(script, 'utf16le').toString('base64');
const child = spawn('powershell.exe', [
  '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc,
], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

let out = '';
child.stdout?.on('data', (chunk) => { out += String(chunk); console.log('[stdout]', String(chunk).trim().substring(0, 200)); });
child.stderr?.on('data', (chunk) => { console.log('[stderr]', String(chunk).trim().substring(0, 300)); });
child.on('exit', (code) => console.log('[exit] code=', code));

setTimeout(() => {
  console.log('--- 3 秒後終止 ---');
  child.kill();
}, 3000);
setTimeout(() => {
  console.log('--- 完整 stdout ---');
  console.log(out || '(空)');
  process.exit(0);
}, 4000);
