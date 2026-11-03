// 驗證：新 Setup.exe 含 setInputLock handler + native + 全部修復
import fs from 'node:fs';
import path from 'node:path';

const unpacked = 'D:/classroom-live/dist-electron/student/win-unpacked/resources/app';
const checks = [];

// 1. main/index.cjs：setInputLock handler
{
  const f = path.join(unpacked, 'dist', 'main', 'index.cjs');
  if (fs.existsSync(f)) {
    const c = fs.readFileSync(f, 'utf8');
    checks.push(['main setInputLock handler', c.includes('setInputLock') && c.includes('setActive') ? '✓' : '✗']);
    checks.push(['main nativeInject', c.includes('nativeInject') ? '✓' : '✗']);
    checks.push(['main cleanFileDir', c.includes('cleanFileDir') ? '✓' : '✗']);
  } else checks.push(['main/index.cjs', '✗ 不存在']);
}

// 2. native 模組
{
  const f = path.join(unpacked, 'resources', 'native', 'prebuilt', 'classroom_input.node');
  checks.push(['native prebuilt', fs.existsSync(f) ? '✓ ' + Math.round(fs.statSync(f).size / 1024) + ' KB' : '✗ 缺']);
}

// 3. renderer：鎖定錯誤回報
{
  const f = path.join(unpacked, 'dist', 'renderer', 'renderer.js');
  if (fs.existsSync(f)) {
    const c = fs.readFileSync(f, 'utf8');
    checks.push(['renderer lock 錯誤回報', c.includes('鎖定指令執行失敗') ? '✓' : '✗']);
  }
}

// 4. tools/reset-server.ps1
{
  const f = path.join(unpacked, 'resources', 'tools', 'reset-server.ps1');
  checks.push(['reset-server.ps1', fs.existsSync(f) ? '✓' : '✗ 缺']);
}

// 5. mtime
{
  const st = fs.statSync('D:/classroom-live/dist-electron/student/教室直播 — 學生機 Setup 0.1.0.exe');
  checks.push(['Setup.exe mtime', st.mtime.toISOString()]);
}

for (const [name, status] of checks) console.log(`${name}: ${status}`);
