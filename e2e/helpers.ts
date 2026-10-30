/**
 * 教室直播系統 - E2E 測試輔助函數
 *
 * 用 WebSocket 直接模擬教師機和學生機與伺服器的通信，
 * 無需啟動完整的 Electron 應用程式，測試更快速且穩定。
 */

import { WebSocket } from 'ws';

const SERVER_URL = 'ws://localhost:8787';

export class TestClient {
  private socket: WebSocket;
  public messages: any[] = [];
  public connected: boolean = false;
  public selfId: string | null = null;

  constructor() {
    this.socket = new WebSocket(SERVER_URL);
    this.socket.on('open', () => {
      this.connected = true;
    });
    this.socket.on('message', data => {
      try {
        const msg = JSON.parse(data.toString());
        this.messages.push(msg);
      } catch {
        // 忽略無法解析的訊息
      }
    });
    this.socket.on('error', error => {
      console.error('WebSocket error:', error);
    });
    this.socket.on('close', () => {
      this.connected = false;
    });
  }

  waitForMessage(timeout = 5000): Promise<any> {
    return new Promise((resolve, reject) => {
      setTimeout(() => {
        reject(new Error(`Timeout waiting for message after ${timeout}ms`));
      }, timeout);

      const check = () => {
        if (this.messages.length > 0) {
          resolve(this.messages.shift());
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  send(message: any) {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify(message));
    }
  }

  close() {
    this.socket.close();
  }

  async hello(role: 'teacher' | 'student', classId: string, name: string) {
    this.send({
      t: 'hello',
      role,
      name,
      classId,
      protocolVersion: 1,
    });
    const welcome = await this.waitForMessage();
    if (welcome.t === 'welcome') {
      this.selfId = welcome.self;
    }
    return welcome;
  }

  async waitForBroadcast(on: boolean, mode: string = 'video', timeout = 5000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const msg = this.messages.find(m => m.t === 'broadcast' && m.on === on && m.mode === mode);
      if (msg) {
        return msg;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for broadcast ${on} ${mode}`);
  }

  async waitForLock(on: boolean, timeout = 5000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const msg = this.messages.find(m => m.t === 'lock' && m.on === on);
      if (msg) {
        return msg;
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for lock ${on}`);
  }
}

export async function createTeacher(classId: string = 'E2E-TEST', name: string = 'Teacher') {
  const teacher = new TestClient();
  await teacher.hello('teacher', classId, name);
  return teacher;
}

export async function createStudent(classId: string = 'E2E-TEST', name: string = 'Student') {
  const student = new TestClient();
  await student.hello('student', classId, name);
  return student;
}
