import fs from 'fs';

const sb = fs.readFileSync('D:/classroom-live/packages/student/src/renderer/bootstrap.ts', 'utf8');
sb.split('\n').forEach((l, i) => {
  if (l.includes('binaryType') || l.includes('DC_CTL') || l.includes('DC_EVT') || l.includes('DC_IMG') || l.includes('DC_FILE')) {
    console.log((i + 1) + ': ' + l.trim().substring(0, 100));
  }
});