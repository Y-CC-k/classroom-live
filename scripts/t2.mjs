// 暫存 2：全班鎖定切換（替換 btnLock/btnUnlock 兩個 handler）
import fs from 'node:fs';

const f = 'D:/classroom-live/packages/teacher/src/renderer/bootstrap.ts';
let c = fs.readFileSync(f, 'utf8').split('\r\n').join('\n');

const start = c.indexOf(`  els.btnLock.addEventListener('click', () => {`);
const endKey = `  els.btnUnlock.addEventListener('click', () => {`;
const end = c.indexOf(endKey, start + 10);
if (start < 0 || end < 0) {
  console.log('markers not found', start, end);
  process.exit(1);
}
// btnUnlock handler 的結束（}); 換行）
const endAbs = c.indexOf('});', end) + '});'.length;

const L = [
  `  // ── 鎖定全班（切換式）：鎖定與解除同一顆按鈕 ──`,
  `  els.btnLock.addEventListener('click', () => {`,
  `    if (!session?.isConnected) {`,
  `      log('warn', '尚未連線；請先按「連線」。');`,
  `      updateLockButtons();`,
  `      return;`,
  `    }`,
  `    const lockOn = session.lockActive;`,
  `    const sent = session.lockAll(!lockOn);`,
  `    if (sent > 0) {`,
  `      log('info', lockOn ? \`已解除 \${sent} 台鎖定\` : \`已鎖定 \${sent} 台學生機鍵盤滑鼠\`);`,
  `    } else {`,
  `      log('warn', '沒有學生機可操作（控制通道尚未連上任何一台）。');`,
  `    }`,
  `    updateLockButtons();`,
  `    renderStudents();`,
  `  });`,
].join('\n');

c = c.substring(0, start) + L + c.substring(endAbs);
fs.writeFileSync(f, c, 'utf8');
console.log('global lock toggle OK');
