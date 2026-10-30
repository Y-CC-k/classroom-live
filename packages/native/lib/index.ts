/**
 * 原生模組的 TypeScript 入口。
 *
 * 設計原則：**載入失敗不得讓整個應用程式崩潰**。
 * 學生機仍然可以「接收畫面」，只是無法被遠端控制。
 * 否則老師會看到一台完全消失的學生機，比看到「無法控制」的錯誤訊息糟糕得多。
 */

import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

export interface CursorPosition {
  x: number;
  y: number;
}

export interface ScreenMetrics {
  /** 虛擬桌面原點（多螢幕時可能為負） */
  x: number;
  y: number;
  /** 虛擬桌面總寬／高（所有螢幕的聯集），單位為實體像素 */
  width: number;
  height: number;
  /** 主要螢幕的尺寸。教師端看到的就是這一顆，遠端座標以此為基準換算。 */
  primaryWidth: number;
  primaryHeight: number;
  scaleFactor: number;
  monitors: number;
  /** 'unaware' | 'system' | 'per-monitor' | 'unknown'，用於診斷座標偏移 */
  dpiAwareness: string;
}

export type MouseButtonName = 'left' | 'right' | 'middle' | 'x1' | 'x2';

/** 與 C++ 端 exports.Set(...) 的名稱完全對應 */
export interface NativeBinding {
  moveAbs(x: number, y: number): boolean;
  moveRel(dx: number, dy: number): boolean;
  /** 建議帶 x/y，讓「移動 + 點擊」盡量原子化 */
  mouseButton(button: MouseButtonName, down: boolean, x?: number, y?: number): boolean;
  /** dy 單位為 WHEEL_DELTA（一格 = 120） */
  mouseWheel(dy: number, dx?: number): boolean;
  /** vk 為 Windows Virtual-Key code */
  key(vk: number, down: boolean): boolean;
  /** 以 UTF-16 直送，可輸入中文／emoji；回傳成功送出的字元數 */
  typeText(text: string): number;

  getCursorPos(): CursorPosition;
  getScreenMetrics(): ScreenMetrics;
  /** 是否以系統管理員權限執行。false 時無法注入到提高權限的視窗 */
  isElevated(): boolean;

  hookStart(): boolean;
  hookStop(): void;
  /** 回傳 false 表示鉤子未安裝，攔截沒有生效 */
  hookSetBlocking(on: boolean): boolean;
  hookIsBlocking(): boolean;
  hookIsActive(): boolean;
  hookSetPanicCallback(callback: ((reason: string) => void) | null): void;
}

export interface NativeLoadResult {
  binding: NativeBinding | null;
  /** 載入失敗的原因，null 表示成功 */
  error: Error | null;
  /** 實際載入的檔案路徑，方便診斷 */
  loadedFrom: string | null;
  /** 嘗試過的所有候選路徑 */
  candidates: string[];
}

declare const __filename: string | undefined;
declare const __dirname: string | undefined;

const nodeRequire = createRequire(typeof __filename === 'string' ? __filename : process.execPath);

const BINARY_NAME = 'classroom_input.node';

/**
 * 依序嘗試候選路徑。
 *
 * 順序刻意設計成「越明確的越前面」：
 *   1. 環境變數（部署時可強制指定，最可靠）
 *   2. process.resourcesPath/native/...（Electron 打包後 extraResources 複製到 resources/native）
 *   3. appRoot/native/...（打包後放進 resources/native）
 *   4. 開發環境的 monorepo 相對路徑
 *   5. 執行檔旁的 build/Release（node-gyp 預設輸出）
 */
export function nativeCandidates(appRoot?: string): string[] {
  const list: string[] = [];

  const fromEnv = process.env.CLASSROOM_NATIVE_PATH;
  if (fromEnv) list.push(fromEnv);

  // Electron 打包後，extraResources 會被複製到 resources/ 目錄
  const resourcesPath = process.resourcesPath;
  if (resourcesPath) {
    list.push(
      path.join(resourcesPath, 'native', BINARY_NAME),
      path.join(resourcesPath, 'native', 'prebuilt', BINARY_NAME)
    );
  }

  const roots = [appRoot, process.cwd(), typeof __dirname === 'string' ? __dirname : undefined].filter(
    (value): value is string => typeof value === 'string' && value.length > 0
  );

  for (const root of roots) {
    list.push(
      path.join(root, 'native', BINARY_NAME),
      path.join(root, 'build', 'Release', BINARY_NAME),
      path.join(root, 'build', 'Debug', BINARY_NAME),
      // 開發時：packages/student → packages/native/build/Release
      path.join(root, '..', 'native', 'build', 'Release', BINARY_NAME),
      path.join(root, '..', '..', 'native', 'build', 'Release', BINARY_NAME),
      path.join(root, '..', '..', '..', 'native', 'build', 'Release', BINARY_NAME)
    );
  }

  // 去重但保留優先順序
  return [...new Set(list.map(entry => path.resolve(entry)))];
}

/** 載入原生模組。永遠不丟出例外。 */
export function loadNative(appRoot?: string): NativeLoadResult {
  const candidates = nativeCandidates(appRoot);

  if (process.platform !== 'win32') {
    return {
      binding: null,
      error: new Error('鍵鼠注入原生模組僅支援 Windows。'),
      loadedFrom: null,
      candidates,
    };
  }

  let lastError: Error | null = null;

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    try {
      const binding = nodeRequire(candidate) as NativeBinding;
      return { binding, error: null, loadedFrom: candidate, candidates };
    } catch (cause) {
      lastError = new Error(`載入 ${candidate} 失敗：${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  if (!lastError) {
    lastError = new Error(
      `找不到 ${BINARY_NAME}。請先執行 npm run build:native，` +
        `或設定環境變數 CLASSROOM_NATIVE_PATH 指向該檔案。\n` +
        `已嘗試的路徑：\n  ${candidates.join('\n  ')}`
    );
  }

  return { binding: null, error: lastError, loadedFrom: null, candidates };
}
