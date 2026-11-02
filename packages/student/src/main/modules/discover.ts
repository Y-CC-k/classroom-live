/**
 * 區網伺服器自動搜尋（UDP 廣播探索）。
 *
 * 學生機連不上設定的伺服器位址時，廣播 { t: 'classroom-discover' }
 * 到 255.255.255.255:8787 與 127.0.0.1:8787；伺服器收到後回覆
 * { t: 'classroom-announce', wsUrl }。收集 timeoutMs 內的所有回應。
 */
import { createSocket } from 'node:dgram';

export interface DiscoveredServer {
  wsUrl: string;
}

export function discoverServers(timeoutMs = 2000): Promise<DiscoveredServer[]> {
  return new Promise(resolve => {
    const found = new Set<string>();
    const udp = createSocket({ type: 'udp4', reuseAddr: true });
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      try {
        udp.close();
      } catch {
        /* 已關閉就算了 */
      }
      resolve([...found].map(wsUrl => ({ wsUrl })));
    };

    udp.on('message', msg => {
      try {
        const parsed = JSON.parse(String(msg)) as { t?: string; wsUrl?: string };
        if (parsed?.t === 'classroom-announce' && typeof parsed.wsUrl === 'string') {
          found.add(parsed.wsUrl);
        }
      } catch {
        /* 壞封包忽略 */
      }
    });

    udp.on('error', () => finish());

    udp.bind(() => {
      udp.setBroadcast(true);
      const packet = Buffer.from(JSON.stringify({ t: 'classroom-discover' }));
      udp.send(packet, 8787, '255.255.255.255');
      udp.send(packet, 8787, '127.0.0.1'); // 教師機本機同跑 server 的測試情境
      setTimeout(finish, Math.max(500, timeoutMs));
    });
  });
}
