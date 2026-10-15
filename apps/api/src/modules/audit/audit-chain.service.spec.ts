/**
 * AuditChainService — tamper-evident 해시체인 — 단위 테스트 5건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AuditChainService, type AuditRecord } from './audit-chain.service';

/** seq/hash/prevHash를 실제로 저장하는 in-memory prisma.auditLog 페이크. */
function fakePrisma() {
  const store: Record<string, unknown>[] = [];
  return {
    store,
    auditLog: {
      create: ({ data }: { data: Record<string, unknown> }) => { store.push({ ...data }); return Promise.resolve(data); },
      findFirst: ({ orderBy }: { orderBy?: { seq?: string } }) => {
        const chained = store.filter((r) => r.seq != null);
        if (chained.length === 0) return Promise.resolve(null);
        chained.sort((a, b) => (a.seq as number) - (b.seq as number));
        return Promise.resolve(orderBy?.seq === 'desc' ? chained[chained.length - 1] : chained[0]);
      },
      findMany: () => {
        const chained = store.filter((r) => r.seq != null).sort((a, b) => (a.seq as number) - (b.seq as number));
        return Promise.resolve(chained);
      },
    },
  };
}

function svc() {
  const prisma = fakePrisma();
  return { prisma, service: new AuditChainService(prisma as never) };
}

const rec = (n: number): AuditRecord => ({ userId: `U${n}`, action: 'POST', target: `/x/${n}`, detail: null, status: 200, sensitive: false });

describe('AuditChainService — tamper-evident 해시체인', () => {
  let s: ReturnType<typeof svc>;
  beforeEach(async () => { s = svc(); for (let i = 1; i <= 4; i++) await s.service.append(rec(i)); });

  it('정상 체인은 verify ok, seq 1..4 연속', async () => {
    const v = await s.service.verify();
    expect(v.ok).toBe(true);
    expect(v.count).toBe(4);
    expect(v.firstSeq).toBe(1);
    expect(v.lastSeq).toBe(4);
  });

  it('필드 변조(action 수정) → hash 불일치 탐지', async () => {
    s.prisma.store[2].action = 'DELETE'; // seq 3 변조
    const v = await s.service.verify();
    expect(v.ok).toBe(false);
    expect(v.brokenAt).toBe(3);
    expect(v.reason).toContain('hash');
  });

  it('중간 레코드 삭제 → seq gap 탐지', async () => {
    s.prisma.store.splice(1, 1); // seq 2 제거
    const v = await s.service.verify();
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('gap');
  });

  it('정당한 prefix 퍼지(seq 1 제거)는 정상', async () => {
    s.prisma.store.splice(0, 1); // 오래된 seq 1 제거 → 2,3,4 연속
    const v = await s.service.verify();
    expect(v.ok).toBe(true);
    expect(v.firstSeq).toBe(2);
  });

  it('append는 seq 단조·prevHash 연결', async () => {
    const rows = s.prisma.store;
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
    expect(rows[0].prevHash).toBe('0'.repeat(64));
    expect(rows[1].prevHash).toBe(rows[0].hash);
    expect(rows[3].prevHash).toBe(rows[2].hash);
  });
});
