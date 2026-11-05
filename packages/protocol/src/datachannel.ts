import type { AgentMeta, ControlMode, MouseButton, ScreenMeta } from './types.js';

/**
 * DataChannel 訊息。
 *
 * 教師端開兩條通道（皆為 reliable + ordered，因為鍵鼠事件不可遺失或亂序）：
 *
 * - `ctl`：教師 → 學生。承載控制指令。
 * - `evt`：學生 → 教師。承載心跳、狀態變更、緊急求救。
 *
 * 另外 `pcMonitor` 上會再開一組同樣的通道，用於接管中的會話。
 * 為了讓兩邊程式碼共用，訊息型別不分連線種類，只靠 `t` 判別。
 */

// ───────────────────── 教師 → 學生（ctl 通道） ─────────────────────

export type CtlMessage =
  /** 資料通道一建立就送，讓學生知道是誰在控制、教師畫面多大 */
  | { t: 'ctl-hello'; teacherId: string; teacherName: string; screen: ScreenMeta; ts: number }
  /**
   * 切換學生機狀態。
   * 收到 `control` 時學生端必須先確認 `agent.elevated === true`，
   * 否則回報 error（UIPI 會阻擋對提高權限視窗的注入）。
   */
  | { t: 'mode'; mode: ControlMode }
  /**
   * 滑鼠絕對位置，**正規化到 0..1**（相對教師擷取到的畫面）。
   * 學生端再乘上自己的虛擬桌面尺寸，
   * 這樣教師 1920x1080 對 學生 2560x1440 也能正確定位。
   */
  | { t: 'mouse-move'; x: number; y: number }
  | { t: 'mouse-button'; button: MouseButton; down: boolean; x?: number; y?: number }
  | { t: 'mouse-wheel'; dy: number; dx?: number }
  /** vk 為 Windows Virtual-Key code（由教師端用 keymap.ts 轉換） */
  | { t: 'key'; vk: number; down: boolean }
  /** 一次送出整個字串（走 SendInput 的 KEYEVENTF_UNICODE，可輸入中文/emoji） */
  | { t: 'text'; text: string }
  /**
   * 低頻螢幕監看（單台 3 秒一張那種）：教師按「👁 監看」時送出；
   * 要求學生開始／停止推流它的螢幕。
   * `intervalMs` 是學生端送圖的間隔（預設 3000）；
   * `maxWidth` 是學生端送出幀的寬度上限（省略＝960）。監控牆台數多時
   * 會要求較小幀（480），格子只有 200-300px，收 960px 只是浪費頻寬與解碼。
   * 幀走 **evt 通道**（JSON hdr → 裸分片 → end），與檔案通道同一套信封。
   */
  | { t: 'watch'; on: boolean; intervalMs?: number; maxWidth?: number }
  /**
   * 更新學生機「待機（開機初始）畫面」的文字。
   * 學生端立即套用（未廣播時）並存進 config，下次開機也顯示。
   * title 最長 32 字、text 最長 200 字（學生端再截斷一次保險）。
   */
  | { t: 'idle-screen'; title: string; text: string }
  /** 待機圖已在學生機落地：通知 renderer 重取並套用（不動文字欄位） */
  | { t: 'idle-image-applied' }
  /** 清空學生機收檔資料夾內的檔案（磁碟根目錄時學生端會自動改清 SETUP 或跳過） */
  | { t: 'clean-files' }
  /**
   * 獨立電子白板模式：學生機全螢幕白底只顯示筆跡（蓋過廣播畫面）。
   * 與「pen」疊加標註獨立：座標相對白板（邏輯比例 16:9，兩端 contain 對齊）。
   * on = 進入（學生端開白板層並清空筆跡）；off = 離開恢復原畫面。
   */
  | { t: 'board-mode'; on: boolean }
  | { t: 'board-pen'; op: 'down' | 'move' | 'up'; color: string; width: number; x: number; y: number }
  | { t: 'board-clear' }
  | { t: 'board-undo' }
  /**
   * 教師開始／停止廣播。
   * `mode` 說明畫面走哪條路：video = 視訊軌；image = 圖片通道逐張。
   * 停止時學生端要立刻「清屏」——只靠 `replaceTrack(null)` 的話，
   * 學生機會停在最後一格畫面，看起來像老師還在播。
   */
  | { t: 'broadcast'; on: boolean; mode?: BroadcastMode }
  /** 要求學生機最小化／還原視窗 */
  | { t: 'minimize'; on: boolean }
  /** 要求學生機全螢幕／離開全螢幕 */
  | { t: 'fullscreen'; on: boolean }
  /** 要求學生機以系統預設瀏覽器開啟網址（學生端僅接受 http/https） */
  | { t: 'open-url'; url: string }
  /**
   * 鎖定／解除學生機鍵盤滑鼠（課堂秩序用）：
   * 學生端以低階 hook 封鎖輸入；Ctrl+Alt+Del（安全桌面）不受影響。
   */
  | { t: 'lock'; on: boolean }
  /**
   * 學生示範中繼（ctl 通道 JSON base64 分片；ctl 是唯一被證明下行 100% 可用的通道）。
   * begin → chunk × total → end，學生端收齊後組 JPEG 顯示。
   */
  | { t: 'demo-frame-begin'; seq: number; width: number; height: number; total: number }
  | { t: 'demo-chunk'; seq: number; part: number; b64: string }
  | { t: 'demo-frame-end'; seq: number }
  /** 舉手信號的教師端確認（閉環：學生機螢幕直接顯示信號走到哪） */
  | { t: 'hand-ack'; on: boolean; visible: boolean }
  /** student silent update via latest Setup.exe */
  | { t: 'silent-update' }
  /**
   * 教師端的獨立「靜音」指令（右欄按鍵；與廣播開關脫鉤）：
   * 學生端持續維持系統靜音（每 3 秒重設），off = 解除並還原聲音。
   * 教師端會記住意圖並在學生重連時補送（跟「lock」同一套語義）。
   */
  | { t: 'mute'; on: boolean }
  /** 教師端的獨立「關閉學生網頁」指令：一次關掉 Chrome／Edge（不持續） */
  | { t: 'close-browsers' }
  /**
   * 要求學生機關機（下課收攏用）。
   * 一次性事件：不持久化、不補送。學生端改用 Windows 原生
   * `shutdown /s /t delaySec` 排程，App 被砍照樣準時關。
   */
  | { t: 'shutdown'; delaySec: number }
  /**
   * 熱更新：學生機解壓「最近經檔案通道收到的 zip」覆蓋 resources\app，
   * 殺行程後重啟。教師端在檔案寫入成功（file-result）後才送這一條。
   * 只含 JS 程式碼（不含 Electron 本體），所以不需要 UAC／不需要重新安裝。
   */
  | { t: 'apply-update' }
  /**
   * 教師端「執行程式」：在學生機上啟動指定檔案（像檔案傳送送達後自己跑）。
   * 僅限啟動「已存在於學生機」的檔案（不帶內容）；.bat/.cmd 以 cmd /c 執行。
   */
  | { t: 'exec'; path: string; args?: string[]; hide?: boolean }
  /**
   * 開機還原（UWF）遙控：把每台學生機上的「開機自動還原 C:」整合進教師機。
   *
   * UWF 指令（uwfmgr／dism）需要 SYSTEM／管理員權限，而學生平時坐在電腦前
   * 沒辦法（也不該）幫忙按 UAC，所以**不**由學生程序直接執行，而是：
   *   學生程序寫請求檔 → 觸發「最高權限排程任務」（SYSTEM 執行，無 UAC）
   *   → 助手腳本執行後把結果寫回 → 學生回報 uwf-result 給教師。
   *
   * - `setup`：初始化排程任務（每台一次；會在學生機螢幕跳**一次** UAC，
   *   部署時由資訊組按掉）。
   * - `install` / `remove`：安裝／完全移除 UWF 開機還原（安裝後需**重開機**生效，
   *   重開的時機由教師端的「重開機全班」控制，學生端不自動重開）。
   * - `status`：查詢目前還原開關與疊層用量。
   * - `maint-on` / `maint-off`：暫停／恢復開機還原（裝新軟體、Windows Update 用）；
   *   同樣不自動重開機。
   * - `set-exclusion`：把 `path` 資料夾加入排除區（重開機不消失）。
   */
  | {
      t: 'uwf';
      action: 'setup' | 'install' | 'status' | 'maint-on' | 'maint-off' | 'remove' | 'set-exclusion';
      path?: string;
    }
  /** 教師端「全班重開機」：shutdown /r 排程；delaySec < 0 取消已排定的重開/關機 */
  | { t: 'reboot'; delaySec: number }
  | { t: 'ping'; ts: number };

