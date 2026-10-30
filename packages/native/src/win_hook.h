#pragma once

#include <windows.h>

#include <napi.h>

namespace winhook {

/** 在專用執行緒上安裝 WH_KEYBOARD_LL / WH_MOUSE_LL。回傳是否安裝成功。 */
Napi::Value Start(const Napi::CallbackInfo& info);

/** 卸載鉤子並結束鉤子執行緒。可重複呼叫。 */
Napi::Value Stop(const Napi::CallbackInfo& info);

/** 開啟／關閉攔截。開啟時，學生的實體鍵鼠不會傳到系統。 */
Napi::Value SetBlocking(const Napi::CallbackInfo& info);

Napi::Value IsBlocking(const Napi::CallbackInfo& info);

Napi::Value IsActive(const Napi::CallbackInfo& info);

/** 學生按下緊急解鎖熱鍵時回呼 JS。傳 null 可取消註冊。 */
Napi::Value SetPanicCallback(const Napi::CallbackInfo& info);

/** 程序結束／模組卸載時的清理，具幂等性 */
void Shutdown();

/**
 * 與 Shutdown 相同，但假設呼叫端已持有生命週期鎖。
 * 供 N-API 的 AddCleanupHook 使用（不能取鎖，避免與 Stop 互相等待）。
 */
void ShutdownUnlocked();

}  // namespace winhook
