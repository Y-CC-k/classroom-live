/**
 * 學生機升級包製作腳本
 *
 * 用途：
 *   將 packages/student/dist/ 壓縮成 .zip 升級包，
 *   教師端可透過「送檔／升級」功能發送給學生機，
 *   學生機收到後會自動解壓覆蓋 resources\app 並重啟。
 *
 * 用法：
 *   npm.cmd run make-upgrade-pack          # 使用預設名稱
 *   npm.cmd run make-upgrade-pack -- --name 學生機升級包 v1.2.0   # 自訂名稱
 *
 * 產出：
 *   D:\classroom-live\學生機升級包 vX.Y.Z.zip
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const studentDist = path.join(root, 'packages', 'student', 'dist');

function log(message) {
  console.log(`[upgrade-pack] ${message}`);
}

// 解析命令列參數 --name <名稱>
const args = process.argv.slice(2);
let customName = null;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--name' && args[i + 1]) {
    customName = args[i + 1];
    i++;
  }
}

// 讀取 student package.json 取得版本
const studentPkgPath = path.join(root, 'packages', 'student', 'package.json');
let version = '0.1.0';
try {
  const studentPkg = JSON.parse(fs.readFileSync(studentPkgPath, 'utf8'));
  version = studentPkg.version || '0.1.0';
} catch {
  log('警告：讀取 student package.json 失敗，使用預設版本 0.1.0');
}

const zipName = customName || `學生機升級包 ${version}.zip`;
const zipPath = path.join(root, zipName);

// 確認 dist 存在
if (!fs.existsSync(studentDist)) {
  console.error(`[upgrade-pack] 找不到 packages/student/dist，請先執行 npm.cmd run build:student`);
  process.exit(1);
}

// 刪除舊的 zip（如果存在）
if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
  log(`已移除舊版升級包：${zipName}`);
}

// 建立 zip（使用 Windows 內建 tar.exe，Windows 10 1803+ 已內建）
log(`開始建置升級包：${zipName}`);

try {
  execSync(`tar.exe -a -cf "${zipPath}" -C "${studentDist}" .`, { stdio: 'inherit' });
} catch (err) {
  console.error(`[upgrade-pack] 建立 zip 失敗：${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

if (fs.existsSync(zipPath)) {
  const size = (fs.statSync(zipPath).size / 1024 / 1024).toFixed(2);
  log(`升級包已建立：${zipPath} (${size} MB)`);
  log(`可直接在教師機「選擇檔案…」選擇此檔案，然後按「送檔／升級」傳送給學生機。`);
  process.exit(0);
} else {
  console.error('[upgrade-pack] 建置失敗：zip 檔案未產生');
  process.exit(1);
}