// ───────────────────── 學生 → 教師（evt 通道） ─────────────────────

export type EvtMessage =
  | { t: 'evt-hello'; studentId: string; studentName: string; screen: ScreenMeta; agent: AgentMeta; ts: number }
  /** 回報已套用哪個指令，用於計算端到端延遲 */
  | { t: 'ack'; of: CtlMessage['t']; seq: number; ts: number }
  /** 學生端緊急解鎖（按下 Ctrl+Alt+Shift+Esc）時主動通知教師 */
  | { t: 'panic'; reason: string; ts: number }
  | { t: 'mode-changed'; mode: ControlMode; ts: number }
  /** 原生注入失敗，例如被 UIPI 阻擋 */
  | { t: 'inject-failed'; message: string; ts: number }
  /** 檔案傳送結果回報（教師機 → 學生機檔案） */
  | { t: 'file-result'; id: string; name: string; ok: boolean; path?: string; message?: string }
  | { t: 'update-result'; ok: boolean; stage: string; message?: string }
  /** 開機還原（UWF）執行結果：text 是給教師看的一行摘要 */
  | { t: 'uwf-result'; ok: boolean; text: string; rebooting?: boolean }
  /** 收檔資料夾清理結果（deleted = 刪除項數；ok=false 時 message 說明原因） */
  | { t: 'clean-result'; ok: boolean; deleted: number; message?: string }
  | { t: 'pong'; ts: number }
  | { t: 'error'; message: string }
  /**
   * 螢幕監看的幀信封（跟在裸二進位分片前後，與檔案通道同一套格式）：
   * hdr 宣告這幀的大小與尺寸 → 分片（無信封的 ArrayBuffer，總長 = size）
   * → end 宣告這幀結束。教師端組完 Blob 顯示。
   */
  | { t: 'watch-frame-hdr'; seq: number; width: number; height: number; size: number }
  | { t: 'watch-frame-end'; seq: number; ok: boolean }
  /** 學生示範接收回報：讓教師端日志直接顯示「誰在接收」（閉環診斷） */
  | { t: 'demo-ack'; stage: 'begin' | 'frame'; ts: number }
  /** 學生舉手／收回（F1 切換）；教師端僅在「學習操作模式」回應顯示 */
  | { t: 'hand-raise'; on: boolean; ts: number };

