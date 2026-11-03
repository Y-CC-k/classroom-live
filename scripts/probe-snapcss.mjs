// 探查：📸 按鈕 CSS 與程式碼現狀
import fs from 'node:fs';

const css = fs.readFileSync('D:/classroom-live/packages/teacher/src/renderer/renderer.css', 'utf8');
console.log('css .wall-cell-snap:', css.includes('.wall-cell-snap'));
console.log('css .wall-cell-control:', css.includes('.wall-cell-control'));
console.log('css hover 顯示規則:', css.includes('.wall-cell:hover .wall-cell-snap'));

const ts = fs.readFileSync('D:/classroom-live/packages/teacher/src/renderer/ui/monitor-wall.ts', 'utf8');
console.log('monitor-wall snapBtn 建立:', ts.includes("className = 'wall-cell-snap'"));
console.log('monitor-wall snapBtn append:', ts.includes('this.element.append(this.img, this.nameEl, this.metaEl, this.snapBtn, this.controlBtn)'));
console.log('monitor-wall controlBtn append:', ts.includes('this.controlBtn'));

// 如果 css 有，印出樣式內容
const i = css.indexOf('.wall-cell-snap');
if (i >= 0) console.log('--- css ---\n' + css.substring(i - 60, i + 700));
