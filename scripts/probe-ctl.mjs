// 檢查 control 相關缺失
import fs from 'node:fs';

const mw = fs.readFileSync('D:/classroom-live/packages/teacher/src/renderer/ui/monitor-wall.ts', 'utf8');
console.log('--- monitor-wall ---');
console.log('🎮 建立區塊:', mw.includes("wall-cell-control"));
console.log('append controlBtn:', mw.includes('this.snapBtn, this.controlBtn'));
console.log('onControl 欄位:', mw.includes('readonly onControl'));
console.log('constructor 賦值:', mw.includes('this.onControl = onControl;'));
console.log('setStudents 注入:', mw.includes('cell.onControl ='));

const b = fs.readFileSync('D:/classroom-live/packages/teacher/src/renderer/bootstrap.ts', 'utf8');
console.log('--- bootstrap ---');
console.log('takeControl:', b.includes('function takeControl'));
console.log('MW onControl 參數:', b.includes('(peerId, name) => takeControl(peerId, name)'));
console.log('onWatchFrame 分派:', b.includes('接管中：畫面顯示在控制視窗'));
console.log('鍵鼠轉發:', b.includes('鍵鼠轉發'));
console.log('斷線結束接管:', b.includes('斷線前結束接管'));
console.log('MW 建構（找 5 參數處）:');
const i = b.indexOf('monitorWall = new MonitorWall');
console.log(b.substring(i, i + 420));
