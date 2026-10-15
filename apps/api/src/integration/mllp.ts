/**
 * HL7 MLLP (Minimal Lower Layer Protocol) — 실제 병원 HL7 전송 프로토콜.
 * 근거: 01 연계규격서 §2.1 (MLLP 프레이밍).
 * 프레임: <VT> payload <FS><CR>  (VT=0x0B, FS=0x1C, CR=0x0D)
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import * as net from 'net';

const VT = 0x0b;
const FS = 0x1c;
const CR = 0x0d;

/** HL7 원문 → MLLP 프레임 버퍼 */
export function encodeMllp(message: string): Buffer {
  return Buffer.concat([Buffer.from([VT]), Buffer.from(message, 'utf8'), Buffer.from([FS, CR])]);
}

/** MLLP 프레임 버퍼 → HL7 원문(프레이밍 제거) */
export function decodeMllp(buf: Buffer): string {
  let start = 0;
  let end = buf.length;
  if (buf.length > 0 && buf[0] === VT) start = 1;
  const fsIdx = buf.indexOf(FS, start);
  if (fsIdx !== -1) end = fsIdx;
  return buf.slice(start, end).toString('utf8');
}

export interface MllpSendResult {
  ack: string; // 수신 ACK 원문
  ackCode: string; // MSA-1 (AA/AE/AR) — 파싱 실패 시 ''
}

/**
 * MLLP로 HL7 메시지 전송 후 ACK 수신 (TCP).
 * @param timeoutMs 응답 대기 한도
 */
export function sendMllp(
  host: string,
  port: number,
  message: string,
  timeoutMs = 8000,
): Promise<MllpSendResult> {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const chunks: Buffer[] = [];
    let settled = false;

    const done = (err: Error | null, res?: MllpSendResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(res as MllpSendResult);
    };

    socket.setTimeout(timeoutMs);
    socket.on('timeout', () => done(new Error('MLLP 응답 시간초과')));
    socket.on('error', (e) => done(e));
    socket.on('data', (d: Buffer) => {
      chunks.push(d);
      const buf = Buffer.concat(chunks);
      // FS+CR 수신 시 완료
      if (buf.includes(FS)) {
        const ack = decodeMllp(buf);
        const m = ack.match(/MSA\|([A-Z]{2})/);
        done(null, { ack, ackCode: m ? m[1] : '' });
      }
    });

    socket.connect(port, host, () => {
      socket.write(encodeMllp(message));
    });
  });
}
