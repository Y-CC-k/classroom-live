/**
 * 瀏覽器 `KeyboardEvent.code` → Windows Virtual-Key code 對照表。
 *
 * 為什麼用 `event.code` 而不是 `event.key`：
 *   `code` 代表實體按鍵位置，不受鍵盤配置（QWERTY / Dvorak）或輸入法影響，
 *   而 Windows 的 SendInput 需要的正是實體鍵碼。
 *
 * 為什麼不直接在原生層做對應：
 *   原生層保持「笨」，只認 VK code，這樣換平台（macOS CGKeyCode）時
 *   只需要換掉這一張表，C++ 不需要動。
 */

export const VK = {
  BACKSPACE: 0x08,
  TAB: 0x09,
  ENTER: 0x0d,
  SHIFT: 0x10,
  CONTROL: 0x11,
  ALT: 0x12,
  PAUSE: 0x13,
  CAPS_LOCK: 0x14,
  ESCAPE: 0x1b,
  SPACE: 0x20,
  PAGE_UP: 0x21,
  PAGE_DOWN: 0x22,
  END: 0x23,
  HOME: 0x24,
  ARROW_LEFT: 0x25,
  ARROW_UP: 0x26,
  ARROW_RIGHT: 0x27,
  ARROW_DOWN: 0x28,
  PRINT_SCREEN: 0x2c,
  INSERT: 0x2d,
  DELETE: 0x2e,
  NUM_0: 0x30,
  NUM_9: 0x39,
  A: 0x41,
  Z: 0x5a,
  LWIN: 0x5b,
  RWIN: 0x5c,
  APPS: 0x5d,
  NUM_LOCK: 0x90,
  SCROLL_LOCK: 0x91,
  LSHIFT: 0xa0,
  RSHIFT: 0xa1,
  LCONTROL: 0xa2,
  RCONTROL: 0xa3,
  LALT: 0xa4,
  RALT: 0xa5,
} as const;

const MAP: Record<string, number> = {};

// A..Z → 0x41..0x5A
for (let i = 0; i < 26; i++) {
  MAP[`Key${String.fromCharCode(65 + i)}`] = 0x41 + i;
}

// Digit0..9 → 0x30..0x39
for (let i = 0; i <= 9; i++) {
  MAP[`Digit${i}`] = 0x30 + i;
}

// F1..F24 → 0x70..0x87
for (let i = 1; i <= 24; i++) {
  MAP[`F${i}`] = 0x6f + i;
}

// 數字鍵盤
for (let i = 0; i <= 9; i++) {
  MAP[`Numpad${i}`] = 0x60 + i;
}

Object.assign(MAP, {
  Backspace: VK.BACKSPACE,
  Tab: VK.TAB,
  Enter: VK.ENTER,
  NumpadEnter: VK.ENTER,
  ShiftLeft: VK.LSHIFT,
  ShiftRight: VK.RSHIFT,
  ControlLeft: VK.LCONTROL,
  ControlRight: VK.RCONTROL,
  AltLeft: VK.LALT,
  AltRight: VK.RALT,
  MetaLeft: VK.LWIN,
  MetaRight: VK.RWIN,
  CapsLock: VK.CAPS_LOCK,
  Escape: VK.ESCAPE,
  Space: VK.SPACE,
  PageUp: VK.PAGE_UP,
  PageDown: VK.PAGE_DOWN,
  End: VK.END,
  Home: VK.HOME,
  ArrowLeft: VK.ARROW_LEFT,
  ArrowUp: VK.ARROW_UP,
  ArrowRight: VK.ARROW_RIGHT,
  ArrowDown: VK.ARROW_DOWN,
  PrintScreen: VK.PRINT_SCREEN,
  Insert: VK.INSERT,
  Delete: VK.DELETE,
  NumLock: VK.NUM_LOCK,
  ScrollLock: VK.SCROLL_LOCK,
  Pause: VK.PAUSE,
  ContextMenu: VK.APPS,

  // OEM 鍵（美式配置位置）
  Minus: 0xbd,
  Equal: 0xbb,
  BracketLeft: 0xdb,
  BracketRight: 0xdd,
  Backslash: 0xdc,
  Semicolon: 0xba,
  Quote: 0xde,
  Backquote: 0xc0,
  Comma: 0xbc,
  Period: 0xbe,
  Slash: 0xbf,

  // 數字鍵盤運算子
  NumpadMultiply: 0x6a,
  NumpadAdd: 0x6b,
  NumpadSubtract: 0x6d,
  NumpadDecimal: 0x6e,
  NumpadDivide: 0x6f,
  NumpadComma: 0x6c,
});

/**
 * 把 `KeyboardEvent.code` 轉成 VK code。
 * 不認得的鍵回傳 `null`，呼叫端應直接忽略（例如 IME 專用鍵、多媒體鍵）。
 */
export function codeToVk(code: string): number | null {
  return MAP[code] ?? null;
}

/** 反向查表，僅用於除錯顯示 */
export function vkToCode(vk: number): string | null {
  for (const [code, value] of Object.entries(MAP)) {
    if (value === vk) return code;
  }
  return null;
}

/**
 * 教師端全域捕獲時，這些鍵必須讓瀏覽器保留，否則會卡死教師自己的視窗。
 * （例如 F11 全螢幕、F12 DevTools、Ctrl+W 關閉視窗）
 */
export function isReservedTeacherKey(ev: {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): boolean {
  if (ev.code === 'F11' || ev.code === 'F12') return true;
  if (ev.ctrlKey && (ev.code === 'KeyW' || ev.code === 'KeyR' || ev.code === 'KeyT')) return true;
  // Ctrl+Alt+Shift+Esc 是學生機的緊急解鎖鍵，教師端不該攔
  if (ev.ctrlKey && ev.altKey && ev.shiftKey) return true;
  return false;
}

/** 學生機的緊急解鎖熱鍵（與 C++ 端的 HOOK 邏輯必須一致） */
export const PANIC_HOTKEY_LABEL = 'Ctrl + Alt + Shift + Esc';
