/**
 * 수혈 출고 안전 게이트 — 단위 테스트 15건.
 *
 * 묶음: Westgard QC 판정, 유전체 동의 게이트.
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { checkIssueEligibility } from './transfusion-safety';
import { evaluateWestgard } from './westgard';
import { canSendout } from './genomic-consent';

describe('수혈 출고 안전 게이트', () => {
  const base = {
    aboVerifiedTwice: true, aboMatchesHistory: true, crossmatchResult: '적합',
    expiryDate: '2026-08-05', now: '2026-07-12', specialRequired: [], unitAttributes: [],
  };
  it('모든 조건 충족 시 출고 적격', () => {
    expect(checkIssueEligibility(base).eligible).toBe(true);
  });
  it('교차 부적합 → 차단', () => {
    expect(checkIssueEligibility({ ...base, crossmatchResult: '부적합' }).eligible).toBe(false);
  });
  it('유효기간 만료 → 차단', () => {
    const r = checkIssueEligibility({ ...base, expiryDate: '2026-07-01' });
    expect(r.eligible).toBe(false);
    expect(r.reasons).toContain('제제 유효기간 만료');
  });
  it('혈액형 이력 불일치 → 차단', () => {
    expect(checkIssueEligibility({ ...base, aboMatchesHistory: false }).eligible).toBe(false);
  });
  it('특수요구(방사선조사) 미충족 → 차단', () => {
    const r = checkIssueEligibility({ ...base, specialRequired: ['방사선조사'], unitAttributes: [] });
    expect(r.eligible).toBe(false);
    expect(r.reasons[0]).toContain('방사선조사');
  });
});

describe('Westgard QC 판정', () => {
  it('정상 범위 → PASS', () => {
    expect(evaluateWestgard([100, 101, 99], 100, 2).verdict).toBe('PASS');
  });
  it('1-3s 위반 → FAIL', () => {
    const r = evaluateWestgard([100, 107], 100, 2); // z=3.5
    expect(r.violations).toContain('1-3s');
    expect(r.verdict).toBe('FAIL');
  });
  it('2-2s(연속 동측 2SD) → FAIL', () => {
    const r = evaluateWestgard([104.5, 105], 100, 2); // z=2.25, 2.5
    expect(r.violations).toContain('2-2s');
    expect(r.verdict).toBe('FAIL');
  });
  it('1-2s 단독 → WARN', () => {
    const r = evaluateWestgard([100, 104.5], 100, 2); // z=2.25
    expect(r.verdict).toBe('WARN');
  });
  it('4-1s(연속 4회 동측 1SD) → FAIL(계통오차)', () => {
    const r = evaluateWestgard([102.5, 103, 102.2, 103.5], 100, 2); // z 모두 +1~+1.75
    expect(r.violations).toContain('4-1s');
    expect(r.verdict).toBe('FAIL');
  });
  it('4-1s 미달(3회만 동측) → 4-1s 없음', () => {
    const r = evaluateWestgard([102.5, 103, 102.2], 100, 2);
    expect(r.violations).not.toContain('4-1s');
  });
  it('10x(연속 10회 평균 동측) → FAIL(편향)', () => {
    const r = evaluateWestgard([100.5, 100.6, 100.4, 100.7, 100.3, 100.8, 100.2, 100.9, 100.5, 100.6], 100, 2);
    expect(r.violations).toContain('10x');
    expect(r.verdict).toBe('FAIL');
  });
});

describe('유전체 동의 게이트', () => {
  it('동의완료 → 발송 허용', () => {
    expect(canSendout({ exists: true, signedDate: '2026-07-15', withdrawn: false }).allowed).toBe(true);
  });
  it('동의없음 → 차단', () => {
    expect(canSendout({ exists: false, signedDate: null, withdrawn: false }).allowed).toBe(false);
  });
  it('철회 → 차단', () => {
    expect(canSendout({ exists: true, signedDate: '2026-07-15', withdrawn: true }).allowed).toBe(false);
  });
});
