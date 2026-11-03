// 驗證：鎖定切換在 src 與 dist
import fs from 'node:fs';

const root = 'D:/classroom-live/packages/teacher';
const srcB = fs.readFileSync(`${root}/src/renderer/bootstrap.ts`, 'utf8');
const srcH = fs.readFileSync(`${root}/src/renderer/index.html`, 'utf8');
const distR = fs.readFileSync(`${root}/dist/renderer/renderer.js`, 'utf8');
const distH = fs.readFileSync(`${root}/dist/renderer/index.html`, 'utf8');

console.log('--- src ---');
console.log('bootstrap updateLockButtons:', srcB.includes('function updateLockButtons') ? '✓' : '✗');
console.log('bootstrap 切換邏輯:', srcB.includes('session.lockActive') && srcB.includes('updateLockButtons();') ? '✓' : '✗');
console.log('bootstrap btnUnlock 移除:', !srcB.includes('btnUnlock.addEventListener') ? '✓' : '✗ 仍在');
console.log('html btn-unlock 移除:', !srcH.includes('btn-unlock') ? '✓' : '✗ 仍在');

console.log('--- dist（建置時間）---');
console.log('renderer.js mtime:', fs.statSync(`${root}/dist/renderer/renderer.js`).mtime.toISOString());
console.log('dist updateLockButtons:', distR.includes('updateLockButtons') ? '✓' : '✗');
console.log('dist btn-unlock 移除:', !distH.includes('btn-unlock') ? '✓' : '✗ 仍在');
console.log('dist html == src html:', distH === srcH ? '✓' : '✗ 不同步！');
