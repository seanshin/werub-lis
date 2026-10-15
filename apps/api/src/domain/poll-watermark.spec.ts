/**
 * nextWatermark — 실패분을 건너뛰지 않는다(P1-8 회귀 금지) — 단위 테스트 8건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { nextWatermark } from './poll-watermark';

/**
 * 근거: docs/재검토_2026-07-21_발견목록.md P1-8
 * "HIS 취소 워터마크가 실패분을 건너뛰고 전진한다 → 임상의가 취소한 오더를 계속 수행·보고"
 * 이 파일은 그 회귀를 막는다.
 */
describe('nextWatermark — 실패분을 건너뛰지 않는다(P1-8 회귀 금지)', () => {
  const since = '2026-07-21T00:00:00.000Z';

  it('전부 성공하면 최대 처리시각까지 전진한다(1초 백오프)', () => {
    const wm = nextWatermark({ since, maxProcessed: '2026-07-21T01:00:00.000Z', earliestFailure: null, hold: false });
    expect(wm).toBe('2026-07-21T00:59:59.000Z');
  });

  it('★실패분이 있으면 그 앞에서 멈춘다 — 뒤의 성공분 시각으로 전진하지 않는다', () => {
    // 01:00 취소가 실패했는데 02:00 취소는 성공한 상황. 02:00으로 전진하면 01:00 취소는
    // 영영 재조회되지 않고 그 검사는 계속 수행된다.
    const wm = nextWatermark({
      since,
      maxProcessed: '2026-07-21T02:00:00.000Z',
      earliestFailure: '2026-07-21T01:00:00.000Z',
      hold: false,
    });
    expect(wm).toBe('2026-07-21T00:59:59.000Z'); // 실패 시각 직전
  });

  it('실패분이 성공분보다 뒤여도 실패 앞에서 멈춘다', () => {
    const wm = nextWatermark({
      since,
      maxProcessed: '2026-07-21T01:00:00.000Z',
      earliestFailure: '2026-07-21T03:00:00.000Z',
      hold: false,
    });
    expect(wm).toBe('2026-07-21T00:59:59.000Z'); // 성공분(01:00)까지만 — 03:00 실패는 재조회 대상
  });

  it('시각을 알 수 없는 실패·목록 조회 실패(hold) → 전진하지 않는다', () => {
    // 취소 목록 자체를 못 받으면 이 구간에 취소가 있었는지조차 모른다.
    expect(nextWatermark({ since, maxProcessed: '2026-07-21T05:00:00.000Z', earliestFailure: null, hold: true })).toBeNull();
  });

  it('처리 성공분이 없으면 전진하지 않는다(빈 폴링)', () => {
    expect(nextWatermark({ since, maxProcessed: '', earliestFailure: null, hold: false })).toBeNull();
  });

  it('실패 시각이 현재 워터마크보다 이르면 되돌아간다(재조회가 누락보다 안전)', () => {
    const wm = nextWatermark({
      since,
      maxProcessed: '2026-07-21T02:00:00.000Z',
      earliestFailure: '2026-07-20T12:00:00.000Z',
      hold: false,
    });
    expect(wm).toBe('2026-07-20T11:59:59.000Z');
  });

  it('결과가 기존 워터마크와 같으면 쓰지 않는다', () => {
    // maxProcessed - 1초 == since
    expect(nextWatermark({ since: '2026-07-21T00:59:59.000Z', maxProcessed: '2026-07-21T01:00:00.000Z', earliestFailure: null, hold: false })).toBeNull();
  });

  it('최초 폴링(since=null)도 정상 전진한다', () => {
    expect(nextWatermark({ since: null, maxProcessed: '2026-07-21T01:00:00.000Z', earliestFailure: null, hold: false })).toBe('2026-07-21T00:59:59.000Z');
  });
});
