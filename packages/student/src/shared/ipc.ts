/**
 * 學生機的 IPC 契約。
 *
 * 這個版本只剩「接收廣播」：原生鍵鼠模組（輸入注入／螢幕擷取／鎖定攔截）
 * 與其 IPC 已整組移除，主行程負責視窗控制與廣播強制模式（置頂／靜音／關瀏覽器）。
 */

export const IPC = {
  getConfig: 'student:get-config',
  saveConfig: 'student:save-config',
  appInfo: 'student:app-info',
  setFullscreen: 'student:set-fullscreen',
  /** 以系統預設瀏覽器開啟網址（教師端推播） */
  openUrl: 'student:open-url',
  /** 收檔資料夾：選擇資料夾（只回傳路徑，不直接存設定） */
  chooseSaveDir: 'student:choose-save-dir',
  /** 教師機檔案傳送：建立接收視窗（取得落地路徑） */
  fileBegin: 'student:file-begin',
  /** 教師機檔案傳送：送入一片檔案內容（高頻、單向） */
  fileChunk: 'student:file-chunk',
  /** 教師機檔案傳送：結束並寫入完成 */
  fileEnd: 'student:file-end',
  /** 教師開始／停止廣播時的強制模式開關（僅置頂＋全螢幕） */
  setBroadcastMode: 'student:set-broadcast-mode',
  /**
   * 教師端的獨立「靜音」指令：持續維持系統靜音（每 3 秒重設），
   * 解除時還原聲音。與廣播開關脫鉤，由教師按鍵控制。
   */
  setMuted: 'student:set-muted',
  /** 教師端的獨立「關閉學生網頁」指令：一次關閉 Chrome／Edge（不持續） */
  closeBrowsers: 'student:close-browsers',
  /** 教師端「監看」：回傳主螢幕擷取來源（renderer 用它開 getUserMedia） */
  getScreenSource: 'student:get-screen-source',
  /** 教師鎖定／解除鍵盤滑鼠（低階 hook 封鎖輸入） */
  setInputLock: 'student:set-input-lock',
  /** 教師要求關機：以 Windows 原生 shutdown 排程 delaySec 秒後關機 */
  requestShutdown: 'student:request-shutdown',
  /** 熱更新：解壓最近收到的升級包覆蓋 resources\app 後重啟 */
  applyUpdate: 'student:apply-update',
  /**
   * 教師端「執行程式」（ctl exec）：啟動學生機上的指定檔案。
   * .bat/.cmd 以 cmd /c 開主控台視窗；其他直接啟動。
   * 僅在檔案存在時才會啟動；不等待執行結果（fire-and-forget）。
   */
  execProgram: 'student:exec-program',
  /** 開機還原（UWF）遙控：初始化／安裝／查狀態／維護開關／移除／加排除區（詳見 main/uwf.ts） */
  uwfAction: 'student:uwf-action',
  /** 教師端「重開機全班」：shutdown /r 排程（App 被砍也照樣重開） */
  requestReboot: 'student:request-reboot',
  /** ☰ 選單：縮到系統匣 */
  hideToTray: 'student:hide-to-tray',
  /** ☰ 選單：結束學生機 */
  quitApp: 'student:quit',
  /** 本機網路資訊（一鍵開機用）：MAC 清單 + 主網卡 IP */
  networkInfo: 'student:network-info',
} as const;

/** 主行程 → renderer 的推送事件 */
export const EVENTS = {
  /** 由托盤選單下達的指令 */
  command: 'student:event-command',
} as const;

export type HostCommand = 'reconnect' | 'toggle-fullscreen';

