import type { AgentMeta, PeerInfo, Role, ScreenMeta } from '@classroom/protocol';
import type { WebSocket } from 'ws';

export interface Client {
  id: string;
  role: Role;
  name: string;
  classId: string;
  joinedAt: number;
  screen?: ScreenMeta;
  agent?: AgentMeta;
  socket: WebSocket;
  /** 心跳存活旗標，每輪 ping 後重設 */
  alive: boolean;
  missCount: number;
  /**
   * 一鍵開機（Wake-on-LAN）用：hello 帶來、經 `normalizeMac` 驗過的網卡 MAC。
   * `macs[0]` 就是 `mac`（主網卡）。舊版學生機不帶 → 欄位不存在，照常運作。
   */
  macs?: string[];
  /** 連線來源 IP（伺服器從 socket 看到的，不採信客戶端自報） */
  ip?: string;
}

export type JoinResult =
  | { ok: true; client: Client; /** 被新連線取代的舊連線（教師重連時可能發生） */ evicted: Client | null }
  | { ok: false; code: 'room-full'; message: string };

/**
 * 一個班級 = 一個房間。
 *
 * 刻意設計成「一位教師 + N 位學生」的星狀拓樸：
 *   - 學生之間不需要互相連線（實際上也禁止），
 *   - 只有教師能發廣播指令，
 *   - 未來若把 broadcast 換成 SFU，房間成員結構不變。
 */
export class Room {
  readonly id: string;
  teacher: Client | null = null;
  readonly students = new Map<string, Client>();
  readonly createdAt = Date.now();

  private readonly maxStudents: number;

  constructor(id: string, maxStudents: number) {
    this.id = id;
    this.maxStudents = maxStudents;
  }

  get isEmpty(): boolean {
    return this.teacher === null && this.students.size === 0;
  }

  get size(): number {
    return this.students.size + (this.teacher ? 1 : 0);
  }

  addStudent(client: Client): JoinResult {
    if (this.students.size >= this.maxStudents) {
      return {
        ok: false,
        code: 'room-full',
        message: `班級 ${this.id} 已達上限 ${this.maxStudents} 人`,
      };
    }
    this.students.set(client.id, client);
    return { ok: true, client, evicted: null };
  }

  /**
   * 教師加入。
   * 若已有教師在線，直接踢掉舊的 —— 因為實務上最常見的情境是
   * 「教師機當掉後重開」，此時寧可讓新的接手，也不要讓老師卡在門外。
   */
  addTeacher(client: Client): JoinResult {
    const previous = this.teacher;
    this.teacher = client;
    return { ok: true, client, evicted: previous };
  }

  remove(client: Client): void {
    if (client.role === 'teacher') {
      if (this.teacher?.id === client.id) this.teacher = null;
    } else {
      // 只有 id 相符才刪，避免「踢掉舊教師」時誤刪新連線
      if (this.students.get(client.id) === client) {
        this.students.delete(client.id);
      }
    }
  }

  toPeerInfo(client: Client): PeerInfo {
    const info: PeerInfo = {
      id: client.id,
      role: client.role,
      name: client.name,
      joinedAt: client.joinedAt,
    };
    if (client.screen) info.screen = client.screen;
    if (client.agent) info.agent = client.agent;
    if (client.macs?.length) {
      info.macs = client.macs;
      info.mac = client.macs[0];
    }
    if (client.ip) info.ip = client.ip;
    return info;
  }

  /** 除了 excludeId 之外的所有成員 */
  peersExcept(excludeId: string): PeerInfo[] {
    const out: PeerInfo[] = [];
    if (this.teacher && this.teacher.id !== excludeId) out.push(this.toPeerInfo(this.teacher));
    for (const student of this.students.values()) {
      if (student.id !== excludeId) out.push(this.toPeerInfo(student));
    }
    return out;
  }

  findByPeerId(peerId: string): Client | null {
    if (this.teacher?.id === peerId) return this.teacher;
    return this.students.get(peerId) ?? null;
  }

  allClients(): Client[] {
    const out: Client[] = [];
    if (this.teacher) out.push(this.teacher);
    for (const student of this.students.values()) out.push(student);
    return out;
  }

  /** 所有學生（不含教師） */
  allStudents(): Client[] {
    return [...this.students.values()];
  }
}

/** 房間註冊表 */
export class RoomRegistry {
  private readonly rooms = new Map<string, Room>();

  constructor(private readonly maxStudentsPerRoom: number) {}

  /** 取得或建立房間 */
  obtain(classId: string): Room {
    let room = this.rooms.get(classId);
    if (!room) {
      room = new Room(classId, this.maxStudentsPerRoom);
      this.rooms.set(classId, room);
    }
    return room;
  }

  get(classId: string): Room | undefined {
    return this.rooms.get(classId);
  }

  /** 回收空房間，避免長時間執行後記憶體累積 */
  sweepEmpty(ttlMs: number, now = Date.now()): string[] {
    const removed: string[] = [];
    for (const [id, room] of this.rooms) {
      if (room.isEmpty && now - room.createdAt > ttlMs) {
        this.rooms.delete(id);
        removed.push(id);
      }
    }
    return removed;
  }

  stats(): { rooms: number; students: number; teachers: number } {
    let students = 0;
    let teachers = 0;
    for (const room of this.rooms.values()) {
      students += room.students.size;
      if (room.teacher) teachers += 1;
    }
    return { rooms: this.rooms.size, students, teachers };
  }

  list(): Room[] {
    return [...this.rooms.values()];
  }
}
