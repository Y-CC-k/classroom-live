import { type TeacherConfig, QUALITY_PRESETS, qualityPresetDef } from '../../shared/ipc.js';
import { els } from './elements.js';

/** 目前下拉選到的擷取尺寸上限；「原始」= 0（不縮放）。 */
export function selectedCaptureSize(): [number, number] {
  const parts = els.qualitySize.value.split('x');
  const width = Number(parts[0]);
  const height = Number(parts[1]);
  return [Number.isFinite(width) && width > 0 ? width : 0, Number.isFinite(height) && height > 0 ? height : 0];
}

export function captureSizeText(width: number, height: number): string {
  return width > 0 && height > 0 ? `${width}×${height}` : '原始尺寸';
}

/** 畫質下拉選單的選項（定義在 shared/ipc.ts，介面文字與實際套用值不會各說各話）。 */
export function fillQualityPresets(): void {
  const options = QUALITY_PRESETS.map(preset => {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = preset.label;
    return option;
  });
  const custom = document.createElement('option');
  custom.value = 'custom';
  custom.textContent = '自訂';
  els.qualityPreset.replaceChildren(...options, custom);
}

/** 把目前的 config 同步到畫質控件（改完設定後也要呼叫，讓數字回到合法值）。 */
export function renderQualityControls(config: TeacherConfig): void {
  els.qualityPreset.value = config.qualityPreset;
  // 設定檔裡的預設名稱不在選單上（例如舊版殘值）→ 停在「自訂」
  if (els.qualityPreset.value !== config.qualityPreset) els.qualityPreset.value = 'custom';
  els.qualityFps.value = String(config.maxFramerate);
  els.qualityBitrate.value = String(config.maxBitrate / 1_000_000);
  // 定影幀品質：設定值不在選項中（例如手改 JSON）→ 停最近的一般值
  const sharpValue = String(config.imgSharpQuality);
  els.qualitySharp.value = [...els.qualitySharp.options].some(option => option.value === sharpValue)
    ? sharpValue
    : '0.85';

  if (config.maxCaptureWidth > 0 && config.maxCaptureHeight > 0) {
    const value = `${config.maxCaptureWidth}x${config.maxCaptureHeight}`;
    if (![...els.qualitySize.options].some(option => option.value === value)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = captureSizeText(config.maxCaptureWidth, config.maxCaptureHeight);
      els.qualitySize.append(option);
    }
    els.qualitySize.value = value;
  } else {
    els.qualitySize.value = '0';
  }

  const preset = qualityPresetDef(config.qualityPreset);
  els.qualityHint.textContent =
    (preset ? preset.hint : '自訂畫質：下面三個數字是手動設定的。秒差變大時，先降「幀率」與「尺寸上限」最有效。') +
    // 圖片模式下「幀率／頻寬」用不到，講清楚免得老師白調
    (config.broadcastMode === 'image' ? '（圖片模式：以「尺寸上限」決定解析度，「幀率／頻寬」不適用）' : '');
}

/**
 * 套用畫質設定。
 *
 * 幀率／頻寬上限走 `RTCRtpSender.setParameters`，可以即時生效、不用重新協商；
 * 但**擷取尺寸與擷取幀率**是 `getUserMedia` 的約束，必須重新擷取
 * （停止 → 開始廣播）才會套用，所以正在廣播時要提醒老師。
 */
export async function applyQuality(
  patch: Partial<TeacherConfig>,
  saveConfig: (patch: Partial<TeacherConfig>) => Promise<TeacherConfig>,
  updateEncoding: (maxBitrate: number, maxFramerate: number) => Promise<void>,
  log: (level: 'info' | 'warn' | 'error', message: string) => void,
  localStream: MediaStream | null
): Promise<void> {
  const config = await saveConfig(patch);
  renderQualityControls(config);
  await updateEncoding(config.maxBitrate, config.maxFramerate);
  log(
    'info',
    `畫質已更新：${config.maxFramerate} fps · ${config.maxBitrate / 1_000_000} Mbps · ` +
      `${captureSizeText(config.maxCaptureWidth, config.maxCaptureHeight)}`
  );
  if (localStream) log('warn', '擷取尺寸／幀率要重新擷取才會生效：按「停止」再「開始廣播」。');
}
