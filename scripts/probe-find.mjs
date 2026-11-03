// 全系統找 native 模組檔案
import fs from 'node:fs';
import path from 'node:path';

const targets = [];
const roots = [
  'D:/classroom-live/dist-electron',
  'C:/Users/klnes/AppData/Local/Programs',
  'C:/Users/klnes/Desktop',
  'C:/Users/klnes/Documents',
];

function walk(dir, depth) {
  if (depth > 4) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git'].includes(e.name)) continue;
      walk(full, depth + 1);
    } else if (e.name === 'classroom_input.node' || e.name === 'native.node') {
      const st = fs.statSync(full);
      targets.push(`${full} (${Math.round(st.size / 1024)} KB, mtime ${st.mtime.toISOString().slice(0, 16)})`);
    }
  }
}

for (const r of roots) {
  console.log(`=== ${r} ===`);
  walk(r, 0);
}
console.log('--- 結果 ---');
console.log(targets.length ? targets.join('\n') : '找不到任何 native 模組檔案');
