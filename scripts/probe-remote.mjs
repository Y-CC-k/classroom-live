// 探查：學生端遠端注入能力（現有協定/IPC/原生模組）
import fs from 'node:fs';

const root = 'D:/classroom-live/packages';

// 1. 協定已有的控制訊息（mode/mouse/key/text）
const dc = fs.readFileSync(`${root}/protocol/src/datachannel.ts`, 'utf8');
for (const kw of ["t: 'mode'", "t: 'mouse-move'", "t: 'mouse-button'", "t: 'mouse-wheel'", "t: 'key'", "t: 'text'"]) {
  const i = dc.indexOf(kw);
  const ls = dc.lastIndexOf('\n', i) + 1;
  console.log(dc.substring(ls, dc.indexOf('\n', i)).trim().substring(0, 110));
}

// 2. 學生端 handleControl 是否處理這些
const sr = fs.readFileSync(`${root}/student/src/renderer/bootstrap.ts`, 'utf8');
for (const kw of ["case 'mode'", "case 'mouse-move'", "case 'key'", "case 'text'"]) {
  console.log(`student handleControl ${kw}:`, sr.includes(kw) ? '有' : '無');
}

// 3. 學生端主行程的注入 API（preload/shared/ipc）
const ipc = fs.readFileSync(`${root}/student/src/shared/ipc.ts`, 'utf8');
for (const kw of ['setInputLock', 'injectKey', 'sendKey', 'setMouse', 'injectMouse', 'ControlMode']) {
  const i2 = ipc.indexOf(kw);
  if (i2 >= 0) {
    const ls = ipc.lastIndexOf('\n', i2) + 1;
    console.log(`ipc [${kw}]: ${ipc.substring(ls, ipc.indexOf('\n', i2)).trim().substring(0, 90)}`);
  } else console.log(`ipc [${kw}]: 無`);
}

// 4. 原生模組：student main 是否 require native
const mainIdx = fs.readFileSync(`${root}/student/src/main/index.ts`, 'utf8');
console.log('main require native:', /native|\.node/.test(mainIdx));

// 5. native binding.gyp target 與 src（確認注入函數存在）
const gyp = fs.readFileSync('D:/classroom-live/packages/native/src/win_input.cc', 'utf8');
for (const kw of ['SendInput', 'mouse', 'keyboard', 'Init']) {
  console.log(`native [${kw}]:`, gyp.includes(kw) ? '有' : '無');
}
