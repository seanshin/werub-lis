/**
 * trustProxyHops — 단위 테스트 3건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { trustProxyHops } from './trust-proxy';

/**
 * compose는 미설정 env를 빈 문자열로 전달한다(`${VAR:-}`). 빈 문자열이 0으로 해석되면
 * trust proxy가 꺼져 ①레이트리밋이 전 병원 단일 버킷이 되고 ②감사 IP가 도커 게이트웨이로 찍힌다.
 * 실제로 배포 후 이 경로로 무력화된 적이 있다(회귀 금지).
 */
describe('trustProxyHops', () => {
  it('미설정·빈 문자열·비수치는 기본 1', () => {
    expect(trustProxyHops(undefined)).toBe(1);
    expect(trustProxyHops('')).toBe(1);
    expect(trustProxyHops('   ')).toBe(1);
    expect(trustProxyHops('abc')).toBe(1);
  });
  it('0·음수는 기본 1(설정을 끄는 값으로 오해되지 않도록)', () => {
    expect(trustProxyHops('0')).toBe(1);
    expect(trustProxyHops('-2')).toBe(1);
  });
  it('양수는 그대로 사용(프록시 다단 구성)', () => {
    expect(trustProxyHops('1')).toBe(1);
    expect(trustProxyHops('2')).toBe(2);
  });
});
