import fs from 'fs';

const pump = fs.readFileSync('D:/classroom-live/packages/teacher/src/renderer/image-pump.ts', 'utf8');
const lines = pump.split('\n');
console.log('=== ImagePump.stop() 與 start() ===');
for (let i = 105; i < 172 && i < lines.length; i++) console.log((i + 1) + ': ' + lines[i]);