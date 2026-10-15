/**
 * InternalOnlyGuard 단위 테스트 — 무인증 지표 엔드포인트의 접근원 판정.
 *
 * 회귀 대상 둘 —
 *  ① 2026-09-09 서버 이관에서 프록시(nginx `deny all`)가 Caddy로 바뀌며 차단이 사라져
 *     `/api/v1/metrics`가 인터넷에 200으로 열린 사고.
 *  ② 그 대응으로 루프백만 허용했더니(v1.56.15) **호스트 내부 수집까지 404**가 된 사고 —
 *     컨테이너는 게시 포트로 들어온 요청을 도커 게이트웨이(172.20.0.1) 출발지로 본다.
 * 둘 다 다시 나지 않게 한다: 공인 IP는 막고, 내부(루프백·사설대역)는 통과.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { ExecutionContext, NotFoundException } from '@nestjs/common';
import { InternalOnlyGuard, isInternalAddress } from './internal-only.guard';

/** req만 있으면 되는 최소 ExecutionContext. */
function ctx(req: unknown): ExecutionContext {
  return { switchToHttp: () => ({ getRequest: () => req }) } as unknown as ExecutionContext;
}

describe('isInternalAddress', () => {
  it.each(['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1'])('루프백 통과: %s', (ip) => {
    expect(isInternalAddress(ip)).toBe(true);
  });

  it.each([
    ['172.20.0.1', '도커 브리지 게이트웨이 — 호스트에서 게시 포트로 들어온 수집'],
    ['172.17.0.1', '도커 기본 브리지'],
    ['10.0.0.5', '사설 10/8'],
    ['192.168.1.10', '사설 192.168/16'],
    ['::ffff:172.20.0.1', 'IPv4-mapped 도커 게이트웨이'],
  ])('내부망 통과: %s (%s)', (ip) => {
    expect(isInternalAddress(ip)).toBe(true);
  });

  it.each(['8.8.8.8', '203.0.113.9', '::ffff:8.8.8.8', '172.15.0.1', '172.32.0.1', '191.168.1.1'])(
    '공인·대역 밖은 차단: %s',
    (ip) => {
      expect(isInternalAddress(ip)).toBe(false);
    },
  );

  it('값이 없으면 차단 쪽으로 판정한다(모르면 여는 게 아니라 닫는다)', () => {
    expect(isInternalAddress(undefined)).toBe(false);
    expect(isInternalAddress(null)).toBe(false);
    expect(isInternalAddress('')).toBe(false);
  });

  it('내부처럼 보이는 문자열·잘못된 옥텟에 속지 않는다', () => {
    expect(isInternalAddress('127.0.0.1.evil.com')).toBe(false);
    expect(isInternalAddress('x10.0.0.1')).toBe(false);
    expect(isInternalAddress('10.0.0.999')).toBe(false);
    expect(isInternalAddress('999.0.0.1')).toBe(false);
  });
});

describe('InternalOnlyGuard', () => {
  const guard = new InternalOnlyGuard();

  it('호스트 내부 수집은 통과 — 컨테이너가 보는 출발지는 도커 게이트웨이다', () => {
    expect(guard.canActivate(ctx({ ip: '172.20.0.1' }))).toBe(true);
    expect(guard.canActivate(ctx({ ip: '127.0.0.1' }))).toBe(true);
  });

  it('외부 요청은 404 — 403은 존재를 확인해 준다', () => {
    expect(() => guard.canActivate(ctx({ ip: '203.0.113.9' }))).toThrow(NotFoundException);
  });

  it('★XFF를 위조해도 통과하지 못한다 — 판정은 req.ip(신뢰 홉 반영)로만 한다', () => {
    const req = {
      ip: '203.0.113.9',
      headers: { 'x-forwarded-for': '127.0.0.1, 10.0.0.5' },
      socket: { remoteAddress: '::ffff:172.20.0.1' },
    };
    expect(() => guard.canActivate(ctx(req))).toThrow(NotFoundException);
  });

  it('req.ip가 없으면 소켓 주소로 판정한다(trust proxy 미설정 환경)', () => {
    expect(guard.canActivate(ctx({ socket: { remoteAddress: '::ffff:127.0.0.1' } }))).toBe(true);
    expect(() => guard.canActivate(ctx({ socket: { remoteAddress: '203.0.113.9' } }))).toThrow(
      NotFoundException,
    );
  });
});
