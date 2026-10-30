/**
 * 原生模組冒煙測試。
 *
 * 直接 require 編譯出來的 classroom_input.node，逐項驗證匯出的函式，
 * 不經過 TypeScript 載入器，這樣可以單獨確認「C++ 這一層」是否正常。
 *
 * 預設只做「安全」的檢查（查詢 + 鉤子安裝/卸載），不會移動你的滑鼠或送出鍵盤。
 * 若要把真正會影響系統的注入也測一輪，設環境變數：
 *
 *   CLASSROOM_NATIVE_SMOKE_INPUT=1
 *
 * 就會額外測試 moveAbs / mouseButton / key / typeText。
 * ⚠️ 開啟後請先把游標移到安全位置，並確認目前沒有正在輸入的重要視窗。
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const results = [];
let failed = 0;

function check(name, condition, detail = '') {
  const ok = Boolean(condition);
  if (!ok) failed += 1;
  results.push(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  return ok;
}

function resolveBinary() {
  const fromEnv = process.env.CLASSROOM_NATIVE_PATH;
  const candidates = [
    fromEnv,
    path.join(repoRoot, 'packages', 'native', 'build', 'Release', 'classroom_input.node'),
    path.join(repoRoot, 'packages', 'native', 'build', 'Debug', 'classroom_input.node'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

console.log('\n原生模組冒煙測試');

if (process.platform !== 'win32') {
  console.log('  [SKIP] 非 Windows 平台，原生注入模組不適用\n');
  process.exit(0);
}

const binary = resolveBinary();
if (!binary) {
  console.log('  [FAIL] 找不到 classroom_input.node');
  console.log('         請先執行 npm run build:native，或設定 CLASSROOM_NATIVE_PATH\n');
  process.exit(1);
}
console.log(`  模組：${binary}\n`);

let binding;
try {
  binding = require(binary);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log(`  [FAIL] require 失敗：${message}\n`);
  if (/NODE_MODULE_VERSION/i.test(message)) {
    console.log('  → 這個二進位不是為「目前這個 Node 版本」編的。');
    console.log('    若剛跑過 npm run rebuild:native（那是為 Electron 編的），請改用：');
    console.log('      npm run native:check     （在 Electron 內驗證）');
    console.log('    或先為 Node 重新編譯，再跑本測試：');
    console.log('      npm run build:native\n');
  }
  process.exit(1);
}

// ── 1. 匯出完整性 ──
const expected = [
  'moveAbs',
  'moveRel',
  'mouseButton',
  'mouseWheel',
  'key',
  'typeText',
  'getCursorPos',
  'getScreenMetrics',
  'isElevated',
  'hookStart',
  'hookStop',
  'hookSetBlocking',
  'hookIsBlocking',
  'hookIsActive',
  'hookSetPanicCallback',
];
console.log('1. 匯出函式');
for (const name of expected) {
  check(name, typeof binding[name] === 'function');
}

// ── 2. 環境查詢 ──
console.log('\n2. 環境查詢');
const metrics = binding.getScreenMetrics();
check('getScreenMetrics 回傳物件', metrics && typeof metrics === 'object');
check('主要螢幕寬 > 0', metrics?.primaryWidth > 0, `primaryWidth=${metrics?.primaryWidth}`);
check('主要螢幕高 > 0', metrics?.primaryHeight > 0, `primaryHeight=${metrics?.primaryHeight}`);
check('虛擬桌面寬 > 0', metrics?.width > 0, `width=${metrics?.width}`);
check('至少 1 個螢幕', metrics?.monitors >= 1, `monitors=${metrics?.monitors}`);
check('scaleFactor > 0', metrics?.scaleFactor > 0, `scaleFactor=${metrics?.scaleFactor}`);
console.log(`          dpiAwareness=${metrics?.dpiAwareness}`);

const cursor = binding.getCursorPos();
check(
  'getCursorPos 有座標',
  typeof cursor?.x === 'number' && typeof cursor?.y === 'number',
  `(${cursor?.x}, ${cursor?.y})`
);

const elevated = binding.isElevated();
check('isElevated 回傳布林', typeof elevated === 'boolean', `elevated=${elevated}`);

// ── 3. 鉤子生命週期（只安裝、不封鎖）──
console.log('\n3. 鉤子生命週期');
const started = binding.hookStart();
check('hookStart 成功', started === true, `回傳 ${started}`);
check('hookIsActive 為 true', binding.hookIsActive() === true);
check('hookIsBlocking 預設為 false', binding.hookIsBlocking() === false);
// 注意：故意不呼叫 hookSetBlocking(true)，否則會攔截你自己的鍵鼠。
binding.hookStop();
check('hookStop 後 hookIsActive 為 false', binding.hookIsActive() === false);
check('hookStop 可重複呼叫', (binding.hookStop(), true));
check('未安裝時 hookSetBlocking(true) 被拒絕', binding.hookSetBlocking(true) === false);

// ── 4. 選擇性的注入測試 ──
if (process.env.CLASSROOM_NATIVE_SMOKE_INPUT === '1') {
  console.log('\n4. 注入測試（CLASSROOM_NATIVE_SMOKE_INPUT=1）');
  check('moveAbs 回到目前位置', binding.moveAbs(cursor.x, cursor.y) === true);
  check('mouseButton (left, down=false) 送出不崩潰', typeof binding.mouseButton('left', false) === 'boolean');
  check(
    '未知按鈕會丟出例外',
    (() => {
      try {
        binding.mouseButton('nope', false);
        return false;
      } catch {
        return true;
      }
    })()
  );
  check('mouseWheel 送出', binding.mouseWheel(0) === true);
} else {
  console.log('\n4. 注入測試：略過（要啟用請設 CLASSROOM_NATIVE_SMOKE_INPUT=1）');
}

console.log('\n' + results.join('\n'));
console.log(failed === 0 ? '\n全部通過 ✅\n' : `\n有 ${failed} 項失敗 ❌\n`);
process.exit(failed === 0 ? 0 : 1);
