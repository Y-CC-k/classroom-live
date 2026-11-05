import fs from 'fs';

const sb = fs.readFileSync('D:/classroom-live/packages/student/src/renderer/bootstrap.ts', 'utf8');
const i = sb.indexOf('function handleControl');
console.log(sb.substring(i, i + 300));
console.log('---handleControl 內第一個 case 上下文---');
const lines = sb.split('\n');
lines.forEach((l, idx) => {
  if (l.includes("case 'broadcast'") || l.includes('switch (message')) console.log((idx + 1) + ': ' + l.trim());
});