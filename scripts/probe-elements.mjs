import fs from 'fs';

const e = fs.readFileSync('D:/classroom-live/packages/teacher/src/renderer/ui/elements.ts', 'utf8');
const marker = 'HTMLButtonElement';
const lines = e.split('\n');
let last = -1;
lines.forEach((l, i) => {
  if (l.includes(marker)) last = i;
});
console.log('last button line:', last + 1, ':', lines[last].trim());
// 檢查 elements 是否被 teacher bootstrap import（wire 的按鈕用 bootstrap 自己的 els？）
const b = fs.readFileSync('D:/classroom-live/packages/teacher/src/renderer/bootstrap.ts', 'utf8');
console.log('bootstrap imports elements.ts:', b.includes("from './ui/elements.js'") ? 'YES' : 'NO');
// bootstrap 有自己的 els？
console.log('bootstrap own els:', b.includes('const els = {') || b.includes('els = {') ? 'YES (own)' : 'NO');