// 非 Windows 平台的替身，讓 monorepo 在 macOS/Linux 上仍能安裝與通過型別檢查。
// 任何呼叫都會丟出明確錯誤，而不是 undefined behavior。
#include <napi.h>

namespace {

Napi::Value Unsupported(const Napi::CallbackInfo& info) {
  Napi::Error::New(info.Env(), "classroom_input 原生模組僅支援 Windows (win32)。")
      .ThrowAsJavaScriptException();
  return info.Env().Undefined();
}

}  // namespace

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  const char* names[] = {
      "moveAbs", "moveRel", "mouseButton", "mouseWheel", "key", "typeText",
      "getCursorPos", "getScreenMetrics", "isElevated",
      "hookStart", "hookStop", "hookSetBlocking", "hookIsBlocking",
      "hookIsActive", "hookSetPanicCallback",
  };
  for (const char* name : names) {
    exports.Set(name, Napi::Function::New(env, Unsupported, name));
  }
  return exports;
}

NODE_API_MODULE(classroom_input, Init)
