/**
 * 視訊「接收端」的延遲設定（教師端收學生監看畫面、學生端收廣播畫面都適用）。
 *
 * Chromium 的 WebRTC 接收端會為了不卡頓，自適應地把訊框多緩衝一段時間，
 * 量大時可以到數百毫秒——這段時間是**直接加在秒差上**的。
 * 教室幾乎都是有線區網、丟包極低，把目標收成一個小值，
 * 畫面才會跟得上老師的動作。
 *
 * 若學生端是無線網路而且畫面頻繁停格，把 JITTER_BUFFER_MS 調回 200～300，
 * 用流暢度換掉多出來的延遲。
 */

/** 接收端希望的 jitter buffer 目標（毫秒）。 */
export const JITTER_BUFFER_MS = 100;

/**
 * 把接收延遲目標套到一個接收方向的 transceiver 上。
 *
 * `jitterBufferTarget` 是較新的 API（Chromium 123+），TS 的 lib.dom 也還沒收錄，
 * 所以參數刻意寫成結構型別：這個 package 也會被 Node 伺服器編譯，
 * 不能在這裡引用瀏覽器型別。`receiver` 是 transceiver 一定有的欄位，
 * 放著只是讓型別對得上（否則結構型別全optional 會過不了弱型別檢查）。
 * 瀏覽器不支援時，該行只是設成一個無效的擴充屬性，行為跟沒設一樣。
 *
 * 呼叫端直接傳 `event.transceiver` 即可（師生兩端的 `pc.ontrack` 都拿得到）。
 */
export function tuneReceiver(transceiver: { receiver: unknown; jitterBufferTarget?: number | null }): void {
  try {
    transceiver.jitterBufferTarget = JITTER_BUFFER_MS;
  } catch {
    // 舊版 Chromium 沒這個 API：維持預設緩衝，不影響功能
  }
}
