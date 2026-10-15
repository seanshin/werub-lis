/**
 * S-3 대상 토큰(X-Target-Token) — HIS 규격 정합 — 단위 테스트 4건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { buildTargetToken } from './his-target-token';

describe('S-3 대상 토큰(X-Target-Token) — HIS 규격 정합', () => {
  const uuid = '00000000-0000-4000-a000-000000d0055a';
  const secret = 'test-secret';

  it('형식 — <patientId>.<exp>.<hmac 64hex>', () => {
    const t = buildTargetToken(uuid, secret, 1753142400);
    const parts = t.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe(uuid);
    expect(parts[1]).toBe('1753142400');
    expect(parts[2]).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hmac은 규격 페이로드(`<patientId>.<exp>`)에 대한 HMAC-SHA256', () => {
    const exp = 1753142400;
    const t = buildTargetToken(uuid, secret, exp);
    const expected = createHmac('sha256', secret).update(`${uuid}.${exp}`).digest('hex');
    expect(t.endsWith(expected)).toBe(true);
  });

  it('시크릿·만료가 다르면 서명이 달라진다(위조 불가 성질)', () => {
    expect(buildTargetToken(uuid, secret, 1)).not.toBe(buildTargetToken(uuid, 'other', 1));
    expect(buildTargetToken(uuid, secret, 1)).not.toBe(buildTargetToken(uuid, secret, 2));
  });
});
