/**
 * 原生模組的安裝腳本。
 *
 * 設計目標：
 *   1. 優先使用預編譯的二進制檔案（bin/ 目錄），避免在沒有
 *      Visual Studio Build Tools 的機器上編譯失敗。
 *   2. 只有當預編譯檔案不存在時，才回退到 node-gyp 現場編譯。
 *   3. 編譯失敗不中斷安裝，讓應用程式仍可安裝（只是無法
 *      使用遠端控制功能）。
 *
 * 這樣做的好處：
 *   - 一般使用者無需安裝 Visual Studio Build Tools 即可使用
 *   - 開發者仍可透過 npm run build:native 重新編譯
 *   - 部署時可直接使用預編譯二進制，安裝更快
 */

import { spawnSync, execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');

function log(message) {
  console.log(`[native] ${message}`);
}

function warn(message) {
  console.warn(`[native] ${message}`);
}

// 檢查當前 Node.js 的 ABI 版本（用於顯示資訊，不做嚴格比對）
function getNodeABI() {
  try {
    const modules = process.versions.modules;
    if (modules) {
      return parseInt(modules, 10);
    }
    const output = execSync('node -p "process.versions.modules"', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })
      .toString()
      .trim();
    return parseInt(output, 10);
  } catch {
    return null;
  }
}

// 尋找預編譯的二進制檔案
function findPrebuiltBinary() {
  const candidates = [
    // 優先：打包後的預編譯目錄
    path.join(packageRoot, 'bin', `win32-x64-${process.versions.modules}`, 'classroom_input.node'),
    // 次選：build/Release（node-gyp 預設輸出）
    path.join(packageRoot, 'build', 'Release', 'classroom_input.node'),
    path.join(packageRoot, 'build', 'Debug', 'classroom_input.node'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function main() {
  if (process.env.CLASSROOM_SKIP_NATIVE === '1') {
    log('CLASSROOM_SKIP_NATIVE=1，略過原生模組編譯。');
    process.exit(0);
  }

  if (process.platform !== 'win32') {
    log(`非 Windows 平台（${process.platform}），僅支援 Windows 原生模組。`);
    process.exit(0);
  }

  log('開始檢查原生鍵鼠模組…');

  const currentAbi = getNodeABI();
  if (currentAbi) {
    log(`偵測到 Node.js ABI 版本：${currentAbi}`);
  } else {
    warn('無法偵測 Node.js ABI 版本。');
  }

  // 第一優先：使用預編譯二進制
  const prebuilt = findPrebuiltBinary();
  if (prebuilt) {
    log(`發現預編譯二進制：${prebuilt}`);

    // 確保 build/Release 目錄存在，並複製預編譯檔案過去
    const releaseDir = path.join(packageRoot, 'build', 'Release');
    fs.mkdirSync(releaseDir, { recursive: true });
    const targetPath = path.join(releaseDir, 'classroom_input.node');
    fs.copyFileSync(prebuilt, targetPath);
    log(`已複製預編譯檔案至：${targetPath}`);
    log('原生模組預編譯檔案已就緒。');
    process.exit(0);
  }

  // 第二優先：現場編譯 (node-gyp)
  // 注意：需要 Visual Studio Build Tools 2022 與 Python 3.9+
  // 若環境未安裝，此步驟會失敗，但安裝會繼續進行（只是無法使用遠端控制功能）
  log('未找到預編譯二進制檔案。');
  log('將嘗試現場編譯（需要 Visual Studio Build Tools 2022 與 Python 3.9+）…');

  const result = spawnSync(process.platform === 'win32' ? 'node-gyp.cmd' : 'node-gyp', ['rebuild'], {
    cwd: packageRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });

  if (result.status === 0) {
    log('現場編譯完成。');
    process.exit(0);
  }

  // 第三優先：編譯失敗，但安裝繼續進行
  console.warn(`
[native] ────────────────────────────────────────────────────────────────
[native] 原生鍵鼠模組「編譯失敗」，但安裝會繼續進行。
[native]
[native] 影響：
[native]   教師機：功能正常（廣播不需要原生模組）。
[native]   學生機：可以接收廣播，但「鎖定畫面」與「遠端控制鍵鼠」無法使用。
[native]
[native] 要啟用完整功能，請先在 Windows 上準備：
[native]   1. Visual Studio Build Tools 2022，勾選「使用 C++ 的桌面開發」
[native]   2. Python 3.9 以上（3.13 亦支援）
[native]   3. 然後執行：npm run build:native
[native]
[native] 如果只想跳過這個步驟：
[native]   設定環境變數 CLASSROOM_SKIP_NATIVE=1 後再執行 npm install
[native] ────────────────────────────────────────────────────────────────
`);
  process.exit(0);
}

main();
