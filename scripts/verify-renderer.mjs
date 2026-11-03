// 驗證 renderer.js 內容（檔案式，避免 shell 轉義）
import fs from 'node:fs';

const r = fs.readFileSync('D:/classroom-live/packages/student/dist/renderer/renderer.js', 'utf8');
// esbuild charset 預設 ascii：中文變 \uXXXX
const lockEscape = '\\u9396\\u5b9a'; // 「鎖定」的 escape
console.log('renderer 鎖定(escape 形式):', r.includes(lockEscape) ? '✓' : '✗');
console.log('renderer setInputLock:', r.includes('setInputLock') ? '✓' : '✗');
// 找 lock case 的上下文（escape 形式的訊息）
const i = r.indexOf('setInputLock');
if (i >= 0) {
  const ctx = r.substring(Math.max(0, i - 600), i + 200);
  // 解碼顯示
  const dec = ctx.replace(/\\u([0-9a-fA-F]{4})/g, (x, h) => String.fromCharCode(parseInt(h, 16)));
  console.log('--- setInputLock 上下文（解碼）---');
  console.log(dec);
}
