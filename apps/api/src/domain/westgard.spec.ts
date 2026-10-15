/**
 * evaluateWestgard (Westgard 다중규칙) — 단위 테스트 11건.
 *
 * 묶음: crossLevelViolations (within-run 다중레벨).
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { evaluateWestgard, crossLevelViolations } from './westgard';

// mean 100, sd 2 → z = (v-100)/2
const M = 100, SD = 2;
const v = (z: number) => M + z * SD;

describe('evaluateWestgard (Westgard 다중규칙)', () => {
  it('정상 범위 → PASS', () => {
    expect(evaluateWestgard([v(0.5), v(-0.3), v(1.0)], M, SD).verdict).toBe('PASS');
  });
  it('1-3s → FAIL', () => {
    const r = evaluateWestgard([v(0), v(3.5)], M, SD);
    expect(r.violations).toContain('1-3s');
    expect(r.verdict).toBe('FAIL');
  });
  it('1-2s 단독 → WARN', () => {
    const r = evaluateWestgard([v(0), v(2.5)], M, SD);
    expect(r.verdict).toBe('WARN');
    expect(r.violations).toContain('1-2s(warn)');
  });
  it('2-2s 연속 동측 → FAIL', () => {
    expect(evaluateWestgard([v(2.3), v(2.4)], M, SD).violations).toContain('2-2s');
  });
  it('R-4s — 반대방향 각각 2s 초과 → FAIL', () => {
    expect(evaluateWestgard([v(-2.5), v(2.5)], M, SD).violations).toContain('R-4s');
  });
  it('R-4s 위양성 방지 — 같은쪽 멀리(범위>4s지만 한쪽만) → R-4s 아님', () => {
    // a=+2.5, b=-1.6 → |Δ|=4.1>4 이지만 b가 -2s 이내라 R-4s 아님
    const r = evaluateWestgard([v(-1.6), v(2.5)], M, SD);
    expect(r.violations).not.toContain('R-4s');
    expect(r.violations).toContain('1-2s(warn)'); // +2.5s는 1-2s 경고
  });
  it('4-1s 연속 4회 동측 1s 초과 → FAIL', () => {
    expect(evaluateWestgard([v(1.2), v(1.3), v(1.1), v(1.4)], M, SD).violations).toContain('4-1s');
  });
  it('10x 연속 10회 동측 → FAIL', () => {
    expect(evaluateWestgard(Array(10).fill(v(0.5)), M, SD).violations).toContain('10x');
  });
});

describe('crossLevelViolations (within-run 다중레벨)', () => {
  it('두 레벨 같은방향 2s 초과 → 2-2s(within-run)', () => {
    expect(crossLevelViolations([2.3, 2.4])).toContain('2-2s(within-run)');
  });
  it('반대방향 각 2s 초과 → R-4s(within-run)', () => {
    expect(crossLevelViolations([2.5, -2.5])).toContain('R-4s(within-run)');
  });
  it('정상 레벨들 → 위반 없음', () => {
    expect(crossLevelViolations([0.5, -0.8, 1.2])).toEqual([]);
  });
});
