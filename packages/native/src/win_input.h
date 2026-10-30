#pragma once

#include <windows.h>

#include <napi.h>

namespace wininput {

/** 虛擬桌面（所有螢幕的聯集）。多螢幕時 x/y 可能為負值。 */
struct VirtualScreen {
  int x;
  int y;
  int width;
  int height;
};

VirtualScreen GetVirtualScreen();

/**
 * 送出一筆 INPUT。
 *
 * 注意：回傳 false 不代表程式錯誤，最常見的原因是被 UIPI 擋下
 * （目標視窗以更高完整性等級執行，例如系統管理員權限的程式）。
 * 呼叫端應該把這個資訊回報給教師端，而不是靜靜失敗。
 */
bool SendInputChecked(INPUT& input);

// ───────── 對外 API，簽章與 lib/index.ts 的 NativeBinding 一一對應 ─────────

Napi::Value MoveAbs(const Napi::CallbackInfo& info);
Napi::Value MoveRel(const Napi::CallbackInfo& info);
Napi::Value MouseButton(const Napi::CallbackInfo& info);
Napi::Value MouseWheel(const Napi::CallbackInfo& info);
Napi::Value KeyEvent(const Napi::CallbackInfo& info);
Napi::Value TypeText(const Napi::CallbackInfo& info);
Napi::Value GetCursorPosition(const Napi::CallbackInfo& info);
Napi::Value GetScreenMetrics(const Napi::CallbackInfo& info);
Napi::Value IsElevated(const Napi::CallbackInfo& info);

}  // namespace wininput