export type DcMessage = CtlMessage | EvtMessage;

/** 資料通道名稱 */
export const DC_CTL = 'ctl';
export const DC_EVT = 'evt';
/** 檔案傳送專用通道：控制訊息走 JSON 字串，檔案內容是原始 ArrayBuffer */
export const DC_FILE = 'file';
/** 圖片廣播通道：JPEG 逐張（hdr JSON → 裸分片 → end JSON），低延遲、無編碼佇列 */
export const DC_IMG = 'img';

/** 廣播模式：video = WebRTC 即時視訊；image = 圖片逐張（人多的教室更穩） */
export type BroadcastMode = 'video' | 'image' | 'sfu';

/**
 * 檔案通道的控制訊息（JSON 字串）。
 * 檔案內容本身以裸 ArrayBuffer 分片跟在後面，不帶 JSON 信封以省頻寬。
 */
export type FileChannelMessage =
  { t: 'file-meta'; id: string; name: string; size: number } | { t: 'file-end'; id: string };

/** 圖片廣播通道的控制訊息（JPEG 內容是裸分片，跟在 hdr 之後） */
export type ImgChannelMessage = { t: 'img-hdr'; size: number } | { t: 'img-end' };

/** 單片檔案資料的大小（SCTP 單則訊息上限 256KB，取 64KB 保險） */
export const FILE_CHUNK_SIZE = 64 * 1024;

/**
 * 滑鼠移動的節流上限。
 * 低階滑鼠可達 1000Hz，全部轉發會灌爆資料通道；
 * 實測 120Hz 已足以讓遠端操作感覺連續。
 */
export const MOUSE_MOVE_HZ = 120;
