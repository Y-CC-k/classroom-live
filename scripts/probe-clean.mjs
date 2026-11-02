// 探查：EvtMessage 定義 + 全班關機雙確認模式
import fs from 'node:fs';

const root = 'D:/classroom-live/packages';

// 1. protocol EvtMessage
const dc = fs.readFileSync(`${root}/protocol/src/datachannel.ts`, 'utf8');
const i = dc.indexOf('export type EvtMessage');
console.log('--- EvtMessage ---');
console.log(dc.substring(i, i + 700));

// 2. 教師端全班關機的雙確認（btnShutdown handler）
const b = fs.readFileSync(`${root}/teacher/src/renderer/bootstrap.ts`, 'utf8');
const s = b.indexOf('els.btnShutdown.addEventListener');
console.log('--- btnShutdown handler ---');
console.log(b.substring(s, s + 700));

// 3. 學生端 system-commands 是否有檔案操作可參考
const sc = fs.readFileSync(`${root}/student/src/main/modules/system-commands.ts`, 'utf8');
console.log('--- system-commands head ---');
console.log(sc.substring(0, 300));
