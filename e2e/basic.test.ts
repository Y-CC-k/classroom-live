/**
 * 教室直播系統 - E2E 測試
 * 測試教師機與學生機的基本連線與廣播功能
 *
 * 注意：鎖定（lock）走 WebRTC DataChannel（P2P），不經過信令伺服器，
 * 因此無法在純 WebSocket 模擬下測試；此處測試 server 支援的訊息路徑。
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createTeacher, createStudent } from './helpers';

describe('教室直播系統 E2E 測試', () => {
  let teacher: any;
  let student1: any;
  let student2: any;
  const classId = 'E2E-TEST-001';

  beforeAll(async () => {
    teacher = await createTeacher(classId, '老師');
    student1 = await createStudent(classId, '學生A');
    student2 = await createStudent(classId, '學生B');
  });

  afterAll(() => {
    teacher?.close();
    student1?.close();
    student2?.close();
  });

  test('教師機應該成功連線並取得 selfId', () => {
    expect(teacher.selfId).toBeTruthy();
    expect(typeof teacher.selfId).toBe('string');
  });

  test('學生機應該成功連線並取得 selfId', () => {
    expect(student1.selfId).toBeTruthy();
    expect(student2.selfId).toBeTruthy();
    expect(student1.selfId).not.toEqual(student2.selfId);
  });

  test('教師端應該收到學生加入通知', () => {
    const peerJoined = teacher.messages.find((m: any) => m.t === 'peer-joined' && m.peer.role === 'student');
    expect(peerJoined).toBeTruthy();
  });

  test('學生機應該在 welcome.peers 中看到教師（後加入者透過 peers 列表得知先加入者）', () => {
    const welcome = student1.welcome;
    expect(welcome).toBeTruthy();
    expect(welcome.peers.some((p: any) => p.role === 'teacher')).toBe(true);
  });

  test('教師開始廣播，學生機應該收到廣播開啟訊息', async () => {
    teacher.send({
      t: 'broadcast',
      payload: { on: true, mode: 'video' },
    });

    const broadcastMsg = await student1.waitForBroadcast(true, 'video');
    expect(broadcastMsg).toBeTruthy();
    expect(broadcastMsg.payload.on).toBe(true);
    expect(broadcastMsg.payload.mode).toBe('video');
    expect(broadcastMsg.from).toBe(teacher.selfId);
  });

  test('教師停止廣播，學生機應該收到停止訊息', async () => {
    teacher.send({
      t: 'broadcast',
      payload: { on: false, mode: 'video' },
    });

    const broadcastMsg = await student1.waitForBroadcast(false, 'video');
    expect(broadcastMsg).toBeTruthy();
    expect(broadcastMsg.payload.on).toBe(false);
  });

  test('學生不能廣播（角色權限，server 拒絕）', async () => {
    student1.send({ t: 'broadcast', payload: { on: true, mode: 'video' } });
    const err = await student1.waitForType('error');
    expect(err).toBeTruthy();
    expect(err.code).toBe('role-forbidden');
  });
});
