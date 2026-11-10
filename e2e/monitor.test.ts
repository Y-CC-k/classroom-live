/**
 * 教室直播系統 - E2E 測試：遠端接管（monitor 軌）
 *
 * 測試教師機發送 mode: control 與約束參數，伺服器正確轉發給目標學生機。
 * 需要伺服器運行在 ws://127.0.0.1:8787（可先執行 npm run dev:server）。
 */

import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { createTeacher, createStudent, TestClient } from './helpers.js';

describe('遠端接管（monitor 軌）E2E 測試', () => {
  let teacher: TestClient;
  let student: TestClient;
  const classId = 'E2E-MONITOR-001';

  beforeAll(async () => {
    teacher = await createTeacher(classId, '老師');
    student = await createStudent(classId, '學生A');
  });

  afterAll(() => {
    teacher?.close();
    student?.close();
  });

  test('教師端發送 mode: control 帶約束參數，學生端應收到完整訊息', async () => {
    teacher.send({
      t: 'broadcast',
      payload: { t: 'mode', mode: 'control', maxFramerate: 10, maxWidth: 1280, maxHeight: 720 },
    });

    const modeMsg = await student.waitForType('broadcast', 5000);
    expect(modeMsg).toBeTruthy();
    expect(modeMsg.from).toBe(teacher.selfId);
    expect(modeMsg.payload.t).toBe('mode');
    expect(modeMsg.payload.mode).toBe('control');
    expect(modeMsg.payload.maxFramerate).toBe(10);
    expect(modeMsg.payload.maxWidth).toBe(1280);
    expect(modeMsg.payload.maxHeight).toBe(720);
  });

  test('教師端發送 mode: monitor（離開接管），學生端應收到', async () => {
    teacher.send({
      t: 'broadcast',
      payload: { t: 'mode', mode: 'monitor' },
    });

    const modeMsg = await student.waitForType('broadcast', 5000);
    expect(modeMsg).toBeTruthy();
    expect(modeMsg.payload.t).toBe('mode');
    expect(modeMsg.payload.mode).toBe('monitor');
    expect(modeMsg.payload.maxFramerate).toBeUndefined();
    expect(modeMsg.payload.maxWidth).toBeUndefined();
    expect(modeMsg.payload.maxHeight).toBeUndefined();
  });

  test('教師端發送 mode: lock，學生端應收到且無約束參數', async () => {
    teacher.send({
      t: 'broadcast',
      payload: { t: 'mode', mode: 'lock' },
    });

    const modeMsg = await student.waitForType('broadcast', 5000);
    expect(modeMsg).toBeTruthy();
    expect(modeMsg.payload.t).toBe('mode');
    expect(modeMsg.payload.mode).toBe('lock');
  });

  test('學生端不能廣播 mode 訊息（角色權限，server 拒絕）', async () => {
    student.send({ t: 'broadcast', payload: { t: 'mode', mode: 'control' } });
    const err = await student.waitForType('error', 5000);
    expect(err).toBeTruthy();
    expect(err.code).toBe('role-forbidden');
  });
});
