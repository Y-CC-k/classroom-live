import { BrowserWindow, desktopCapturer } from 'electron';

import type { CaptureSource } from '../shared/ipc.js';

/**
 * 自家 App 的視窗不列入來源。
 *
 * 教師機／學生機的視窗一旦出現在清單裡，老師不小心選到就會變成
 * 「自己播自己」的鏡像迴圈，而且遠端鍵鼠的座標也會完全對不上。
 *
 * 這裡用兩種方式比對：
 *   1. 視窗控制代碼（HWND）— 精準命中本行程自己的視窗
 *   2. 視窗標題完全相符 — 命中同機執行的另一支 App（例如學生機）
 *
 * 刻意不用「標題包含關鍵字」的方式：那會誤殺任何標題剛好含
 * 「教室直播」四個字的合法視窗（例如瀏覽器開著本專案的文件）。
 */
const OWN_WINDOW_TITLES = new Set(['教室直播 — 教師機', '教室直播 — 學生機']);

function ownWindowHandleIds(): Set<string> {
  const ids = new Set<string>();
  for (const win of BrowserWindow.getAllWindows()) {
    try {
      const handle = win.getNativeWindowHandle();
      const value = handle.length >= 8 ? handle.readBigUInt64LE(0) : BigInt(handle.readUInt32LE(0));
      ids.add(value.toString());
    } catch {
      // 拿不到就略過；寧可多列一個來源，也不要整個清單失敗。
    }
  }
  return ids;
}

/** 排序權重：整個螢幕一定排在最前面，預設值才不會落到視窗上。 */
function kindRank(kind: CaptureSource['kind']): number {
  return kind === 'screen' ? 0 : 1;
}

/**
 * 列出可擷取的來源（螢幕 + 視窗）。
 *
 * `desktopCapturer.getSources()` 只能從主行程呼叫（Electron 17 之後的規定），
 * 但 `getUserMedia({ chromeMediaSourceId })` 必須在 renderer 呼叫。
 * 所以這裡負責「挑來源」，renderer 負責「真的開始擷取」。
 *
 * 攝影機（實物投影機）由 renderer 用 `enumerateDevices()` 另外補上。
 */
export async function listSources(): Promise<CaptureSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 200 },
    fetchWindowIcons: true,
  });

  const ownHandles = ownWindowHandleIds();

  return sources
    .filter(source => {
      if (!source.id.startsWith('window:')) return true;
      const handle = source.id.split(':')[1] ?? '';
      return !ownHandles.has(handle) && !OWN_WINDOW_TITLES.has(source.name);
    })
    .map(source => ({
      id: source.id,
      name: source.name || '未命名來源',
      kind: source.id.startsWith('screen:') ? ('screen' as const) : ('window' as const),
      thumbnail: source.thumbnail.isEmpty() ? '' : source.thumbnail.toDataURL(),
      appIcon: source.appIcon && !source.appIcon.isEmpty() ? source.appIcon.toDataURL() : null,
      displayId: source.display_id || null,
    }))
    .sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
}
