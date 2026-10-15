/**
 * 열거 정본 — 값 고정 — 단위 테스트 7건.
 *
 * 묶음: isOneOf, 게이트 전이 상태 — PENDING은 전이 대상이 아니다, 교차시험 판정값 — 자동 판정이 쓰는 값을 수기로도 기록할 수 있어야 한다, 확정 판정 정본 — 결과가 차트·HIS·청구로 나가는 기준.
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import {
  USE_STATUSES, STAIN_ORDER_TYPES, WORK_ORDER_STATUSES,
  CONCORDANCE_VALUES, QC_REVIEW_VERDICTS, AUTO_SUBMIT_MODES, isOneOf,
} from './enums';
import { GATE_TRANSITION_STATUSES, GATE_STATUSES, isTransitionableGateStatus } from './signoff-review';
import { CROSSMATCH_RESULTS } from './transfusion-safety';
import { FINALIZED_VERIFY_STATES, isFinalized } from './result-evaluation';

/**
 * 열거값 정본화 회귀 가드.
 *
 * DTO의 `@IsIn`과 서비스 검증 배열이 각자 리터럴을 들고 있어 **11건이 어긋난 채 발견된 적이 있다**
 * (2026-07-21). 여기 상수를 참조하도록 정리했으므로, 값을 바꾸면 이 테스트가 먼저 깨져야 한다.
 * 근거: docs/재검토_2026-07-21_발견목록.md Q1·Q2
 */
describe('열거 정본 — 값 고정', () => {
  it.each([
    ['USE_STATUSES', USE_STATUSES, ['USE', 'STOP']],
    ['STAIN_ORDER_TYPES', STAIN_ORDER_TYPES, ['IHC', 'SPECIAL', 'RECUT', 'DEEPER']],
    ['WORK_ORDER_STATUSES', WORK_ORDER_STATUSES, ['REQUESTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED']],
    ['CONCORDANCE_VALUES', CONCORDANCE_VALUES, ['CONCORDANT', 'DISCORDANT']],
    ['QC_REVIEW_VERDICTS', QC_REVIEW_VERDICTS, ['승인', '보류']],
    ['AUTO_SUBMIT_MODES', AUTO_SUBMIT_MODES, ['ENTER', 'LENGTH', 'IDLE']],
  ])('%s', (_n, actual, expected) => {
    expect([...actual]).toEqual(expected);
  });
});

describe('isOneOf', () => {
  it('포함 여부를 판정하고 타입을 좁힌다', () => {
    expect(isOneOf(USE_STATUSES, 'USE')).toBe(true);
    expect(isOneOf(USE_STATUSES, 'ACTIVE')).toBe(false); // 과거 DTO가 쓰던 잘못된 값
  });
  it('문자열이 아니면 false', () => {
    expect(isOneOf(USE_STATUSES, null)).toBe(false);
    expect(isOneOf(USE_STATUSES, 1)).toBe(false);
  });
});

describe('게이트 전이 상태 — PENDING은 전이 대상이 아니다', () => {
  it('전이 가능 목록에 PENDING이 없다', () => {
    expect(GATE_TRANSITION_STATUSES).not.toContain('PENDING');
    expect(GATE_STATUSES).toContain('PENDING'); // 전체 목록에는 있다(초기값)
  });
  it('DTO가 허용하던 4값과 정확히 일치한다(정본화 후에도 동작 동일)', () => {
    expect([...GATE_TRANSITION_STATUSES]).toEqual(['SUBMITTED', 'IN_PROGRESS', 'APPROVED', 'REJECTED']);
  });
  it('isTransitionableGateStatus가 PENDING을 거부한다', () => {
    expect(isTransitionableGateStatus('APPROVED')).toBe(true);
    expect(isTransitionableGateStatus('PENDING')).toBe(false);
    expect(isTransitionableGateStatus('없는값')).toBe(false);
  });
});

describe('교차시험 판정값 — 자동 판정이 쓰는 값을 수기로도 기록할 수 있어야 한다', () => {
  it("'추가검사필요'가 포함된다(항체양성 → AHG 교차 필요)", () => {
    // DTO가 2값만 허용해 이 상태를 수기로 기록할 수 없던 결함의 회귀 가드
    expect(CROSSMATCH_RESULTS).toContain('추가검사필요');
    expect([...CROSSMATCH_RESULTS]).toEqual(['적합', '부적합', '추가검사필요']);
  });
});

describe('확정 판정 정본 — 결과가 차트·HIS·청구로 나가는 기준', () => {
  it('AUTO·VERIFIED만 확정', () => {
    expect([...FINALIZED_VERIFY_STATES]).toEqual(['AUTO', 'VERIFIED']);
    expect(isFinalized('AUTO')).toBe(true);
    expect(isFinalized('VERIFIED')).toBe(true);
  });
  it('PENDING·빈값·null은 확정이 아니다', () => {
    expect(isFinalized('PENDING')).toBe(false);
    expect(isFinalized('')).toBe(false);
    expect(isFinalized(null)).toBe(false);
    expect(isFinalized(undefined)).toBe(false);
  });
});
