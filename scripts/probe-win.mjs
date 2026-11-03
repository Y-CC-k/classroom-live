// 探查：教師機 BrowserWindow 建立與顯示邏輯
import fs from 'node:fs';

const c = fs.readFileSync('D:/classroom-live/packages/teacher/src/main/index.ts', 'utf8');
const i = c.indexOf('new BrowserWindow');
console.log(c.substring(i - 200, i + 900));
