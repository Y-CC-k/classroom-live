/**
 * 教室直播系統 - E2E 測試輔助函數
 *
 * 用 WebSocket 直接模擬教師機和學生機與伺服器的通信，
 * 無需啟動完整的 Electron 應用程式，測試更快速且穩定。
 */

import { WebSocket } from 'ws';

const SERVER_URL = 'ws://127.0.0.1:8787';

export class TestClient {
  private socket: WebSocket;
  public messages: any[] = [];
  public connected: boolean = false;
  public selfId: string | null = null;
  public welcome: any = null;

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

  /** 等待 WebSocket 連線開啟（在 open 前發送的訊息會被靜默丟棄，必須先等） */
  waitOpen(timeout = 5000): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Timeout waiting for WebSocket open after ${timeout}ms`)),
        timeout
      );
      this.socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once('error', err => {
        clearTimeout(timer);
        reject(err);
      });
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

  /** 等待指定型別的訊息（輪詢已收到的訊息列表） */
  async waitForType(type: string, timeout = 5000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const index = this.messages.findIndex((m: any) => m.t === type);
      if (index >= 0) {
        return this.messages.splice(index, 1)[0];
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for message type '${type}'`);
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
    await this.waitOpen();
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
      this.welcome = welcome;
    }
    return welcome;
  }

  /** 等待廣播訊息（server 轉發格式：{ t: 'broadcast', from, payload: { on, mode } }） */
  async waitForBroadcast(on: boolean, mode: string = 'video', timeout = 5000): Promise<any> {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const index = this.messages.findIndex(
        (m: any) => m.t === 'broadcast' && m.payload?.on === on && m.payload?.mode === mode
      );
      if (index >= 0) {
        return this.messages.splice(index, 1)[0];
      }
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`Timeout waiting for broadcast on=${on} mode=${mode}`);
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
