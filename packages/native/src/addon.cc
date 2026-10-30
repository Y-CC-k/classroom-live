// N-API 進入點：把 win_input 與 win_hook 匯出成一個 JS 物件。
// 全部函式都是同步的，因此呼叫端（主行程）不應該在忙碌迴圈裡高頻呼叫；
// 實際使用上，滑鼠移動已經在 JS 端節流到 120Hz。

#include <napi.h>

#include "win_hook.h"
#include "win_input.h"

namespace {

// 低階鉤子必須在「安裝它的執行緒」上被呼叫，
// 而且該執行緒必須持續跑訊息迴圈（win_hook.cc 已用專用執行緒處理）。

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  // ── 輸入注入 ──
  exports.Set("moveAbs", Napi::Function::New(env, wininput::MoveAbs, "moveAbs"));
  exports.Set("moveRel", Napi::Function::New(env, wininput::MoveRel, "moveRel"));
  exports.Set("mouseButton", Napi::Function::New(env, wininput::MouseButton, "mouseButton"));
  exports.Set("mouseWheel", Napi::Function::New(env, wininput::MouseWheel, "mouseWheel"));
  exports.Set("key", Napi::Function::New(env, wininput::KeyEvent, "key"));
  exports.Set("typeText", Napi::Function::New(env, wininput::TypeText, "typeText"));

  // ── 查詢 ──
  exports.Set("getCursorPos",
              Napi::Function::New(env, wininput::GetCursorPosition, "getCursorPos"));
  exports.Set("getScreenMetrics",
              Napi::Function::New(env, wininput::GetScreenMetrics, "getScreenMetrics"));
  exports.Set("isElevated", Napi::Function::New(env, wininput::IsElevated, "isElevated"));

  // ── 輸入攔截（低階鉤子）──
  exports.Set("hookStart", Napi::Function::New(env, winhook::Start, "hookStart"));
  exports.Set("hookStop", Napi::Function::New(env, winhook::Stop, "hookStop"));
  exports.Set("hookSetBlocking",
              Napi::Function::New(env, winhook::SetBlocking, "hookSetBlocking"));
  exports.Set("hookIsBlocking",
              Napi::Function::New(env, winhook::IsBlocking, "hookIsBlocking"));
  exports.Set("hookIsActive", Napi::Function::New(env, winhook::IsActive, "hookIsActive"));
  exports.Set("hookSetPanicCallback",
              Napi::Function::New(env, winhook::SetPanicCallback, "hookSetPanicCallback"));

  // 行程結束時務必卸載鉤子，否則學生機重開機前會一直處於「鍵鼠被吃掉」的狀態。
  env.AddCleanupHook([]() { winhook::ShutdownUnlocked(); });

  return exports;
}

}  // namespace

NODE_API_MODULE(classroom_input, Init)
