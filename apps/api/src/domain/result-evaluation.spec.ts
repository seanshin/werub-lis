/**
 * pickReferenceRange — 단위 테스트 33건.
 *
 * 묶음: determineFlag, isAutoVerifiable, isCritical / isNumeric, checkDelta — 직전 결과 대비 급변(검체 뒤바뀜 탐지), holdReasonFor — 보류 사유 판정(우선순위 있는 단일 사유)….
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { pickReferenceRange, determineFlag, isAutoVerifiable, isCritical, isNumeric, RefRange, checkDelta, holdReasonFor, holdPriority, validateReferenceRange } from './result-evaluation';

const hgbM: RefRange = { sex: 'M', ageMin: 18, ageMax: 200, low: 13, high: 17, panicLow: 7, panicHigh: 20 };
const hgbF: RefRange = { sex: 'F', ageMin: 18, ageMax: 200, low: 12, high: 16, panicLow: 7, panicHigh: 20 };
const k: RefRange = { sex: 'A', ageMin: 0, ageMax: 200, low: 3.5, high: 5.1, panicLow: 2.5, panicHigh: 6.5 };

describe('pickReferenceRange', () => {
  it('성별 정확 매칭을 우선 선택한다', () => {
    expect(pickReferenceRange([hgbM, hgbF], 'M', 46)).toBe(hgbM);
    expect(pickReferenceRange([hgbM, hgbF], 'F', 46)).toBe(hgbF);
  });
  it("성별 미매칭 시 'A' 참고치를 사용한다", () => {
    expect(pickReferenceRange([k], 'M', 40)).toBe(k);
  });
  it('연령 범위 밖이면 null', () => {
    expect(pickReferenceRange([hgbM], 'M', 10)).toBeNull();
  });
});

describe('determineFlag', () => {
  it('위험치 하한 → LL (홍길동 Hb 6.5)', () => {
    expect(determineFlag(6.5, hgbM)).toBe('LL');
  });
  it('위험치 상한 → HH (김철수 K 6.8)', () => {
    expect(determineFlag(6.8, k)).toBe('HH');
  });
  it('참고치 밖 → H / L', () => {
    expect(determineFlag(18, hgbM)).toBe('H');
    expect(determineFlag(10, hgbM)).toBe('L');
  });
  it('참고치 이내 → N', () => {
    expect(determineFlag(15, hgbM)).toBe('N');
    expect(determineFlag(4.2, k)).toBe('N');
  });
});

describe('isAutoVerifiable', () => {
  it('정상(N)·수치·QC정상은 자동검증', () => {
    expect(isAutoVerifiable({ numeric: true, flag: 'N' })).toBe(true);
  });
  it('위험치는 수동검증', () => {
    expect(isAutoVerifiable({ numeric: true, flag: 'HH' })).toBe(false);
    expect(isAutoVerifiable({ numeric: true, flag: 'LL' })).toBe(false);
  });
  it('QC위반·델타초과·장비오류는 수동검증', () => {
    expect(isAutoVerifiable({ numeric: true, flag: 'N', qcOk: false })).toBe(false);
    expect(isAutoVerifiable({ numeric: true, flag: 'N', deltaExceeded: true })).toBe(false);
    expect(isAutoVerifiable({ numeric: true, flag: 'N', instrumentError: true })).toBe(false);
  });
  it('비수치 결과는 수동검증', () => {
    expect(isAutoVerifiable({ numeric: false, flag: 'N' })).toBe(false);
  });
});

describe('isCritical / isNumeric', () => {
  it('HH/LL은 위험치', () => {
    expect(isCritical('HH')).toBe(true);
    expect(isCritical('LL')).toBe(true);
    expect(isCritical('N')).toBe(false);
  });
  it('수치 판정', () => {
    expect(isNumeric('6.5')).toBe(true);
    expect(isNumeric('Positive')).toBe(false);
    expect(isNumeric('')).toBe(false);
    expect(isNumeric(null)).toBe(false);
  });
});

// ── 자동확정 게이트(재검토 Q4) ─────────────────────────────
// 이 세 함수가 "결과가 사람 검토 없이 차트로 나가는가"를 결정한다. 회귀 시 임상 영향이 직접적이라
// 규칙을 테스트로 고정한다. 근거: docs/재검토_2026-07-21_발견목록.md Q4

describe('checkDelta — 직전 결과 대비 급변(검체 뒤바뀜 탐지)', () => {
  it('직전값이 없으면 판정하지 않는다(첫 검사)', () => {
    const r = checkDelta(null, 5);
    expect(r.hasPrev).toBe(false);
    expect(r.exceeded).toBe(false);
    expect(r.pctDelta).toBeNull();
  });

  it('NaN 직전값도 판정하지 않는다(문자 결과 등에서 유입)', () => {
    expect(checkDelta(Number.NaN, 5).hasPrev).toBe(false);
  });

  it('기본 한계는 50% — 미만은 통과, 이상은 차단', () => {
    expect(checkDelta(100, 149).exceeded).toBe(false); // 49%
    expect(checkDelta(100, 150).exceeded).toBe(true); // 50% 경계 포함
    expect(checkDelta(100, 40).exceeded).toBe(true); // 감소 방향도 동일
  });

  it('절대값 한계는 백분율과 OR로 적용된다', () => {
    // 변화율은 작지만 절대 변화가 큰 경우(고농도 구간) — absLimit이 잡아야 한다
    expect(checkDelta(1000, 1100, { pctLimit: 50 }).exceeded).toBe(false);
    expect(checkDelta(1000, 1100, { pctLimit: 50, absLimit: 100 }).exceeded).toBe(true);
  });

  it('직전값 0이면 백분율을 낼 수 없다 — 절대값 기준만 유효', () => {
    const r = checkDelta(0, 5);
    expect(r.pctDelta).toBeNull();
    expect(r.exceeded).toBe(false); // 백분율만으로는 판정 불가
    expect(checkDelta(0, 5, { absLimit: 3 }).exceeded).toBe(true);
  });

  it('백분율은 소수 1자리로 반올림(표시·비교 일관성)', () => {
    expect(checkDelta(3, 4).pctDelta).toBe(33.3);
  });
});

describe('holdReasonFor — 보류 사유 판정(우선순위 있는 단일 사유)', () => {
  const base = { numeric: true, critical: false, deltaExceeded: false };

  it('사유가 없으면 null(자동확정 가능)', () => {
    expect(holdReasonFor({ ...base })).toBeNull();
  });

  it('비수치 결과가 최우선 — 판정 자체가 불가하므로', () => {
    expect(holdReasonFor({ ...base, numeric: false, critical: true })).toBe('NONNUMERIC');
  });

  it('위험치는 델타·QC·장비보다 우선', () => {
    expect(holdReasonFor({ ...base, critical: true, deltaExceeded: true, qcOk: false })).toBe('CRITICAL');
  });

  it('델타 > QC > 장비 순서', () => {
    expect(holdReasonFor({ ...base, deltaExceeded: true, qcOk: false })).toBe('DELTA');
    expect(holdReasonFor({ ...base, qcOk: false, instrumentError: true })).toBe('QC');
    expect(holdReasonFor({ ...base, instrumentError: true })).toBe('INSTRUMENT');
  });

  it('qcOk 미지정(undefined)은 QC 보류가 아니다 — false일 때만 차단', () => {
    expect(holdReasonFor({ ...base, qcOk: undefined })).toBeNull();
    expect(holdReasonFor({ ...base, qcOk: true })).toBeNull();
  });
});

describe('holdPriority — 워크리스트 정렬(작을수록 상단)', () => {
  it('위험치가 항상 최상단', () => {
    expect(holdPriority('CRITICAL')).toBe(0);
  });

  it('정렬 순서: CRITICAL < INSTRUMENT < QC < DELTA < NONNUMERIC < 그 외', () => {
    const order = ['CRITICAL', 'INSTRUMENT', 'QC', 'DELTA', 'NONNUMERIC'] as const;
    const nums = order.map((r) => holdPriority(r));
    expect(nums).toEqual([...nums].sort((a, b) => a - b)); // 단조 증가
    expect(holdPriority(null)).toBeGreaterThan(holdPriority('NONNUMERIC'));
  });

  it('사유 없음(null)은 최하단 — 보류가 아니므로', () => {
    expect(holdPriority(null)).toBe(5);
  });
});

describe('validateReferenceRange — 참고치가 틀리면 모든 결과 판정이 틀린다', () => {
  it('정상 참고치는 통과', () => {
    expect(validateReferenceRange({ low: 3.5, high: 5.1, panicLow: 2.5, panicHigh: 6.5 })).toEqual([]);
    expect(validateReferenceRange({ low: 0, high: 40 })).toEqual([]);
    expect(validateReferenceRange({})).toEqual([]); // 미설정은 허용(참고치 없는 검사)
  });

  it('정상범위 역전(low > high) 차단 — 실측에서 100~10이 저장됐다', () => {
    expect(validateReferenceRange({ low: 100, high: 10 })[0]).toContain('하한');
  });

  it('위험치 역전 차단 — 거의 모든 값이 LL이 되어 통보가 폭주한다', () => {
    const e = validateReferenceRange({ low: 3, high: 5, panicLow: 99, panicHigh: 1 });
    expect(e.some((x) => x.includes('모든 값이 위험치'))).toBe(true);
  });

  it('위험 상한이 정상 상한 이하 → 정상값이 위험치로 통보되는 것을 차단', () => {
    const e = validateReferenceRange({ low: 3, high: 5, panicHigh: 4 });
    expect(e[0]).toContain('정상 범위 값이 위험치로');
    // determineFlag로 실제 오판정 재현: 정상 범위 안의 4.5가 HH가 된다
    expect(determineFlag(4.5, { sex: 'A', ageMin: 0, ageMax: 200, low: 3, high: 5, panicLow: null, panicHigh: 4 })).toBe('HH');
  });

  it('위험 하한이 정상 하한 이상 → 동상(하한 쪽)', () => {
    expect(validateReferenceRange({ low: 3, high: 5, panicLow: 3.5 })[0]).toContain('정상 범위 값이 위험치로');
  });
});

describe('참고치 연령대 정합성', () => {
  it('연령 하한이 상한보다 크면 어떤 환자에게도 매칭되지 않는다', () => {
    // pickReferenceRange는 age >= ageMin && age <= ageMax를 만족해야 고른다 —
    // 역전된 구간은 영원히 선택되지 않아 그 검사의 모든 결과가 참고치 없음으로 보류된다.
    const errs = validateReferenceRange({ low: 3, high: 5, ageMin: 80, ageMax: 10 });
    expect(errs.some((e) => e.includes('어떤 환자에게도'))).toBe(true);
    expect(pickReferenceRange([{ sex: 'A', ageMin: 80, ageMax: 10, low: 3, high: 5, panicLow: null, panicHigh: null }], 'M', 50)).toBeNull();
  });

  it('정상 연령대는 통과', () => {
    expect(validateReferenceRange({ low: 3, high: 5, ageMin: 0, ageMax: 18 })).toEqual([]);
  });
});
