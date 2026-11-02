// 探查：teacher-config.json 實際位置
import fs from 'node:fs';
import path from 'node:path';

const appData = process.env.APPDATA ?? '';
const roots = [appData, 'D:/classroom-live'];

function walk(dir, depth, maxDepth) {
  if (depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'Local Storage'].includes(e.name)) continue;
      walk(full, depth + 1, maxDepth);
    } else if (e.name === 'teacher-config.json' || e.name === 'student-config.json') {
      const st = fs.statSync(full);
      console.log(`FOUND: ${full} (${st.size} B, mtime ${st.mtime.toISOString()})`);
      try {
        console.log('  content:', fs.readFileSync(full, 'utf8').substring(0, 300));
      } catch {}
    }
  }
}

// Electron dev userData 常見位置
for (const r of [path.join(appData, 'Electron'), path.join(appData, 'classroom-live-teacher'), path.join(appData, '教室直播'), 'D:/classroom-live/packages/teacher', 'D:/classroom-live/packages/student']) {
  console.log(`=== scanning ${r} ===`);
  walk(r, 0, 3);
}
