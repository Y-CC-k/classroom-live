/**
 * 原生模組預編譯腳本。
 *
 * 編譯 native 模組並將輸出複製到 bin/ 目錄，供 install.mjs 優先使用，
 * 避免在沒有 Visual Studio Build Tools 的機器上編譯失敗。
 *
 * 輸出結構：
 *   bin/win32-x64-{node_abi}/classroom_input.node
 *
 * 使用方式：
 *   npm run build:prebuild   (僅限 Windows，需 Visual Studio Build Tools)
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');

function log(message) {
  console.log(`[native:prebuild] ${message}`);
}

function warn(message) {
  console.warn(`[native:prebuild] ${message}`);
}

function main() {
  if (process.platform !== 'win32') {
    warn(`非 Windows 平台（${process.platform}），跳過預編譯。`);
    process.exit(0);
  }

  const abi = process.versions.modules;
  log(`Node.js ABI 版本：${abi}`);

  // 確保 build/Release 目錄存在（node-gyp 會輸出到這裡）
  const releaseDir = path.join(packageRoot, 'build', 'Release');
  fs.mkdirSync(releaseDir, { recursive: true });

  // 執行 node-gyp 編譯
  log('執行 node-gyp rebuild …');
  const result = spawnSync('node-gyp.cmd', ['rebuild'], {
    cwd: packageRoot,
    stdio: 'inherit',
    shell: true,
  });

  if (result.status !== 0) {
    warn('node-gyp 編譯失敗。');
    process.exit(1);
  }

  // 檢查編譯輸出
  const compiledBinary = path.join(releaseDir, 'classroom_input.node');
  if (!fs.existsSync(compiledBinary)) {
    warn(`找不到編譯輸出：${compiledBinary}`);
    process.exit(1);
  }

  // 複製到 bin/ 目錄（預編譯輸出路徑）
  const prebuiltDir = path.join(packageRoot, 'bin', `win32-x64-${abi}`);
  fs.mkdirSync(prebuiltDir, { recursive: true });

  const targetBinary = path.join(prebuiltDir, 'classroom_input.node');
  fs.copyFileSync(compiledBinary, targetBinary);

  log(`預編譯二進制已輸出：${targetBinary}`);
  log('預編譯完成。');
}

main();
