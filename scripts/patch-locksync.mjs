// 暫存修補：lock/mute 意圖同步到 BroadcastManager（重連補送用）
import fs from 'node:fs';

const f = 'D:/classroom-live/packages/teacher/src/renderer/webrtc/session.ts';
let c = fs.readFileSync(f, 'utf8').split('\r\n').join('\n');
let q = 0;

// 1. lockAll：同步 lockOn
{
  const anchor = `  lockAll(on: boolean): number {
    const sent = this.controlManager.lockAll(on);`;
  const add = `  lockAll(on: boolean): number {
    // 同步「全班鎖定意圖」給 BroadcastManager：ctl 重開時的補送才不會送出 lock=false 解除鎖定
    this.broadcastManager.setLockOn(on);
    const sent = this.controlManager.lockAll(on);`;
  if (c.includes(anchor) && !c.includes('setLockOn(on)')) {
    c = c.replace(anchor, add);
    fs.writeFileSync(f, c, 'utf8');
    q++;
  }
}

// 2. lockStudent：單台鎖定也反映（lock=true 時視同意圖；unlock 時若非全班意圖則維持）
{
  const anchor = `  lockStudent(peerId: string, on: boolean): boolean {
    return this.controlManager.lockStudent(peerId, on);
  }`;
  const add = `  lockStudent(peerId: string, on: boolean): boolean {
    const ok = this.controlManager.lockStudent(peerId, on);
    if (ok && on) this.broadcastManager.setLockOn(true); // 單台鎖定也登記意圖（重連補送不漏鎖）
    return ok;
  }`;
  if (c.includes(anchor) && !c.includes('單台鎖定也登記意圖')) {
    c = c.replace(anchor, add);
    fs.writeFileSync(f, c, 'utf8');
    q++;
  }
}

// 3. muteAll：同步 muteOn
{
  const anchor = `  muteAll(on: boolean): number {
    const sent = this.controlManager.muteAll(on);`;
  const add = `  muteAll(on: boolean): number {
    this.broadcastManager.setMuteOn(on);
    const sent = this.controlManager.muteAll(on);`;
  if (c.includes(anchor) && !c.includes('setMuteOn(on)')) {
    c = c.replace(anchor, add);
    fs.writeFileSync(f, c, 'utf8');
    q++;
  }
}

// 4. muteStudent：單台靜音登記
{
  const anchor = `  muteStudent(peerId: string, on: boolean): boolean {`;
  if (c.includes(anchor) && !c.includes('單台靜音也登記')) {
    // 找完整方法（同 lockStudent 模式）——先看現狀
  }
  fs.writeFileSync(f, c, 'utf8');
  console.log('4. muteStudent: 檢查中');
}

console.log('TOTAL:', q || p);
