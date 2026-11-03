// 暫存 1：els 移除解除按鈕
import fs from 'node:fs';

const f = 'D:/classroom-live/packages/teacher/src/renderer/bootstrap.ts';
let c = fs.readFileSync(f, 'utf8').split('\r\n').join('\n');
let q = 0;
const l1 = `  btnUnlock: $<HTMLButtonElement>('btn-unlock'),\n`;
if (c.includes(l1)) { c = c.replace(l1, ''); q++; }
const l2 = `  btnUnlockChecked: $<HTMLButtonElement>('btn-unlock-checked'),\n`;
if (c.includes(l2)) { c = c.replace(l2, ''); q++; }
fs.writeFileSync(f, c, 'utf8');
console.log('els removed:', q);
