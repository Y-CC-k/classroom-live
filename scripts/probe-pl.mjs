// 探查 teacher preload wake 行
import fs from 'node:fs';

const c = fs.readFileSync('D:/classroom-live/packages/teacher/src/preload/index.ts', 'utf8');
const i = c.indexOf('wake');
if (i >= 0) {
  console.log(JSON.stringify(c.substring(i - 60, i + 220)));
} else console.log('no wake');
