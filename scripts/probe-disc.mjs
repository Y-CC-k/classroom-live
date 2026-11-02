// 探查：disconnect / bye 位置
import fs from 'node:fs';

const c = fs.readFileSync('D:/classroom-live/packages/teacher/src/renderer/bootstrap.ts', 'utf8');
let pos = 0;
while (true) {
  const k = c.indexOf('function disconnect', pos);
  if (k < 0) break;
  const le = c.indexOf('\n', k);
  console.log(`@${k}: ${c.substring(k, le)}`);
  pos = k + 1;
}
// bye 訊息
const bye = c.indexOf("'bye'");
if (bye >= 0) {
  const lineStart = c.lastIndexOf('\n', bye) + 1;
  const lineEnd = c.indexOf('\n', bye);
  console.log(`'bye' @${bye}: ${c.substring(lineStart, lineEnd).trim()}`);
  // 前後文
  console.log('--- context ---');
  console.log(c.substring(lineStart - 300, lineEnd + 100));
}
