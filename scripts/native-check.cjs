/**
 * 在 Electron 主行程內驗證原生模組。
 * 用 `electron.exe scripts/native-check.cjs` 執行。
 * 目的：確認 .node 是對「Electron 的 ABI」編的，而不是對 Node 的 ABI。
 */
const path = require('node:path');

const binary = path.resolve(__dirname, '..', 'packages', 'native', 'build', 'Release', 'classroom_input.node');
console.log('[native-check] electron =', process.versions.electron, 'modules(ABI) =', process.versions.modules);
console.log('[native-check] binary   =', binary);

let binding;
try {
  binding = require(binary);
} catch (error) {
  console.log('[native-check] LOAD FAILED:', error && error.message);
  process.exit(1);
}

const metrics = binding.getScreenMetrics();
console.log('[native-check] primary  =', metrics.primaryWidth + 'x' + metrics.primaryHeight);
console.log('[native-check] virtual  =', metrics.width + 'x' + metrics.height, 'x=' + metrics.x, 'y=' + metrics.y);
console.log(
  '[native-check] monitors =',
  metrics.monitors,
  'scale=' + metrics.scaleFactor,
  'dpi=' + metrics.dpiAwareness
);
console.log('[native-check] elevated =', binding.isElevated());
console.log('[native-check] cursor   =', JSON.stringify(binding.getCursorPos()));

const started = binding.hookStart();
console.log('[native-check] hookStart =', started, 'active =', binding.hookIsActive());
binding.hookStop();
console.log('[native-check] hookStop  -> active =', binding.hookIsActive());

console.log('[native-check] OK ✅');
process.exit(0);
