// 探查 monitor-wall.ts：WallCell 按鈕與 onSnapshot 狀態
import fs from 'node:fs';

const c = fs.readFileSync('D:/classroom-live/packages/teacher/src/renderer/ui/monitor-wall.ts', 'utf8');
for (const kw of ['lastBlob', 'snapBtn', 'onSnapshot', 'handleWatchFrame(peerId: string, frame: { url: string; width: number; height: number; seq: number; blob: Blob })']) {
  console.log(`${kw}: ${c.includes(kw) ? (c.includes(kw) ? '有' : '') : '無'}`);
}
// WallCell constructor 區塊
const i = c.indexOf('this.element.append');
if (i >= 0) console.log('--- append 區 ---\n' + c.substring(i - 60, i + 120));
// MonitorWall constructor 參數
const j = c.indexOf('onSnapshot: (peerId: string, name: string, blob: Blob) => void');
console.log('onSnapshot 型別:', j >= 0 ? '有' : '無');
const k = c.indexOf('this.onSnapshot = onSnapshot');
console.log('onSnapshot 賦值:', k >= 0 ? '有' : '無');
