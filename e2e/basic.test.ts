/**
 * 教室直播系統 - E2E 測試
 * 測試教師機與學生機的基本連線與廣播功能
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

  test('學生機應該收到教師加入通知', () => {
    const peerJoined = student1.messages.find((m: any) => m.t === 'peer-joined' && m.peer.role === 'teacher');
    expect(peerJoined).toBeTruthy();
  });

  test('教師開始廣播，學生機應該收到廣播開啟訊息', async () => {
    teacher.send({
      t: 'broadcast',
      payload: { on: true, mode: 'video' },
    });

    const broadcastMsg = await student1.waitForBroadcast(true, 'video');
    expect(broadcastMsg).toBeTruthy();
    expect(broadcastMsg.on).toBe(true);
    expect(broadcastMsg.mode).toBe('video');
  });

  test('教師停止廣播，學生機應該收到停止訊息', async () => {
    teacher.send({
      t: 'broadcast',
      payload: { on: false, mode: 'video' },
    });

    const broadcastMsg = await student1.waitForBroadcast(false, 'video');
    expect(broadcastMsg).toBeTruthy();
    expect(broadcastMsg.on).toBe(false);
  });

  test('教師鎖定學生機，學生機應該收到鎖定訊息', async () => {
    teacher.send({
      t: 'lock',
      on: true,
    });

    const lockMsg = await student1.waitForLock(true);
    expect(lockMsg).toBeTruthy();
    expect(lockMsg.on).toBe(true);
  });

  test('教師解除鎖定，學生機應該收到解鎖訊息', async () => {
    teacher.send({
      t: 'lock',
      on: false,
    });

    const unlockMsg = await student1.waitForLock(false);
    expect(unlockMsg).toBeTruthy();
    expect(unlockMsg.on).toBe(false);
  });
});
