// 探查：student/teacher package.json 的 build 配置 + student main 啟動流程
import fs from 'node:fs';

for (const pkg of ['student', 'teacher']) {
  const p = JSON.parse(fs.readFileSync(`D:/classroom-live/packages/${pkg}/package.json`, 'utf8'));
  console.log(`=== ${pkg} ===`);
  console.log('scripts.pack:', p.scripts?.pack);
  console.log('build 欄位:', p.build ? '有自己的 build' : '(無，用 root)');
}

const root = JSON.parse(fs.readFileSync('D:/classroom-live/package.json', 'utf8'));
console.log('=== root build.nsis ===');
console.log(JSON.stringify(root.build?.nsis, null, 1));

// student main/index.ts 啟動流程
const m = fs.readFileSync('D:/classroom-live/packages/student/src/main/index.ts', 'utf8');
const i = m.indexOf('registerFileIpc');
console.log('=== student main register 區 ===');
console.log(m.substring(Math.max(0, i - 300), i + 300));
// applyAutoStart 定義位置
const f = fs.readFileSync('D:/classroom-live/packages/student/src/main/modules/file-recv.ts', 'utf8');
const a = f.indexOf('function applyAutoStart');
console.log('=== applyAutoStart ===');
console.log(f.substring(a, a + 500));
