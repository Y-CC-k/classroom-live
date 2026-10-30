import { execFile } from 'node:child_process';

/**
 * 讓學生機的托盤圖示「永遠顯示」在通知區域。
 *
 * 問題：Windows 11 預設會把新程式的托盤圖示收進「隱藏的圖示」溢位區，
 * 學生在工具列上看不到那顆圖示，也就找不到托盤選單
 * （釋放控制／重新連線／結束）。視窗內的 ☰ 選單是主要的替代入口，
 * 這裡再把系統的「永遠顯示」偏好打開，讓圖示直接出現在通知區域。
 *
 * 做法：Windows 把每個托盤圖示的顯示偏好存在
 * `HKCU\Control Panel\NotifyIconSettings\<雜湊>`，其中 `IsPromoted = 1`
 * 代表「永遠顯示」。機碼名稱是系統用圖示身分算出來的雜湊，我們無法自行推算，
 * 所以只能**掃描既有機碼**、找出 `ExecutablePath` 等於本程式執行檔的那一個來改。
 *
 * 這是每位使用者的個人設定（HKCU），可逆、不需要管理員權限；
 * 第一次執行時機碼可能還不存在（系統要等圖示第一次出現才建立），失敗就算了——
 * 反正還有視窗內的 ☰ 選單。
 */

const NODE_ROOT = 'HKCU\\Control Panel\\NotifyIconSettings';
const VALUE_NAME = 'IsPromoted';

export interface PromoteResult {
  /** 這次呼叫是否有真的改到機碼 */
  changed: boolean;
  /** 給主行程記錄用的說明 */
  message: string;
}

function runReg(args: string[]): Promise<{ code: number; stdout: string }> {
  return new Promise(resolve => {
    execFile('reg.exe', args, { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      const code =
        error && typeof (error as { code?: unknown }).code === 'number'
          ? (error as { code: number }).code
          : error
            ? 1
            : 0;
      resolve({ code, stdout: stdout ?? '' });
    });
  });
}

/**
 * 列出 `NotifyIconSettings` 底下所有記錄了執行檔路徑的機碼。
 *
 * `reg query ... /s /v ExecutablePath` 的輸出長這樣：
 *   HKEY_CURRENT_USER\Control Panel\NotifyIconSettings\10930024916559073208
 *       ExecutablePath    REG_SZ    D:\...\electron.exe
 */
async function listIconKeys(): Promise<Array<{ key: string; exePath: string }>> {
  const { code, stdout } = await runReg(['query', NODE_ROOT, '/s', '/v', 'ExecutablePath']);
  if (code !== 0) return [];

  const result: Array<{ key: string; exePath: string }> = [];
  let currentKey: string | null = null;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    if (/^HKEY_/i.test(line)) {
      currentKey = line;
      continue;
    }
    if (!currentKey) continue;

    // 值名稱與型別都是英文，不受系統語系影響。
    const match = /^ExecutablePath\s+REG_SZ\s*(.*)$/i.exec(line);
    if (match) {
      result.push({ key: currentKey, exePath: (match[1] ?? '').trim() });
      currentKey = null;
    }
  }

  return result;
}

function normalizeExePath(value: string): string {
  return value.replace(/\\+/g, '\\').replace(/["']/g, '').trim().toLowerCase();
}

/**
 * 嘗試把本程式的托盤圖示設為永久顯示。
 *
 * @param attempts 找不到機碼時的重試次數（系統可能還沒建立機碼）
 */
export async function promoteTrayIcon(attempts = 3): Promise<PromoteResult> {
  if (process.platform !== 'win32') {
    return { changed: false, message: '非 Windows，略過托盤圖示設定' };
  }

  const self = normalizeExePath(process.execPath);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const keys = await listIconKeys();
    const target = keys.find(item => normalizeExePath(item.exePath) === self);

    if (target) {
      const { code } = await runReg(['add', target.key, '/v', VALUE_NAME, '/t', 'REG_DWORD', '/d', '1', '/f']);
      if (code === 0) {
        return {
          changed: true,
          message: `托盤圖示已設為永久顯示（${target.key}）`,
        };
      }
      return { changed: false, message: `托盤圖示設定失敗（reg add 回傳 ${code}）` };
    }

    // 系統還沒為這顆圖示建立機碼，等一下再試。
    if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, 3000));
  }

  return {
    changed: false,
    message: '系統尚未建立托盤圖示機碼，這次不調整（下次啟動會再試）',
  };
}
