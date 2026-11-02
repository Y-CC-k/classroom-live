// 探查：teacher store.ts 完整讀寫邏輯 + main 是否有 setName/setPath
import fs from 'node:fs';

const m = fs.readFileSync('D:/classroom-live/packages/teacher/src/main/index.ts', 'utf8');
for (const kw of ['setName', 'setPath', 'userData']) {
  let pos = 0;
  while (true) {
    const k = m.indexOf(kw, pos);
    if (k < 0) break;
    const ls = m.lastIndexOf('\n', k) + 1;
    const le = m.indexOf('\n', k);
    console.log(`M [${kw}] ${m.substring(ls, le).trim()}`);
    pos = k + 1;
  }
}

const c = fs.readFileSync('D:/classroom-live/packages/teacher/src/main/store.ts', 'utf8');
const i = c.indexOf('function readPersonal');
console.log('--- readPersonal ---');
console.log(c.substring(i, i + 800));
const j = c.indexOf('function writePersonal');
console.log('--- writePersonal ---');
console.log(c.substring(j, j + 600));
const k2 = c.indexOf('export function getConfig');
console.log('--- getConfig ---');
console.log(c.substring(k2, k2 + 700));
