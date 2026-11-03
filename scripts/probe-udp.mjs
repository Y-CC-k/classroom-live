// 診斷：UDP 探索測試（送 127.0.0.1 與 255.255.255.255）
import { createSocket } from 'node:dgram';
import os from 'node:os';

const udp = createSocket({ type: 'udp4', reuseAddr: true });
let got = false;
udp.on('message', (msg, rinfo) => {
  got = true;
  console.log('收到回應 from', rinfo.address + ':' + rinfo.port, '→', String(msg).substring(0, 120));
});
udp.on('error', (e) => console.log('UDP 錯誤:', e.message));
udp.bind(() => {
  udp.setBroadcast(true);
  const packet = Buffer.from(JSON.stringify({ t: 'classroom-discover' }));
  udp.send(packet, 8787, '127.0.0.1');
  udp.send(packet, 8787, '255.255.255.255');
  // 也試本機區網 IP（directed broadcast）
  for (const infos of Object.values(os.networkInterfaces())) {
    for (const info of infos ?? []) {
      if (info.family !== 'IPv4' || info.internal) continue;
      const base = info.address.split('.').slice(0, 3).join('.') + '.255';
      console.log('也送 directed broadcast:', base);
      udp.send(packet, 8787, base);
    }
  }
  setTimeout(() => {
    console.log(got ? '有回應 ✓' : '3 秒內無任何回應 ✗');
    udp.close();
  }, 3000);
});
