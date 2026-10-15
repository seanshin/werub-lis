/**
 * computeDerived (계산검사 엔진) — 단위 테스트 10건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { computeDerived, DERIVED_TESTS } from './derived-tests';

describe('computeDerived (계산검사 엔진)', () => {
  it('eGFR — CKD-EPI 2021(남 60세 Scr 1.0)', () => {
    const r = computeDerived({ 'CHE-CREA': 1.0 }, { age: 60, sex: 'M' });
    const egfr = r.find((x) => x.testCode === 'CHE-EGFR');
    expect(egfr).toBeTruthy();
    expect(egfr!.value).toBeGreaterThan(80); // 정상 신기능 근사
    expect(egfr!.value).toBeLessThan(100);
  });
  it('eGFR — 나이/성별 없으면 계산 안 함', () => {
    expect(computeDerived({ 'CHE-CREA': 1.0 }, { age: null, sex: 'M' }).some((x) => x.testCode === 'CHE-EGFR')).toBe(false);
  });
  it('eGFR — 소아(18세 미만)는 CKD-EPI 미적용(산출 안 함)', () => {
    expect(computeDerived({ 'CHE-CREA': 0.4 }, { age: 5, sex: 'F' }).some((x) => x.testCode === 'CHE-EGFR')).toBe(false);
    expect(computeDerived({ 'CHE-CREA': 1.0 }, { age: 18, sex: 'M' }).some((x) => x.testCode === 'CHE-EGFR')).toBe(true);
  });
  it('LDL — 음수(고HDL/저TC)면 미산출', () => {
    expect(computeDerived({ 'CHE-CHOL': 60, 'CHE-HDL': 80, 'CHE-TG': 50 }, { age: 50, sex: 'M' }).some((x) => x.testCode === 'CHE-LDLC')).toBe(false);
  });
  it('LDL(Friedewald) = TC - HDL - TG/5', () => {
    const r = computeDerived({ 'CHE-CHOL': 200, 'CHE-HDL': 50, 'CHE-TG': 100 }, { age: 50, sex: 'M' });
    expect(r.find((x) => x.testCode === 'CHE-LDLC')!.value).toBe(130); // 200-50-20
  });
  it('LDL — TG≥400이면 계산 안 함', () => {
    expect(computeDerived({ 'CHE-CHOL': 200, 'CHE-HDL': 50, 'CHE-TG': 450 }, { age: 50, sex: 'M' }).some((x) => x.testCode === 'CHE-LDLC')).toBe(false);
  });
  it('Anion Gap = (Na+K)-(Cl+CO2)', () => {
    const r = computeDerived({ 'CHE-NA': 140, 'CHE-K': 4, 'CHE-CL': 104, 'CHE-CO2': 24 }, { age: 50, sex: 'M' });
    expect(r.find((x) => x.testCode === 'CHE-AGAP')!.value).toBe(16); // 144-128
  });
  it('보정 칼슘 = Ca + 0.8*(4-Alb)', () => {
    const r = computeDerived({ 'CHE-CA': 8.0, 'CHE-ALB': 3.0 }, { age: 50, sex: 'M' });
    expect(r.find((x) => x.testCode === 'CHE-CACORR')!.value).toBe(8.8); // 8.0 + 0.8
  });
  it('입력 부족 → 해당 파생검사 제외', () => {
    expect(computeDerived({ 'CHE-CHOL': 200 }, { age: 50, sex: 'M' }).some((x) => x.testCode === 'CHE-LDLC')).toBe(false);
  });
  it('정의 4종', () => { expect(DERIVED_TESTS).toHaveLength(4); });
});