export interface StudentConfig {
  serverUrl: string;
  classId: string;
  studentName: string;
  /** 啟動後自動連線（教室大量部署時必開） */
  autoConnect: boolean;
  /** 收到廣播時自動切換全螢幕 */
  autoFullscreen: boolean;
  /**
   * 登入自動啟動（Wake-on-LAN 的下半段）。
   *
   * 一鍵開機只能把機器叫醒；Windows 開起來之後**學生程式要自己跑**，
   * 否則老師還是得走回每台機器手動開程式。這裡登記的是「使用者登入時
   * 啟動本程式」，與伺服器控制台的開機自動啟動同一套 API。
   *
   * 只有安裝版（`app.isPackaged`）才會真的登記：開發模式註冊的是
   * 開發用的啟動腳本，登記到登入啟動會在下次開機跑出一個沒有畫面的
   * 背景行程，所以開發時一律略過。
   */
  autoStart: boolean;
  /**
   * 部署設定（安裝目錄 config.json）把 serverUrl 鎖住了：UI 必須唯讀。
   * 這個欄位只會出現在 IPC 傳回值，不會寫進本機設定檔。
   */
  serverUrlLocked: boolean;
  /**
   * 教師機傳送檔案的落地資料夾。
   * 部署層（安裝目錄 config.json 的 fileSaveDir）會在「值變更時」重新壓過，
   * 其餘時間學生（或維護者）可以在設定面板自行改；未設定時預設 D:\。
   * 實際收檔時若此資料夾不可寫，仍會自動向下備援（下載資料夾 → 桌面「SETUP」）。
   */
  fileSaveDir: string;
  /** SFU 伺服器位址（未設定時沿用 serverUrl；僅 SFU 模式使用） */
  sfuServerUrl: string;
}

/**
 * 本機網路資訊（一鍵開機用）。
 *
 * 這裡刻意不只回報一個 MAC：同一台機器常常同時有線 + 無線 + 虛擬網卡，
 * 喚醒封包發給全部才保險（無線網卡在關機後多半醒不來，所以「發給全部」
 * 也不會造成困擾）。`mac` 是主網卡的 MAC（伺服器的名單主鍵），
 * `ip` 是主網卡的 IPv4（跟「本機名稱」同一套挑法）。
 */
export interface NetworkInfo {
  /** 主網卡 MAC（`aa:bb:cc:dd:ee:ff`）；抓不到回空字串 */
  mac: string;
  /** 全部可用的 MAC（去重、已正規化，最多 4 個；主網卡排第一） */
  macs: string[];
  /** 主網卡 IPv4（與學生機顯示名稱同一個 IP） */
  ip: string;
}

