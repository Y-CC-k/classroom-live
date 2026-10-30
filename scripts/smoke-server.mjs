/**
 * 信令伺服器的煙霧測試（smoke test）。
 *
 * 不需要任何測試框架，直接驗證「教師機 ↔ 伺服器 ↔ 學生機」這條路徑上
 * 最重要的幾件事：
 *   1. hello 之後會拿到 welcome，而且教師與學生互相看得到
 *   2. WebRTC 信令（SDP / ICE）能被正確轉發到指定對象
 *   3. 教師的 broadcast 只會送到學生，不會回送給自己
 *   4. 離線時對方會收到 peer-left
 *
 * 用法：node scripts/smoke-server.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 8799);
const URL = `ws://127.0.0.1:${PORT}`;
const CLASS_ID = '999-001';

let failures = 0;

function check(label, condition, detail = '') {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures += 1;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** 建立一條會自動 hello 的連線，並把收到的訊息放進 inbox */
function makeClient(role, _name) {
  const socket = new WebSocket(URL);
  const inbox = [];
  const waiters = [];

  socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    const index = waiters.findIndex(waiter => waiter.match(message));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(message);
    } else {
      inbox.push(message);
    }
  });

  const client = {
    role,
    socket,
    inbox,
    /** 等一則符合條件的訊息，若已在 inbox 中則立刻回傳 */
    expect(match, timeoutMs = 4000) {
      const index = inbox.findIndex(match);
      if (index >= 0) return Promise.resolve(inbox.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const at = waiters.findIndex(waiter => waiter.timer === timer);
          if (at >= 0) waiters.splice(at, 1);
          reject(new Error(`等待訊息逾時（${timeoutMs}ms）`));
        }, timeoutMs);
        waiters.push({ match, resolve, timer });
      });
    },
    send(message) {
      socket.send(JSON.stringify(message));
    },
    close() {
      socket.close();
    },
    opened: new Promise(resolve => socket.addEventListener('open', resolve)),
  };

  return client;
}

async function main() {
  const server = spawn(
    process.execPath,
    [
      path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'),
      path.join(root, 'packages', 'server', 'src', 'index.ts'),
    ],
    {
      cwd: root,
      env: { ...process.env, CLASSROOM_PORT: String(PORT), CLASSROOM_HOST: '127.0.0.1', CLASSROOM_VERBOSE: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    }
  );
  server.stdout.on('data', () => {});
  server.stderr.on('data', chunk => process.stderr.write(`[server] ${chunk}`));

  try {
    // 等伺服器起來
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await fetch(`http://127.0.0.1:${PORT}/healthz`);
        break;
      } catch {
        await wait(200);
      }
    }

    console.log('\n1. 教師機加入班級');
    const teacher = makeClient('teacher', '王老師');
    await teacher.opened;
    teacher.send({
      t: 'hello',
      role: 'teacher',
      name: '王老師',
      classId: CLASS_ID,
      protocolVersion: 1,
      screen: { width: 1920, height: 1080, x: 0, y: 0, scaleFactor: 1, monitors: 1 },
    });
    const teacherWelcome = await teacher.expect(m => m.t === 'welcome');
    check('教師收到 welcome', teacherWelcome.t === 'welcome');
    check('教師拿到自己的 id', typeof teacherWelcome.self === 'string' && teacherWelcome.self.length > 0);
    check('新班級沒有其他成員', teacherWelcome.peers.length === 0);

    console.log('\n2. 學生機加入班級');
    const student = makeClient('student', 'PC-01');
    await student.opened;
    student.send({
      t: 'hello',
      role: 'student',
      name: 'PC-01',
      classId: CLASS_ID,
      protocolVersion: 1,
      agent: { version: '0.1.0', elevated: true, nativeReady: true, os: 'win32 x64' },
    });
    const studentWelcome = await student.expect(m => m.t === 'welcome');
    check('學生收到 welcome', studentWelcome.t === 'welcome');
    check(
      '學生看得到教師',
      studentWelcome.peers.some(p => p.role === 'teacher')
    );

    const joined = await teacher.expect(m => m.t === 'peer-joined');
    check('教師收到 peer-joined', joined.peer.name === 'PC-01');
    check('學生 metadata 有代理資訊', joined.peer.agent?.nativeReady === true);

    const studentId = studentWelcome.self;
    const teacherId = teacherWelcome.self;

    console.log('\n3. WebRTC 信令轉發');
    student.send({
      t: 'signal',
      to: teacherId,
      payload: { kind: 'monitor', description: { type: 'offer', sdp: 'v=0\r\nfake-offer' } },
    });
    const forwardedOffer = await teacher.expect(m => m.t === 'signal');
    check('教師收到學生的 offer', forwardedOffer.payload.description.sdp === 'v=0\r\nfake-offer');
    check('offer 來自學生', forwardedOffer.from === studentId);
    check('kind 正確', forwardedOffer.payload.kind === 'monitor');

    teacher.send({
      t: 'signal',
      to: studentId,
      payload: { kind: 'monitor', ice: { candidate: 'candidate:1 1 udp 123 10.0.0.5 50000 typ host' } },
    });
    const forwardedIce = await student.expect(m => m.t === 'signal');
    check('學生收到教師的 ICE', forwardedIce.payload.ice.candidate.includes('10.0.0.5'));

    console.log('\n4. 教師廣播');
    teacher.send({ t: 'broadcast', payload: { mode: 'lock' } });
    const broadcast = await student.expect(m => m.t === 'broadcast');
    check('學生收到教師廣播', broadcast.payload.mode === 'lock');
    check('廣播標記來源為教師', broadcast.from === teacherId);

    // 教師不應該收到自己的廣播
    await wait(300);
    check('教師沒有收到自己的廣播', !teacher.inbox.some(m => m.t === 'broadcast'));

    console.log('\n5. 學生不能廣播（角色權限）');
    student.send({ t: 'broadcast', payload: { hack: true } });
    const forbidden = await student.expect(m => m.t === 'error');
    check('學生廣播被拒絕', forbidden.code === 'role-forbidden', forbidden.message);

    console.log('\n6. metadata 更新');
    student.send({ t: 'meta', agent: { version: '0.1.0', elevated: false, nativeReady: true, os: 'win32 x64' } });
    const updated = await teacher.expect(m => m.t === 'peer-updated');
    check('教師收到 peer-updated', updated.peer.agent?.elevated === false);

    console.log('\n7. 離線通知');
    student.close();
    const left = await teacher.expect(m => m.t === 'peer-left');
    check('教師收到 peer-left', left.id === studentId);

    console.log('\n8. 未知對象');
    teacher.send({ t: 'signal', to: 'nonexistent0', payload: { kind: 'broadcast', ice: { candidate: 'x' } } });
    const unknown = await teacher.expect(m => m.t === 'error');
    check('未知對象被拒絕', unknown.code === 'unknown-peer');

    console.log('\n9. 協定版本檢查');
    const old = makeClient('student', 'PC-OLD');
    await old.opened;
    old.send({ t: 'hello', role: 'student', name: 'PC-OLD', classId: CLASS_ID, protocolVersion: 0 });
    const mismatch = await old.expect(m => m.t === 'error');
    check('版本不符被拒絕', mismatch.code === 'protocol-mismatch');

    teacher.close();
    old.close();
  } catch (error) {
    failures += 1;
    console.error('\n測試過程中發生例外：', error);
  } finally {
    await wait(200);
    server.kill();
  }

  console.log(failures === 0 ? '\n全部通過 ✅' : `\n有 ${failures} 項失敗 ❌`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
