// 探查：教師端 ControlManager 的 lock 狀態與重連補送
import fs from 'node:fs';

const c = fs.readFileSync('D:/classroom-live/packages/teacher/src/renderer/webrtc/lock.ts', 'utf8');
console.log('--- lock.ts（ControlManager）---');
console.log(c);
