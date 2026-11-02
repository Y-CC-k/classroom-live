// 探查：teacher preload、main register、broadcast watch-frame-end、MonitorWall 現狀
import fs from 'node:fs';

const root = 'D:/classroom-live/packages/teacher';

// preload
const pl = fs.readFileSync(`${root}/src/preload/index.ts`, 'utf8');
console.log('--- preload head ---');
console.log(pl.substring(0, 500));

// main index.ts register 區
const m = fs.readFileSync(`${root}/src/main/index.ts`, 'utf8');
for (const kw of ['registerFileIpc', 'whenReady', 'IPC.']) {
  const i = m.indexOf(kw);
  if (i >= 0) console.log(`--- main [${kw}] ---\n` + m.substring(Math.max(0, i - 100), i + 200));
}

// broadcast watch-frame-end
const b = fs.readFileSync(`${root}/src/renderer/webrtc/broadcast.ts`, 'utf8');
const i2 = b.indexOf("t: 'watch-frame-end'");
console.log('--- broadcast watch-frame-end ---');
console.log(b.substring(i2 - 50, i2 + 500));

// MonitorWall constructor 與 handleWatchFrame
const w = fs.readFileSync(`${root}/src/renderer/ui/monitor-wall.ts`, 'utf8');
const i3 = w.indexOf('constructor(');
console.log('--- MonitorWall constructor ---');
console.log(w.substring(i3, i3 + 500));
