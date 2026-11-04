/**
 * 遠端接管：原生鍵鼠注入（SendInput）。
 *
 * 設計原則：**載入失敗不得讓應用程式崩潰**——學生機仍可接收廣播，
 * 只是無法被遠端控制（nativeReady = false，教師端會辨別）。
 */
import path from 'node:path';

import { ipcMain } from 'electron';

import { loadNative, type MouseButtonName, type NativeBinding } from '@classroom/native';
import { IPC } from '../../shared/ipc.js';

let binding: NativeBinding | null = null;
let loadError: string | null = null;

/** 載入原生模組（啟動時呼叫一次） */
export function initNativeControl(): void {
  // appRoot = resources/app：升級包可攜帶 native/classroom_input.node 隨熱更新部署
  const appRoot = path.join(__dirname, '..', '..');
  const result = loadNative(appRoot);
  binding = result.binding;
  loadError = result.error?.message ?? null;
  console.log(`[native] ${binding ? `已載入：${result.loadedFrom}` : `未載入：${loadError}`}`);
}

export function getNativeBinding() {
  return binding;
}

export function isNativeReady(): boolean {
  return binding !== null;
}

export function nativeError(): string | null {
  return loadError;
}

interface InjectPayload {
  kind: 'mouse-move' | 'mouse-button' | 'mouse-wheel' | 'key' | 'text';
  x?: number;
  y?: number;
  button?: string;
  down?: boolean;
  dy?: number;
  vk?: number;
  text?: string;
}

function inject(payload: InjectPayload): { ok: boolean; message?: string } {
  if (!binding) return { ok: false, message: '原生模組未載入' };
  try {
    const metrics = binding.getScreenMetrics();
    switch (payload.kind) {
      case 'mouse-move': {
        // 教師端正規化座標（0..1，相對主要螢幕）→ 學生機實際像素
        const x = metrics.x + (Number(payload.x) || 0) * metrics.primaryWidth;
        const y = metrics.y + (Number(payload.y) || 0) * metrics.primaryHeight;
        binding.moveAbs(Math.round(x), Math.round(y));
        return { ok: true };
      }
      case 'mouse-button': {
        const name = String(payload.button ?? 'left');
        const btn = (['left', 'right', 'middle'].includes(name) ? name : 'left') as MouseButtonName;
        const x = metrics.x + (Number(payload.x) || 0) * metrics.primaryWidth;
        const y = metrics.y + (Number(payload.y) || 0) * metrics.primaryHeight;
        binding.mouseButton(btn, payload.down !== false, Math.round(x), Math.round(y));
        return { ok: true };
      }
      case 'mouse-wheel': {
        // 教師端送「格數」，原生端單位為 WHEEL_DELTA（120）
        binding.mouseWheel((Number(payload.dy) || 0) * 120, 0);
        return { ok: true };
      }
      case 'key': {
        binding.key(Number(payload.vk) || 0, payload.down !== false);
        return { ok: true };
      }
      case 'text': {
        binding.typeText(String(payload.text ?? ''));
        return { ok: true };
      }
      default:
        return { ok: false, message: '未知的注入類型' };
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

export function registerNativeControlIpc(): void {
  ipcMain.handle(IPC.nativeInject, (_event, payload: InjectPayload) => inject(payload));

  ipcMain.handle(IPC.nativeStatus, () => ({
    ready: isNativeReady(),
    error: loadError,
  }));
}
