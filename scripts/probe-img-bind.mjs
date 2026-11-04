import fs from 'fs';

const sb = fs.readFileSync('D:/classroom-live/packages/student/src/renderer/bootstrap.ts', 'utf8');
const lines = sb.split('\n');
console.log('=== 學生端 DC_IMG / DC_FILE 綁定（635-680）===');
for (let i = 634; i < 682 && i < lines.length; i++) console.log((i + 1) + ': ' + lines[i]);