export interface StudentApi {
  getConfig(): Promise<StudentConfig>;
  saveConfig(patch: Partial<StudentConfig>): Promise<StudentConfig>;
  appInfo(): Promise<{
    version: string;
    platform: string;
    electron: string;
    userDataPath: string;
    saveDir: string;
    /** 版本戳（打包時間）；取不到（舊包／開發模式）為 null */
    build: string | null;
  }>;
  setFullscreen(on: boolean): Promise<boolean>;
  /**
   * 以系統預設瀏覽器開啟網址（教師端「網站推播」）。
   * 僅接受 http/https，其餘一律拒絕並回傳 false。
   */
  openUrl(url: string): Promise<boolean>;
  /**
   * 教師機檔案傳送。id 只是檔案通道上的序號（教師端用來配對）。
   * fileBegin 會做檔名清洗、找可寫資料夾（部署值失敗時自動降級備援）
   * 與排重命名，成功回傳 `{ path }`（最終落地的完整路徑）；降級過時多帶
   * `usedDir`（實際使用的資料夾）與 `fallbackFrom`（原設定的資料夾），
   * 拒收時回傳 `{ error }`（成因會原樣回報給教師機）。
   */
  fileBegin(
    id: string,
    name: string,
    size: number
  ): Promise<{ path: string; usedDir?: string; fallbackFrom?: string } | { error: string }>;
  /** 送入一片檔案內容（單向，不等待寫入完成） */
  fileChunk(id: string, chunk: ArrayBuffer): void;
  /** 通知寫入完成；回傳寫入結果 */
  fileEnd(id: string): Promise<{ ok: boolean; path: string | null; message?: string }>;
  /**
   * 選擇收檔資料夾（原生的資料夾選擇對話框）。
   * 只回傳使用者選到的路徑；要存進設定由 renderer 再呼叫 saveConfig。
   * 使用者取消（或關閉視窗）回傳 null。
   */
  chooseSaveDir(): Promise<string | null>;
  /**
   * 廣播強制模式（教師按下「開始廣播」）：
   * 接收視窗置頂＋保持全螢幕。靜音／關瀏覽器已拆成 setMuted／closeBrowsers 獨立指令。
   * 廣播結束時解除置頂。
   */
  setBroadcastMode(on: boolean): Promise<boolean>;
  /**
   * 教師端「靜音」的獨立指令（與廣播開關脫鉤）：
   * on = 持續靜音（學生按音量鍵也會被重設蓋掉）；off = 解除並還原聲音。
   */
  setMuted(on: boolean): Promise<boolean>;
  /** 教師端「關閉學生網頁」的獨立指令：一次關掉 Chrome／Edge。 */
  closeBrowsers(): Promise<boolean>;
  /**
   * 取得主螢幕的擷取來源 id（desktopCapturer `screen:` 供 getUserMedia 用）。
   * 教師端「👁 監看」要回看本機螢幕（3 秒一張）時由 renderer 呼叫。
   * 取不到（例如無 head）回傳 `{ error }`。
   */
  getScreenSource(): Promise<{ id: string } | { error: string }>;
  /**
   * 教師鎖定（on=true）／解除（on=false）本機鍵盤滑鼠：
   * 以 PowerShell 低階 hook 封鎖輸入，並顯示全螢幕遮蔽畫面。
   * Ctrl+Alt+Del 仍可使用（安全桌面不受 hook 影響）。
   */
  setInputLock(on: boolean): Promise<boolean>;
  /**
   * 排定本機關機（delaySec 秒後）或取消（delaySec < 0 → `shutdown /a`）。
   * 走 Windows 原生 `shutdown`：App 之後被結束也會準時關。
   * 已排定過就不再重排（true=已排定）。
   */
  requestShutdown(delaySec: number): Promise<boolean>;
  /** 熱更新：套用最近收到的升級包（30 分鐘內、.zip、夠大＝有效），套用後本機會重啟 */
  applyUpdate(): Promise<{ ok: boolean; reason?: string }>;
  /**
   * 教師端「執行程式」（ctl exec）：啟動學生機上的指定檔案。
   * .bat/.cmd 以 cmd /c 開主控台視窗；其他直接啟動（bundle 以上全部使用者權限）。
   * 檔案不存在回傳 `{ ok: false, message }`；啟動成功立即回 `{ ok: true }`，
   * 不等待該程序結束。
   */
  execProgram(path: string, args: string[]): Promise<{ ok: boolean; message?: string }>;
  /**
   * 開機還原（UWF）遙控（詳見 main/uwf.ts）：
   *   `setup`：每台一次，跳一次 UAC 建立 SYSTEM 排程任務（之後免 UAC）
   *   `install`／`status`／`maint-on`／`maint-off`／`remove`／`set-exclusion`：
   *     經排程任務執行並回傳結果摘要。
   * **本端不自動重開機**：install/remove/maint-* 需要重開機才生效，
   * 結果以 `rebooting: true` 標記，重開時機由教師端「重開機全班」統一控制。
   */
  uwfAction(
    action: 'setup' | 'install' | 'status' | 'maint-on' | 'maint-off' | 'remove' | 'set-exclusion',
    path?: string
  ): Promise<{ ok: boolean; text: string; rebooting?: boolean }>;
  /**
   * 重開機本機（shutdown /r／/t delaySec）或取消（delaySec < 0 → `shutdown /a`）。
   * 與關機同一套：App 之後被結束也照樣重開。
   */
  requestReboot(delaySec: number): Promise<boolean>;
  /**
   * 縮到系統匣（視窗隱藏，行程留在背景繼續上課）。
   *
   * Windows 11 預設會把新的托盤圖示收進「隱藏的圖示」溢位區，
   * 學生常常找不到托盤選單，所以視窗內另外給一個入口。
   */
  hideToTray(): void;
  /** 顯示並聚焦視窗（從系統匣還原） */
  showWindow(): void;
  /** 結束學生機（與托盤選單的「結束」相同行為） */
  quitApp(): void;
  /**
   * 本機網路資訊（MAC + IP），一鍵開機的名單來源。
   *
   * renderer 在 hello 前問一次，把 MAC 一起送給伺服器；伺服器驗過格式
   * 才轉發給教師端，教師端就存成名單，之後學生機關機也能照著名單喚醒。
   */
  networkInfo(): Promise<NetworkInfo>;
}

export interface StudentEvents {
  onCommand(callback: (command: HostCommand) => void): void;
}

declare global {
  interface Window {
    studentApi: StudentApi;
    studentEvents: StudentEvents;
  }
}
