#include "win_hook.h"

#include <atomic>
#include <future>
#include <mutex>
#include <string>
#include <thread>

namespace winhook {
namespace {

std::atomic<bool> g_blocking{false};   // 是否攔截實體輸入
std::atomic<bool> g_hooked{false};     // 鉤子是否安裝成功
std::atomic<bool> g_stopRequested{false};
std::atomic<bool> g_hasPanicCallback{false};

HHOOK g_keyboardHook = nullptr;
HHOOK g_mouseHook = nullptr;
DWORD g_threadId = 0;
std::thread g_thread;
std::mutex g_lifecycleMutex;

Napi::ThreadSafeFunction g_panicTsfn;

/**
 * 判斷目前是否按著 Ctrl+Alt+Shift。
 * 在低階鉤子裡用 GetAsyncKeyState 而不是自己維護修飾鍵狀態，
 * 因為鉤子可能漏掉事件（例如被其他行程吃掉），自己記狀態容易不同步。
 */
bool ModifiersHeld() {
  return (GetAsyncKeyState(VK_CONTROL) & 0x8000) != 0 &&
         (GetAsyncKeyState(VK_MENU) & 0x8000) != 0 &&
         (GetAsyncKeyState(VK_SHIFT) & 0x8000) != 0;
}

void NotifyPanic(const char* reason) {
  if (!g_hasPanicCallback.load()) return;
  const std::string text(reason);
  // NonBlockingCall：鉤子執行緒絕對不能阻塞，否則 Windows 會直接把鉤子拿掉。
  g_panicTsfn.NonBlockingCall([text](Napi::Env env, Napi::Function callback) {
    callback.Call({Napi::String::New(env, text)});
  });
}

/**
 * 共用邏輯：判斷是否要吃掉這個事件。
 *
 * ★ 最關鍵的一行是 `injected`。
 *   教師端注入的鍵鼠事件同樣會經過這個鉤子，但它們帶著 LLKHF_INJECTED /
 *   LLMHF_INJECTED 旗標。如果連注入事件一起攔掉，就會出現
 *   「鎖住學生 → 教師自己也控制不了」的經典死鎖。
 */
bool ShouldSwallow(bool injected) {
  return g_blocking.load() && !injected;
}

LRESULT CALLBACK KeyboardProc(int code, WPARAM wParam, LPARAM lParam) {
  if (code == HC_ACTION) {
    const auto* data = reinterpret_cast<KBDLLHOOKSTRUCT*>(lParam);
    const bool injected = (data->flags & LLKHF_INJECTED) != 0;

    // 緊急解鎖：Ctrl+Alt+Shift+Esc。只認實體按鍵，教師端的注入不會誤觸。
    if (!injected && data->vkCode == VK_ESCAPE && ModifiersHeld()) {
      g_blocking.store(false);
      NotifyPanic("hotkey");
      return 1;  // 吃掉，不讓 Esc 傳給前景程式
    }

    if (ShouldSwallow(injected)) return 1;
  }
  return CallNextHookEx(g_keyboardHook, code, wParam, lParam);
}

LRESULT CALLBACK MouseProc(int code, WPARAM wParam, LPARAM lParam) {
  if (code == HC_ACTION) {
    const auto* data = reinterpret_cast<MSLLHOOKSTRUCT*>(lParam);
    const bool injected = (data->flags & LLMHF_INJECTED) != 0;
    if (ShouldSwallow(injected)) return 1;
  }
  return CallNextHookEx(g_mouseHook, code, wParam, lParam);
}

void HookThread(std::promise<void> ready) {
  g_threadId = GetCurrentThreadId();
  HMODULE module = GetModuleHandleW(nullptr);

  g_keyboardHook = SetWindowsHookExW(WH_KEYBOARD_LL, KeyboardProc, module, 0);
  g_mouseHook = SetWindowsHookExW(WH_MOUSE_LL, MouseProc, module, 0);
  g_hooked.store(g_keyboardHook != nullptr && g_mouseHook != nullptr);
  ready.set_value();

  if (!g_hooked.load()) {
    if (g_keyboardHook) UnhookWindowsHookEx(g_keyboardHook);
    if (g_mouseHook) UnhookWindowsHookEx(g_mouseHook);
    g_keyboardHook = nullptr;
    g_mouseHook = nullptr;
    g_threadId = 0;
    return;
  }

  MSG message;
  while (!g_stopRequested.load() && GetMessageW(&message, nullptr, 0, 0) > 0) {
    TranslateMessage(&message);
    DispatchMessageW(&message);
  }

  if (g_keyboardHook) UnhookWindowsHookEx(g_keyboardHook);
  if (g_mouseHook) UnhookWindowsHookEx(g_mouseHook);
  g_keyboardHook = nullptr;
  g_mouseHook = nullptr;
  g_hooked.store(false);
  g_threadId = 0;
}

/** Stop 的內部版本，不取鎖，供 Shutdown 使用 */
void StopInternal() {
  g_blocking.store(false);
  if (!g_thread.joinable()) return;
  g_stopRequested.store(true);
  if (g_threadId != 0) {
    PostThreadMessageW(g_threadId, WM_QUIT, 0, 0);
  }
  g_thread.join();
}

}  // namespace

Napi::Value Start(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  std::lock_guard<std::mutex> guard(g_lifecycleMutex);

  if (g_thread.joinable()) {
    return Napi::Boolean::New(env, g_hooked.load());
  }

  g_stopRequested.store(false);
  std::promise<void> ready;
  std::future<void> readyFuture = ready.get_future();
  g_thread = std::thread(HookThread, std::move(ready));

  // 等鉤子真的安裝完成再回傳，否則 JS 端會誤以為已經可以攔截。
  readyFuture.wait();
  return Napi::Boolean::New(env, g_hooked.load());
}

Napi::Value Stop(const Napi::CallbackInfo& info) {
  std::lock_guard<std::mutex> guard(g_lifecycleMutex);
  StopInternal();
  return info.Env().Undefined();
}

Napi::Value SetBlocking(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsBoolean()) {
    Napi::TypeError::New(env, "hookSetBlocking(on: boolean)").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  const bool on = info[0].As<Napi::Boolean>().Value();
  // 沒裝鉤子就開啟攔截是沒有意義的，直接拒絕，讓呼叫端早點發現問題。
  if (on && !g_hooked.load()) {
    return Napi::Boolean::New(env, false);
  }
  g_blocking.store(on);
  return Napi::Boolean::New(env, on);
}

Napi::Value IsBlocking(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), g_blocking.load());
}

