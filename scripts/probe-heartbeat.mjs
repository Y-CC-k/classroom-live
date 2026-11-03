// 探查：學生端心跳逾時自解邏輯
import fs from 'node:fs';

const c = fs.readFileSync('D:/classroom-live/packages/student/src/renderer/bootstrap.ts', 'utf8');
// 找 lastPingAt 的檢查邏輯
let pos = 0;
while (true) {
  const k = c.indexOf('lastPingAt', pos);
  if (k < 0) break;
  const ls = c.lastIndexOf('\n', k) + 1;
  console.log(`@${k}: ${c.substring(ls, c.indexOf('\n', k)).trim().substring(0, 100)}`);
  pos = k + 1;
}
// 心跳檢查的 setInterval 區塊
const i = c.indexOf('lastPingAt') > 0 ? c.indexOf('Date.now() - lastPingAt') : -1;
if (i >= 0) {
  const ls = c.lastIndexOf('\n', i - 200) + 1;
  console.log('--- 心跳檢查區塊 ---');
  console.log(c.substring(ls, i + 500));
}
