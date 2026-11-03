// 探查：lib/index.ts 載入邏輯
import fs from 'node:fs';

const c = fs.readFileSync('D:/classroom-live/packages/native/lib/index.ts', 'utf8');
console.log('total length:', c.length);
// 找載入函數
const i = c.indexOf('createRequire');
console.log(c.substring(i - 200, i + 1400));