Napi::Value IsActive(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), g_hooked.load());
}

Napi::Value SetPanicCallback(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();

  if (g_hasPanicCallback.load()) {
    g_panicTsfn.Release();
    g_hasPanicCallback.store(false);
  }

  if (info.Length() < 1 || info[0].IsNull() || info[0].IsUndefined()) {
    return env.Undefined();
  }
  if (!info[0].IsFunction()) {
    Napi::TypeError::New(env, "hookSetPanicCallback(fn | null)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  g_panicTsfn = Napi::ThreadSafeFunction::New(env, info[0].As<Napi::Function>(),
                                             "classroomPanicCallback", 0, 1);
  g_hasPanicCallback.store(true);
  return env.Undefined();
}

void Shutdown() {
  std::lock_guard<std::mutex> guard(g_lifecycleMutex);
  StopInternal();
  if (g_hasPanicCallback.load()) {
    g_panicTsfn.Release();
    g_hasPanicCallback.store(false);
  }
}

/** 供 addon.cc 註冊環境清理用（不取鎖，避免與 Stop 互相等待） */
void ShutdownUnlocked() {
  g_blocking.store(false);
  if (g_thread.joinable()) {
    g_stopRequested.store(true);
    if (g_threadId != 0) PostThreadMessageW(g_threadId, WM_QUIT, 0, 0);
    g_thread.join();
  }
  if (g_hasPanicCallback.load()) {
    g_panicTsfn.Release();
    g_hasPanicCallback.store(false);
  }
}

}  // namespace winhook
