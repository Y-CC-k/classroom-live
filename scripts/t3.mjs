// 暫存 3：單機鎖定切換（替換 lockChecked/unlockChecked 兩個 handler）
import fs from 'node:fs';

const f = 'D:/classroom-live/packages/teacher/src/renderer/bootstrap.ts';
let c = fs.readFileSync(f, 'utf8').split('\r\n').join('\n');

const start = c.indexOf(`  els.btnLockChecked.addEventListener('click', () => {`);
const endKey = `  els.btnUnlockChecked.addEventListener('click', () => {`;
const end = c.indexOf(endKey, start + 10);
if (start < 0 || end < 0) {
  console.log('markers not found', start, end);
  process.exit(1);
}
const endAbs = c.indexOf('});', end) + '});'.length;

const L = [
  `  // ── 鎖定勾選台（切換式）：勾選台中任一已鎖 → 解除全部；否則鎖定全部 ──`,
  `  els.btnLockChecked.addEventListener('click', () => {`,
  `    if (checkedPeers.size === 0) {`,
  `      log('warn', '先勾選學生機（點卡片即可勾選）。');`,
  `      return;`,
  `    }`,
  `    if (!session?.isConnected) {`,
  `      log('warn', '尚未連線；請先按「連線」。');`,
  `      return;`,
  `    }`,
  `    const anyLocked = [...checkedPeers].some(id => session.isPeerLocked(id));`,
  `    const on = !anyLocked;`,
  `    let sent = 0;`,
  `    for (const peerId of checkedPeers) if (session.lockStudent(peerId, on)) sent++;`,
  `    log(sent > 0 ? 'info' : 'warn', on ? \`已鎖定勾選的 \${sent} 台鍵盤滑鼠\` : \`已解除勾選的 \${sent} 台鎖定\`);`,
  `    updateLockButtons();`,
  `    renderStudents();`,
  `  });`,
].join('\n');

c = c.substring(0, start) + L + c.substring(endAbs);
fs.writeFileSync(f, c, 'utf8');
console.log('checked lock toggle OK');
