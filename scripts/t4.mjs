// 暫存 4：updateLockButtons 函數
import fs from 'node:fs';

const f = 'D:/classroom-live/packages/teacher/src/renderer/bootstrap.ts';
let c = fs.readFileSync(f, 'utf8').split('\r\n').join('\n');

const anchor = `function setStatus(text: string, kind: 'idle' | 'ok' | 'warn' | 'err' = 'idle'): void {`;
if (c.includes('function updateLockButtons')) {
  console.log('SKIP (exists)');
  process.exit(0);
}

const L = [
  `/** 依鎖定狀態更新鎖定按鈕的文字與樣式（全班＋勾選台） */`,
  `function updateLockButtons(): void {`,
  `  const lockOn = session?.lockActive ?? false;`,
  `  els.btnLock.textContent = lockOn ? '🔓 解除全班鎖定' : '🔒 鎖定全班';`,
  `  els.btnLock.className = lockOn ? 'btn primary grow' : 'btn danger grow';`,
  `  if (checkedPeers.size > 0) {`,
  `    const anyLocked = [...checkedPeers].some(id => session?.isPeerLocked(id) ?? false);`,
  `    els.btnLockChecked.textContent = anyLocked ? '🔓 解除鎖定' : '🔒 鎖定';`,
  `    els.btnLockChecked.className = anyLocked ? 'btn tiny primary' : 'btn tiny warn';`,
  `  }`,
  `}`,
  ``,
  ``,
].join('\n');

c = c.replace(anchor, L + anchor);
fs.writeFileSync(f, c, 'utf8');
console.log('updateLockButtons added OK');
