import type { TeacherSessionOptions } from './types.js';

/** 教室場景是文字、簡報與程式碼，因此偏好「保住解析度」而不是「保住流暢度」。 */
export async function tuneSender(
  sender: RTCRtpSender,
  options: Pick<TeacherSessionOptions, 'maxBitrate' | 'maxFramerate' | 'onLog'>
): Promise<void> {
  try {
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    const encoding = params.encodings[0];
    if (encoding) {
      encoding.maxBitrate = options.maxBitrate;
      encoding.maxFramerate = options.maxFramerate;
    }
    params.degradationPreference = 'maintain-resolution';
    await sender.setParameters(params);
  } catch (error) {
    options.onLog('warn', `設定編碼參數失敗（不影響功能）：${describe(error)}`);
  }
}

/**
 * 把 H.264 排到編碼偏好第一名（硬體編碼路徑）。
 *
 * 背景：WebRTC 對同一條視訊軌會給每台學生機**各編一份**，
 * 30 台＝30 路軟體 VP8/VP9 編碼，教師機 CPU 一定塞車→畫面延遲。
 * H.264 走 GPU（QuickSync / NVENC / AMF），解碼端也吃 GPU，
 * 多台教室場景的負載直接低一個量級。
 * 頻寬同樣以 tuneSender 的 maxBitrate 為上限，不受影響。
 */
export async function preferVideoCodecs(
  pc: RTCPeerConnection,
  options: Pick<TeacherSessionOptions, 'hardwareCodec' | 'onLog'>
): Promise<void> {
  if (!options.hardwareCodec) return;
  try {
    const caps = RTCRtpSender.getCapabilities?.('video');
    const codecs = [...(caps?.codecs ?? [])];
    const h264 = codecs.filter(codec => codec.mimeType?.toLowerCase() === 'video/h264');
    if (h264.length === 0) {
      options.onLog('warn', '這台教師機的瀏覽器不支援 H.264 編碼，沿用預設編碼。');
      return;
    }
    const others = codecs.filter(codec => codec.mimeType?.toLowerCase() !== 'video/h264');
    const ordered = [...h264, ...others];
    for (const transceiver of pc.getTransceivers()) {
      // kind 是標準屬性，但這裡的 TS lib 型別沒標到 → 先 cast、再以 sender.track 補判
      const kind = (transceiver as unknown as { kind?: string }).kind ?? transceiver.sender.track?.kind ?? '';
      if (kind !== 'video') continue;
      transceiver.setCodecPreferences(ordered);
    }
  } catch (error) {
    options.onLog('warn', `編碼偏好設定失敗（沿用預設）:${describe(error)}`);
  }
}

/** 找出廣播連線上的視訊 sender。
 *
 * 注意：**不能靠 `sender.track` 判斷**。停止廣播時我們會
 * `replaceTrack(null)`，此時 sender 與 transceiver 都還在，
 * 但 `sender.track` 已經變成 null；若用 track 去找，下次要恢復廣播時
 * 就會找不到 sender，學生端會永遠停在最後一格畫面。
 */
export function findVideoSender(pc: RTCPeerConnection): RTCRtpSender | null {
  const transceiver = pc.getTransceivers().find(item => item.receiver.track?.kind === 'video');
  if (transceiver) return transceiver.sender;
  return pc.getSenders().find(sender => sender.track?.kind === 'video') ?? null;
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
