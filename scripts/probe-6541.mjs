// 探查 StudentApi nativeInject 前後文
import fs from 'node:fs';

const c = fs.readFileSync('D:/classroom-live/packages/student/src/shared/ipc.ts', 'utf8');
console.log(c.substring(6400, 6900));
