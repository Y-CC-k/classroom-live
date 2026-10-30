/**
 * 啟動清理瀏覽器資料（ ClearBrowserData 功能內建版）。
 *
 * 來源：D:\classroom-live\ClearBrowserData\Clear-BrowserData.ps1（原檔資產隨包帶入，
 * 存放於 dist/assets/clear-browser/，打包器自動整包複製）。
 * 同資料夾的 Clear-BrowserData.settings.json 已設 RequireConfirmation:false、
 * LogEnabled:false（不詢問、不寫記錄檔）。
 *
 * 觸發時機：學生機「安裝版」每次啟動（登入自動啟動 → 等於每次開機一次）執行一次，
 * 背景執行不等完成；清理動作只需要使用者自己的權限，不跳 UAC。
 * 開發模式（未打包）刻意不執行：避免清掉開發機自己的瀏覽器資料。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { app } from 'electron';

const SCRIPT_DIR = path.join(__dirname, '..', 'assets', 'clear-browser');
const SCRIPT_FILE = path.join(SCRIPT_DIR, 'Clear-BrowserData.ps1');

let started = false;

/** 學生機啟動時的自動清理入口；呼叫一次即可，重複呼叫不會再排第二次。 */
export function runStartupBrowserClean(): void {
  if (started) return;
  if (!app.isPackaged) return; // 僅安裝版 (dev 時不清開發機)
  started = true;
  if (!fs.existsSync(SCRIPT_FILE)) {
    console.warn(`[browser-clean] 找不到清理腳本（${SCRIPT_FILE}），略過`);
    return;
  }

  try {
    const child = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-WindowStyle',
        'Hidden',
        '-File',
        SCRIPT_FILE,
        '-Force', // 自動關掉執行中的瀏覽器（啟動初期通常還沒開）
      ],
      { windowsHide: true, detached: true, cwd: SCRIPT_DIR, stdio: 'ignore' }
    );
    child.unref();
    console.log('[browser-clean] 已啟動瀏覽器資料清理（背景執行，不寫記錄檔）');
  } catch (error) {
    console.warn('[browser-clean] 清理程序無法啟動：', error instanceof Error ? error.message : String(error));
  }
}
