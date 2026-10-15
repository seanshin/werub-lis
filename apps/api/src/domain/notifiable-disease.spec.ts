/**
 * classifyNotifiable — 단위 테스트 13건.
 *
 * 묶음: normalizeNotifiableGrade — 등급 변형을 정본으로 수렴(폐루프 게이트 방어).
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { classifyNotifiable, classifyNotifiableFrom, normalizeNotifiableGrade } from './notifiable-disease';

describe('classifyNotifiable', () => {
  it('VRSA(mdro 코드) → 제2급 신고', () => {
    const r = classifyNotifiable('Staphylococcus aureus', 'VRSA');
    expect(r.reportable).toBe(true);
    expect(r.grade).toBe('제2급');
  });
  it('CRAB/CRPA(mdro 코드) → 표본감시 신고(라벨 아닌 정본 코드로 매칭)', () => {
    expect(classifyNotifiable('Acinetobacter baumannii', 'CRAB').reportable).toBe(true);
    expect(classifyNotifiable('Pseudomonas aeruginosa', 'CRPA').reportable).toBe(true);
  });
  it('분자 PCR 표기 MTB/RIF도 결핵으로 신고(예전엔 \\btb\\b 미매칭으로 누락)', () => {
    expect(classifyNotifiable('MTB/RIF', null).reportable).toBe(true);
    expect(classifyNotifiable('MTB', null).disease).toBe('결핵');
  });
  it('분자 바이러스·STI PCR 양성 → 법정신고(배양 목록이 놓치던 고빈도 타깃)', () => {
    expect(classifyNotifiable('SARS-CoV-2', null).reportable).toBe(true);
    expect(classifyNotifiable('Influenza A', null).reportable).toBe(true);
    expect(classifyNotifiable('HIV-1', null).disease).toContain('HIV');
    expect(classifyNotifiable('Hepatitis B virus', null).reportable).toBe(true);
    expect(classifyNotifiable('N. gonorrhoeae', null).reportable).toBe(true);
    expect(classifyNotifiable('T. pallidum', null).disease).toBe('매독');
  });
  it('결핵균 → 신고대상 결핵(제2급)', () => {
    const r = classifyNotifiable('Mycobacterium tuberculosis', null);
    expect(r.reportable).toBe(true);
    expect(r.disease).toBe('결핵');
    expect(r.grade).toBe('제2급');
  });
  it('CRE MDRO → 의료관련감염 표본감시', () => {
    const r = classifyNotifiable('Klebsiella pneumoniae', 'CRE');
    expect(r.reportable).toBe(true);
    expect(r.disease).toContain('CRE');
  });
  it('VRSA → 제2급', () => {
    const r = classifyNotifiable('Staphylococcus aureus', 'VRSA');
    expect(r.reportable).toBe(true);
    expect(r.grade).toBe('제2급');
  });
  it('장티푸스균 → 제2급, 파라티푸스와 구분', () => {
    expect(classifyNotifiable('Salmonella Typhi', null).disease).toBe('장티푸스');
    expect(classifyNotifiable('Salmonella Paratyphi A', null).disease).toBe('파라티푸스');
  });
  it('일반 대장균(내성 없음) → 비신고', () => {
    expect(classifyNotifiable('Escherichia coli', null).reportable).toBe(false);
  });
});

describe('normalizeNotifiableGrade — 등급 변형을 정본으로 수렴(폐루프 게이트 방어)', () => {
  it('정본은 그대로', () => {
    expect(normalizeNotifiableGrade('제2급')).toBe('제2급');
    expect(normalizeNotifiableGrade('의료관련감염 표본감시')).toBe('의료관련감염 표본감시');
  });
  it('변형(급수 축약·전각·영문·숫자)도 정본으로', () => {
    expect(normalizeNotifiableGrade('2급')).toBe('제2급');
    expect(normalizeNotifiableGrade('제２급')).toBe('제2급'); // 전각 숫자
    expect(normalizeNotifiableGrade('Class 2')).toBe('제2급');
    expect(normalizeNotifiableGrade('grade 1')).toBe('제1급');
    expect(normalizeNotifiableGrade('2')).toBe('제2급');
    expect(normalizeNotifiableGrade('표본감시')).toBe('의료관련감염 표본감시');
  });
  it('매핑 불가/빈값 → null', () => {
    expect(normalizeNotifiableGrade('urgent')).toBeNull();
    expect(normalizeNotifiableGrade('')).toBeNull();
    expect(normalizeNotifiableGrade(null)).toBeNull();
  });
  it('카탈로그 판정(classifyNotifiableFrom)이 변형 등급을 정본으로 반환 → 폐루프 게이트가 새지 않는다', () => {
    const rules = [{ type: 'ORGANISM', match: 'tuberculosis', disease: '결핵', grade: '2급' }];
    const r = classifyNotifiableFrom('Mycobacterium tuberculosis', null, rules);
    expect(r.grade).toBe('제2급'); // '2급' 변형이 들어와도 게이트가 인식하는 정본
  });
});
