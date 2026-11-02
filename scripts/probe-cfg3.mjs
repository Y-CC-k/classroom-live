// 探查：全 APPDATA 頂層找 classroom 相關 + teacher-config.json
import fs from 'node:fs';
import path from 'node:path';

const appData = process.env.APPDATA ?? '';
console.log('--- APPDATA 頂層含 classroom/Electron/直播 ---');
for (const e of fs.readdirSync(appData)) {
  if (/classroom|electron|直播|教室/i.test(e)) {
    const st = fs.statSync(path.join(appData, e));
    console.log(`${st.isDirectory() ? '[dir]' : '[file]'} ${e}`);
  }
}

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
      if (['Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'Local Storage', 'Session Storage', 'blob_storage', 'Shared Dictionary', 'Crashpad', 'Temp'].includes(e.name)) continue;
      walk(full, depth + 1, maxDepth);
    } else if (e.name === 'teacher-config.json' || e.name === 'student-config.json') {
      const st = fs.statSync(full);
      console.log(`FOUND: ${full} (${st.size} B, mtime ${st.mtime.toISOString()})`);
    }
  }
}

walk(appData, 0, 3);
