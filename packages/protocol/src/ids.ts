const ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz'; // 去掉 0/1/i/l/o 等易混淆字元

/**
 * 產生短 id。
 * 使用 Web Crypto，Node 20+ 與瀏覽器都有 `globalThis.crypto`。
 */
export function shortId(length = 8): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) {
    out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}

/** 班級代碼：教師建立課程時產生，學生輸入此代碼加入 */
export function makeClassId(): string {
  const digits = new Uint8Array(6);
  globalThis.crypto.getRandomValues(digits);
  let out = '';
  for (const b of digits) {
    out += String(b % 10);
  }
  // 格式 123-456，方便口頭報讀
  return `${out.slice(0, 3)}-${out.slice(3)}`;
}

/** 驗證使用者輸入的班級代碼，接受有無破折號的寫法 */
export function normalizeClassId(raw: string): string | null {
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length !== 6) return null;
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
}
