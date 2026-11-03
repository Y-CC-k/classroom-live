// 探查 renderer dist 的 lock case
import fs from 'node:fs';

const r = fs.readFileSync('D:/classroom-live/packages/student/dist/renderer/renderer.js', 'utf8');
const i = r.indexOf('case"lock"');
if (i < 0) {
  console.log('case"lock" 不存在！');
  // 找 setMuted / close-browsers 等其他 case 對照
  console.log('case"mute":', r.includes('case"mute"'));
  console.log('case"open-url":', r.includes('case"open-url"'));
  console.log('case"board-mode":', r.includes('case"board-mode"'));
  console.log('case"clean-files":', r.includes('case"clean-files"'));
  console.log('case"apply-update":', r.includes('case"apply-update"'));
  process.exit(0);
}
console.log('--- case"lock" 內容（解碼顯示）---');
const ctx = r.substring(i, i + 500);
console.log(ctx.replace(/\\u([0-9a-fA-F]{4})/g, (x, h) => String.fromCharCode(parseInt(h, 16))));
