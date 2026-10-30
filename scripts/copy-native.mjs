import { copyFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = resolve(fileURLToPath(import.meta.url), '..');
const workspaceRoot = resolve(__dirname, '..');

// 只帶執行期真正會被載入的 .node；
// Release 目錄裡的 obj/、.pdb、.iobj、.ipdb、.exp、.lib 都是建置產物，
// 放進封包只會白白增加數十 MB，不再複製。
const binarySrc = resolve(workspaceRoot, 'packages/native/build/Release/classroom_input.node');

if (!existsSync(binarySrc)) {
  console.error('Native binary not found:', binarySrc);
  process.exit(1);
}

// 兩個目的地（其餘舊路徑已從載入順序的備援中移除）：
//   1. packages/student/native    ——  打包後 resources/native（第一優先載入）
//   2. packages/student/dist/main ——  打包後 app/dist/main/native（備援）
const destinations = [
  resolve(workspaceRoot, 'packages/student/native'),
  resolve(workspaceRoot, 'packages/student/dist/main/native'),
];

for (const destDir of destinations) {
  mkdirSync(destDir, { recursive: true });
  copyFileSync(binarySrc, resolve(destDir, 'classroom_input.node'));
  console.log('Native binary copied to', destDir);
}

// Copy index.js to dist/index.js for electron-builder entry point
const indexSrc = resolve(workspaceRoot, 'packages/student/index.js');
const indexDest = resolve(workspaceRoot, 'packages/student/dist/index.js');
if (existsSync(indexSrc)) {
  copyFileSync(indexSrc, indexDest);
  console.log('index.js copied to dist/index.js');
}
