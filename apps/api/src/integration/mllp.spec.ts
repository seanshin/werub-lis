/**
 * MLLP 프레이밍 — 단위 테스트 4건.
 *
 * 묶음: MLLP TCP 전송(로컬 에코 서버).
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import * as net from 'net';
import { encodeMllp, decodeMllp, sendMllp } from './mllp';

describe('MLLP 프레이밍', () => {
  it('encode → VT..FS CR 프레임', () => {
    const b = encodeMllp('MSH|test');
    expect(b[0]).toBe(0x0b);
    expect(b[b.length - 2]).toBe(0x1c);
    expect(b[b.length - 1]).toBe(0x0d);
  });
  it('encode→decode 왕복 복원', () => {
    expect(decodeMllp(encodeMllp('MSH|^~\\&|A|B'))).toBe('MSH|^~\\&|A|B');
  });
});

describe('MLLP TCP 전송(로컬 에코 서버)', () => {
  it('메시지 전송 후 ACK(AA) 수신', async () => {
    // ACK를 돌려주는 임시 MLLP 서버
    const server = net.createServer((sock) => {
      sock.on('data', () => {
        const ack = Buffer.concat([
          Buffer.from([0x0b]),
          Buffer.from('MSH|^~\\&|X\rMSA|AA|MSG1'),
          Buffer.from([0x1c, 0x0d]),
        ]);
        sock.write(ack);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;

    const res = await sendMllp('127.0.0.1', port, 'MSH|^~\\&|LIS');
    expect(res.ackCode).toBe('AA');
    expect(res.ack).toContain('MSA|AA');
    server.close();
  });

  it('미응답 시 시간초과', async () => {
    const server = net.createServer(() => {
      /* 응답 안 함 */
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as net.AddressInfo).port;
    await expect(sendMllp('127.0.0.1', port, 'MSH|x', 300)).rejects.toThrow(/시간초과/);
    server.close();
  });
});
