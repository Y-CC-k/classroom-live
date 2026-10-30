#include "win_input.h"

#include <string>
#include <vector>

namespace wininput {
namespace {

/**
 * 把絕對像素座標轉成 SendInput 需要的 0..65535 正規化值。
 *
 * 兩個關鍵細節：
 *  1. 起點是「虛擬桌面」原點而非 (0,0)，否則多螢幕時次要螢幕會偏移。
 *  2. 分母是 span-1 而不是 span，否則最右/最下緣永遠點不到。
 */
LONG NormalizeAbs(int value, int origin, int span) {
  const double denominator = static_cast<double>(span > 1 ? span - 1 : 1);
  double normalized = static_cast<double>(value - origin) * 65535.0 / denominator;
  if (normalized < 0.0) normalized = 0.0;
  if (normalized > 65535.0) normalized = 65535.0;
  return static_cast<LONG>(normalized + 0.5);
}

/**
 * 哪些 VK 在 SendInput 時必須帶 KEYEVENTF_EXTENDEDKEY。
 * 漏掉這個旗標最典型的症狀是：方向鍵無效、或右邊的 Ctrl/Alt 變成左邊的。
 */
bool IsExtendedKey(UINT vk) {
  switch (vk) {
    case VK_RCONTROL:
    case VK_RMENU:
    case VK_INSERT:
    case VK_DELETE:
    case VK_HOME:
    case VK_END:
    case VK_PRIOR:   // PageUp
    case VK_NEXT:    // PageDown
    case VK_LEFT:
    case VK_UP:
    case VK_RIGHT:
    case VK_DOWN:
    case VK_NUMLOCK:
    case VK_DIVIDE:
    case VK_SNAPSHOT:
    case VK_LWIN:
    case VK_RWIN:
    case VK_APPS:
    case VK_CANCEL:
      return true;
    default:
      return false;
  }
}

bool ParseMouseButton(const std::string& name, DWORD& downFlag, DWORD& upFlag, DWORD& xData) {
  if (name == "left") {
    downFlag = MOUSEEVENTF_LEFTDOWN;
    upFlag = MOUSEEVENTF_LEFTUP;
    return true;
  }
  if (name == "right") {
    downFlag = MOUSEEVENTF_RIGHTDOWN;
    upFlag = MOUSEEVENTF_RIGHTUP;
    return true;
  }
  if (name == "middle") {
    downFlag = MOUSEEVENTF_MIDDLEDOWN;
    upFlag = MOUSEEVENTF_MIDDLEUP;
    return true;
  }
  if (name == "x1") {
    downFlag = MOUSEEVENTF_XDOWN;
    upFlag = MOUSEEVENTF_XUP;
    xData = XBUTTON1;
    return true;
  }
  if (name == "x2") {
    downFlag = MOUSEEVENTF_XDOWN;
    upFlag = MOUSEEVENTF_XUP;
    xData = XBUTTON2;
    return true;
  }
  return false;
}

/** 行程是否以系統管理員權限執行 */
bool ProcessIsElevated() {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return false;
  TOKEN_ELEVATION elevation{};
  DWORD size = sizeof(elevation);
  const bool ok =
      GetTokenInformation(token, TokenElevation, &elevation, size, &size) != 0 &&
      elevation.TokenIsElevated != 0;
  CloseHandle(token);
  return ok;
}

/** 目前的 DPI 感知模式，診斷座標偏移問題時很有用 */
const char* DpiAwarenessName() {
  // GetProcessDpiAwareness 由 shcore.dll 匯出（不是 user32）。
  // 用 GetProcAddress 動態取得，避免為了它去相依特定版本的 Windows SDK。
  // 注意簽章是 (HANDLE hprocess, DPI_AWARENESS* value)，hprocess 傳 NULL 代表目前行程；
  // 這裡刻意不用 DPI_AWARENESS 列舉，直接讀 int 再自行對應，減少標頭相依。
  typedef HRESULT(WINAPI * GetAwarenessFn)(HANDLE, int*);
  static GetAwarenessFn fn = []() -> GetAwarenessFn {
    HMODULE shcore = LoadLibraryW(L"shcore.dll");
    if (!shcore) return nullptr;
    return reinterpret_cast<GetAwarenessFn>(
        reinterpret_cast<void*>(GetProcAddress(shcore, "GetProcessDpiAwareness")));
  }();
  if (!fn) return "unknown";

  int awareness = 0;
  if (FAILED(fn(nullptr, &awareness))) return "unknown";
  switch (awareness) {
    case 0:
      return "unaware";
    case 1:
      return "system";
    case 2:
      return "per-monitor";
    default:
      return "unknown";
  }
}

BOOL CALLBACK CountMonitorProc(HMONITOR, HDC, LPRECT, LPARAM data) {
  ++(*reinterpret_cast<int*>(data));
  return TRUE;
}

double PrimaryScaleFactor() {
  HDC dc = GetDC(nullptr);
  if (!dc) return 1.0;
  const int dpi = GetDeviceCaps(dc, LOGPIXELSX);
  ReleaseDC(nullptr, dc);
  return dpi > 0 ? static_cast<double>(dpi) / 96.0 : 1.0;
}

}  // namespace

VirtualScreen GetVirtualScreen() {
  VirtualScreen vs{};
  vs.x = GetSystemMetrics(SM_XVIRTUALSCREEN);
  vs.y = GetSystemMetrics(SM_YVIRTUALSCREEN);
  vs.width = GetSystemMetrics(SM_CXVIRTUALSCREEN);
  vs.height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
  if (vs.width <= 0) vs.width = GetSystemMetrics(SM_CXSCREEN);
  if (vs.height <= 0) vs.height = GetSystemMetrics(SM_CYSCREEN);
  return vs;
}

bool SendInputChecked(INPUT& input) {
  return SendInput(1, &input, sizeof(INPUT)) == 1;
}

/**
 * 把游標移到虛擬桌面座標 (x, y)。
 *
 * 抽成獨立函式是因為 mouseButton 也需要「先定位再點擊」，
 * 而它拿到的 CallbackInfo 第 0 個參數是字串按鈕名稱，不能直接餵給 moveAbs。
 */
static bool MoveAbsTo(int x, int y) {
  const VirtualScreen vs = GetVirtualScreen();

  INPUT input{};
  input.type = INPUT_MOUSE;
  input.mi.dx = NormalizeAbs(x, vs.x, vs.width);
  input.mi.dy = NormalizeAbs(y, vs.y, vs.height);
  input.mi.dwFlags = MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK;

  return SendInputChecked(input);
}

// ───────────────────────────── moveAbs ─────────────────────────────

Napi::Value MoveAbs(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "moveAbs(x: number, y: number)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const int x = info[0].As<Napi::Number>().Int32Value();
  const int y = info[1].As<Napi::Number>().Int32Value();

  return Napi::Boolean::New(env, MoveAbsTo(x, y));
}

// ───────────────────────────── moveRel ─────────────────────────────

Napi::Value MoveRel(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber()) {
    Napi::TypeError::New(env, "moveRel(dx: number, dy: number)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  INPUT input{};
  input.type = INPUT_MOUSE;
  input.mi.dx = info[0].As<Napi::Number>().Int32Value();
  input.mi.dy = info[1].As<Napi::Number>().Int32Value();
  input.mi.dwFlags = MOUSEEVENTF_MOVE;

  return Napi::Boolean::New(env, SendInputChecked(input));
}

// ─────────────────────────── mouseButton ───────────────────────────

Napi::Value MouseButton(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsString() || !info[1].IsBoolean()) {
    Napi::TypeError::New(
        env, "mouseButton(button: 'left'|'right'|'middle'|'x1'|'x2', down: boolean, x?: number, y?: number)")
        .ThrowAsJavaScriptException();
    return env.Undefined();
  }

  DWORD downFlag = 0;
  DWORD upFlag = 0;
  DWORD xData = 0;
  const std::string button = info[0].As<Napi::String>().Utf8Value();
  if (!ParseMouseButton(button, downFlag, upFlag, xData)) {
    Napi::TypeError::New(env, "unknown mouse button: " + button).ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const bool down = info[1].As<Napi::Boolean>().Value();

  // 選用：先定位再按鍵，避免「移動」與「點擊」兩筆 SendInput 之間
  // 被其他行程（或學生自己的滑鼠）插隊造成點錯位置。
  if (info.Length() >= 4 && info[2].IsNumber() && info[3].IsNumber()) {
    MoveAbsTo(info[2].As<Napi::Number>().Int32Value(),
              info[3].As<Napi::Number>().Int32Value());
  }

  INPUT input{};
  input.type = INPUT_MOUSE;
  input.mi.dwFlags = down ? downFlag : upFlag;
  input.mi.mouseData = xData;

  return Napi::Boolean::New(env, SendInputChecked(input));
}

// ─────────────────────────── mouseWheel ───────────────────────────

Napi::Value MouseWheel(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsNumber()) {
    Napi::TypeError::New(env, "mouseWheel(dy: number, dx?: number)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const int dy = info[0].As<Napi::Number>().Int32Value();
  const int dx = (info.Length() >= 2 && info[1].IsNumber())
                     ? info[1].As<Napi::Number>().Int32Value()
                     : 0;

  bool ok = true;
  if (dx != 0) {
    INPUT input{};
    input.type = INPUT_MOUSE;
    input.mi.dwFlags = MOUSEEVENTF_HWHEEL;
    input.mi.mouseData = static_cast<DWORD>(dx);
    ok = SendInputChecked(input) && ok;
  }
  if (dy != 0) {
    INPUT input{};
    input.type = INPUT_MOUSE;
    input.mi.dwFlags = MOUSEEVENTF_WHEEL;
    input.mi.mouseData = static_cast<DWORD>(dy);
    ok = SendInputChecked(input) && ok;
  }

  return Napi::Boolean::New(env, ok);
}

// ─────────────────────────────── key ───────────────────────────────

Napi::Value KeyEvent(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsBoolean()) {
    Napi::TypeError::New(env, "key(vk: number, down: boolean)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  const UINT vk = static_cast<UINT>(info[0].As<Napi::Number>().Uint32Value());
  const bool down = info[1].As<Napi::Boolean>().Value();

  INPUT input{};
  input.type = INPUT_KEYBOARD;
  input.ki.wVk = static_cast<WORD>(vk);
  input.ki.wScan = static_cast<WORD>(MapVirtualKeyW(vk, MAPVK_VK_TO_VSC));
  input.ki.dwFlags = down ? 0 : KEYEVENTF_KEYUP;
  if (IsExtendedKey(vk)) {
    input.ki.dwFlags |= KEYEVENTF_EXTENDEDKEY;
  }

  return Napi::Boolean::New(env, SendInputChecked(input));
}

// ────────────────────────────── typeText ──────────────────────────────

Napi::Value TypeText(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  if (info.Length() < 1 || !info[0].IsString()) {
    Napi::TypeError::New(env, "typeText(text: string)").ThrowAsJavaScriptException();
    return env.Undefined();
  }

  // Napi::String 是 UTF-8；SendInput 的 KEYEVENTF_UNICODE 需要 UTF-16 code unit。
  // 走這條路可以輸入中文、注音、emoji（含代理對），不需要經過鍵盤配置。
  const std::string utf8 = info[0].As<Napi::String>().Utf8Value();
  if (utf8.empty()) return Napi::Number::New(env, 0);

  const int wideLength =
      MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), static_cast<int>(utf8.size()), nullptr, 0);
  if (wideLength <= 0) return Napi::Number::New(env, 0);

  std::wstring wide(static_cast<size_t>(wideLength), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, utf8.c_str(), static_cast<int>(utf8.size()), wide.data(),
                      wideLength);

  int sent = 0;
  for (wchar_t ch : wide) {
    INPUT pair[2] = {};
    pair[0].type = INPUT_KEYBOARD;
    pair[0].ki.wVk = 0;
    pair[0].ki.wScan = static_cast<WORD>(ch);
    pair[0].ki.dwFlags = KEYEVENTF_UNICODE;

    pair[1] = pair[0];
    pair[1].ki.dwFlags = KEYEVENTF_UNICODE | KEYEVENTF_KEYUP;

    if (SendInput(2, pair, sizeof(INPUT)) == 2) ++sent;
  }

  return Napi::Number::New(env, sent);
}

// ───────────────────────── getCursorPos / 螢幕資訊 ─────────────────────────

Napi::Value GetCursorPosition(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  POINT point{};
  if (!GetCursorPos(&point)) {
    Napi::Error::New(env, "GetCursorPos failed").ThrowAsJavaScriptException();
    return env.Undefined();
  }
  Napi::Object result = Napi::Object::New(env);
  result.Set("x", Napi::Number::New(env, point.x));
  result.Set("y", Napi::Number::New(env, point.y));
  return result;
}

Napi::Value GetScreenMetrics(const Napi::CallbackInfo& info) {
  Napi::Env env = info.Env();
  const VirtualScreen vs = GetVirtualScreen();

  int monitors = 0;
  EnumDisplayMonitors(nullptr, nullptr, CountMonitorProc, reinterpret_cast<LPARAM>(&monitors));

  Napi::Object result = Napi::Object::New(env);
  result.Set("x", Napi::Number::New(env, vs.x));
  result.Set("y", Napi::Number::New(env, vs.y));
  result.Set("width", Napi::Number::New(env, vs.width));
  result.Set("height", Napi::Number::New(env, vs.height));
  // 主要螢幕：Windows 上主要螢幕的原點固定是 (0,0)，
  // 教師端看到並操作的正是這一顆，因此絕對座標要以它為基準換算。
  result.Set("primaryWidth", Napi::Number::New(env, GetSystemMetrics(SM_CXSCREEN)));
  result.Set("primaryHeight", Napi::Number::New(env, GetSystemMetrics(SM_CYSCREEN)));
  result.Set("scaleFactor", Napi::Number::New(env, PrimaryScaleFactor()));
  result.Set("monitors", Napi::Number::New(env, monitors));
  result.Set("dpiAwareness", Napi::String::New(env, DpiAwarenessName()));
  return result;
}

// ───────────────────────────── isElevated ─────────────────────────────

Napi::Value IsElevated(const Napi::CallbackInfo& info) {
  return Napi::Boolean::New(info.Env(), ProcessIsElevated());
}

}  // namespace wininput
