import fs from 'fs';

// ═══ 1. 學生端：F1 按下時 banner 反饋（消除「不知道有沒有按到」）═══
{
  const F = 'D:/classroom-live/packages/student/src/renderer/bootstrap.ts';
  let c = fs.readFileSync(F, 'utf8');

  const a1 = `    handRaised = !handRaised;
    sendEvt({ t: 'hand-raise', on: handRaised, ts: Date.now() });
    log('info', handRaised ? '🙋 已舉手（信號已送出）' : '已收回舉手');`;
  const b1 = `    handRaised = !handRaised;
    sendEvt({ t: 'hand-raise', on: handRaised, ts: Date.now() });
    setBanner(handRaised ? '🙋 已舉手，等待老師點名' : '已收回舉手', handRaised ? 'ok' : 'idle');
    log('info', handRaised ? '🙋 已舉手（信號已送出）' : '已收回舉手');`;
  if (c.includes(a1)) { c = c.replace(a1, b1); console.log('OK: F1 banner 反饋'); }
  else console.log('SKIP: F1 banner');

  fs.writeFileSync(F, c, 'utf8');
}

// ═══ 2. 教師端：非學習模式收到舉手 → 灰色 info 提示（綠色仍只在學習模式）═══
{
  const F = 'D:/classroom-live/packages/teacher/src/renderer/webrtc/broadcast.ts';
  let c = fs.readFileSync(F, 'utf8');

  const a = `      if (parsed.t === 'hand-raise') {
        // 「學習操作模式」＝未廣播＋未鎖定＋未靜音（教學活動進行中不回應舉手）
        const learning = !this.getLocalStream() && !this.lockOn && !this.muteOn;
        if (learning && parsed.on) {
          this.options.onLog('hand', \`🙋 舉手：\${link.state.info.name}\`);
        } else if (learning && !parsed.on) {
          this.options.onLog('hand', \`🙋 \${link.state.info.name} 收回舉手\`);
        }
        // 非學習操作模式：靜默不回應（依需求）
        return;
      }`;
  const b = `      if (parsed.t === 'hand-raise') {
        // 「學習操作模式」＝未廣播＋未鎖定＋未靜音（教學活動進行中不回應舉手）
        const learning = !this.getLocalStream() && !this.lockOn && !this.muteOn;
        if (learning && parsed.on) {
          this.options.onLog('hand', \`🙋 舉手：\${link.state.info.name}\`);
        } else if (learning && !parsed.on) {
          this.options.onLog('hand', \`🙋 \${link.state.info.name} 收回舉手\`);
        } else if (parsed.on) {
          // 非學習模式：灰色中性提示（不是綠色舉手記錄；課堂上不干擾）
          this.options.onLog('info', \`（教學活動中，已忽略 \${link.state.info.name} 的舉手）\`);
        }
        return;
      }`;
  if (c.includes(a)) { c = c.replace(a, b); fs.writeFileSync(F, c, 'utf8'); console.log('OK: 非學習模式灰色提示'); }
  else console.log('SKIP: 灰色提示');
}