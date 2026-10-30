/**
 * 一鍵備份原始碼：把需要留存的內容壓成單一 zip。
 *
 * 備份內容（排除 node_modules / dist-electron / stroke-practice / 打包輸出）：
 *   - packages\（全部原始碼與設定；排除 node_modules 與 dist 編譯輸出）
 *   - scripts\（建置、部署、煙霧測試、產生選單的全部腳本）
 *   - 根目錄：package.json、package-lock.json、tsconfig.base.json、
 *           README.md、.editorconfig、.gitignore、
 *           start-all.bat、start-server.bat、create-shortcuts.ps1/.vbs、
 *           build-and-deploy-menu.ps1、打包部署選單.bat
 *
 * 輸出：D:\classroom-live-backup\classroom-live-backup-YYYYMMDD-HHMM.zip
 *
 * 用法：node scripts/backup-source.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(path.parse(root).root, 'classroom-live-backup');

function copyTree(src, dst) {
  if (!fs.existsSync(src)) return 0;
  let n = 0;
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) n += copyTree(s, d);
    else {
      fs.copyFileSync(s, d);
      n += 1;
    }
  }
  return n;
}

function stamp() {
  const d = new Date();
  const p = x => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

const work = fs.mkdtempSync(path.join(process.env.TEMP || '.', 'classroom-backup-'));
try {
  let files = 0;

  // 1) packages（原始碼層，排除 node_modules 與 dist）
  files += copyTree(path.join(root, 'packages'), path.join(work, 'packages'));

  // 2) scripts
  files += copyTree(path.join(root, 'scripts'), path.join(work, 'scripts'));

  // 3) 根目錄檔案
  const rootFiles = [
    'package.json',
    'package-lock.json',
    'tsconfig.base.json',
    'README.md',
    '.editorconfig',
    '.gitignore',
    'start-all.bat',
    'start-server.bat',
    'create-shortcuts.ps1',
    'create-shortcuts.vbs',
    'build-and-deploy-menu.ps1',
    '打包部署選單.bat',
  ];
  for (const f of rootFiles) {
    if (fs.existsSync(path.join(root, f))) {
      fs.copyFileSync(path.join(root, f), path.join(work, f));
      files += 1;
    }
  }

  // 4) 打包部署選單也需要 dist-electron 的 config？不需要——安裝包會重打包。
  fs.mkdirSync(outDir, { recursive: true });
  const zipPath = path.join(outDir, `classroom-live-backup-${stamp()}.zip`);
  // powershell Compress-Archive（與專案其他腳本一致）
  execSync(
    `powershell -NoProfile -ExecutionPolicy Bypass -Command "Compress-Archive -Path '${work}\\*' -DestinationPath '${zipPath}' -CompressionLevel Optimal -Force"`,
    { stdio: 'ignore' }
  );

  const mb = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);
  console.log(`備份完成：${zipPath}`);
  console.log(`  檔案數：${files}，大小：${mb} MB`);
  console.log('  （不含 node_modules / dist-electron / dist 編譯輸出 / stroke-practice）');
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
