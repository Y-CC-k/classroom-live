import fs from 'fs';

const bc = fs.readFileSync('D:/classroom-live/packages/teacher/src/renderer/webrtc/broadcast.ts', 'utf8');

// 1. ensureBroadcastLink 實作
const i1 = bc.indexOf('ensureBroadcastLink');
console.log('=== ensureBroadcastLink（第一次出現上下文）===');
console.log(bc.substring(i1 - 100, i1 + 1600));

// 2. link.img 的建立時機
console.log('\n=== link.img 建立 ===');
bc.split('\n').forEach((l, i) => {
  if (/\.img\s*=|img:|'img'|"img"/.test(l) && !l.trim().startsWith('//') && !l.trim().startsWith('*')) {
    const t = l.trim();
    if (t.length > 3) console.log((i + 1) + ': ' + t.substring(0, 110));
  }
});