// 探查：per-student-bar hint 的實際文字
import fs from 'node:fs';

const c = fs.readFileSync('D:/classroom-live/packages/teacher/src/renderer/index.html', 'utf8');
const i = c.indexOf('此列只對卡片勾選');
if (i < 0) {
  console.log('not found');
} else {
  const pStart = c.lastIndexOf('<p class="hint">', i);
  const pEnd = c.indexOf('</p>', i) + 4;
  console.log(JSON.stringify(c.substring(pStart, pEnd)));
}
