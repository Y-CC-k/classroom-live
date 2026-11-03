// 探查：native 模組 binding 與函數
import fs from 'node:fs';

const root = 'D:/classroom-live/packages/native';

// 1. lib/ 目錄（JS binding）
const libDir = `${root}/lib`;
try {
  for (const e of fs.readdirSync(libDir)) {
    console.log('lib/', e);
    if (e.endsWith('.ts') || e.endsWith('.js')) {
      console.log('--- 內容 ---');
      console.log(fs.readFileSync(`${libDir}/${e}`, 'utf8').substring(0, 1200));
    }
  }
} catch (e) {
  console.log('lib 讀取失敗:', e.message);
}

// 2. win_input.cc 導出的函數名
const cc = fs.readFileSync(`${root}/src/win_input.cc`, 'utf8');
for (const kw of ['Init', 'exports', 'NAPI', 'SendMouse', 'SendKey', 'SetMouse', 'Inject']) {
  let pos = 0;
  let count = 0;
  while (count < 3) {
    const k = cc.indexOf(kw, pos);
    if (k < 0) break;
    const ls = cc.lastIndexOf('\n', k) + 1;
    console.log(`cc [${kw}]: ${cc.substring(ls, cc.indexOf('\n', k)).trim().substring(0, 100)}`);
    pos = k + 1;
    count++;
  }
}

// 3. addon.cc 導出表
const addon = fs.readFileSync(`${root}/src/addon.cc`, 'utf8');
const i = addon.indexOf('Init');
console.log('--- addon.cc ---');
console.log(addon.substring(0, 1500));
