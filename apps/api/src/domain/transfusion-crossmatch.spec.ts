/**
 * determineCrossmatch — 혈청학적 교차적합 판정 — 단위 테스트 17건.
 *
 * 묶음: parseBloodGroup — 혈액형 문자열 파싱, ABO/RhD 입력 검증(방벽 입력 오염 차단).
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { determineCrossmatch, parseBloodGroup, validateTypingValues } from './transfusion-safety';

describe('determineCrossmatch — 혈청학적 교차적합 판정', () => {
  const base = { recipientAbo: 'A', recipientRhD: 'POS', antibodyScreen: 'NEG', unitAbo: 'A', unitRhD: 'POS' } as const;

  it('ABO·RhD 적합 + 항체음성 → 적합(전자교차)', () => {
    const r = determineCrossmatch(base);
    expect(r.result).toBe('적합');
    expect(r.compatible).toBe(true);
    expect(r.requiresAhg).toBe(false);
  });

  it('ABO 부적합(A 환자에 B 적혈구) → 부적합', () => {
    const r = determineCrossmatch({ ...base, unitAbo: 'B' });
    expect(r.result).toBe('부적합');
    expect(r.compatible).toBe(false);
    expect(r.reasons.some((x) => x.includes('ABO'))).toBe(true);
  });

  it('O 수혜자는 O만 적합(A 적혈구 → 부적합)', () => {
    expect(determineCrossmatch({ ...base, recipientAbo: 'O', unitAbo: 'A' }).result).toBe('부적합');
    expect(determineCrossmatch({ ...base, recipientAbo: 'O', unitAbo: 'O' }).result).toBe('적합');
  });

  it('AB 수혜자는 모든 ABO 적혈구 적합(만능 수혜자)', () => {
    for (const u of ['A', 'B', 'O', 'AB'] as const) {
      expect(determineCrossmatch({ ...base, recipientAbo: 'AB', unitAbo: u }).result).toBe('적합');
    }
  });

  it('RhD 음성 환자에 RhD 양성 적혈구 → 부적합', () => {
    const r = determineCrossmatch({ ...base, recipientRhD: 'NEG', unitRhD: 'POS' });
    expect(r.result).toBe('부적합');
    expect(r.reasons.some((x) => x.includes('RhD'))).toBe(true);
  });

  it('RhD 음성 환자에 RhD 음성 적혈구 → 적합', () => {
    expect(determineCrossmatch({ ...base, recipientRhD: 'NEG', unitRhD: 'NEG' }).result).toBe('적합');
  });

  it('비예기항체 양성 + ABO/RhD 적합 → 추가검사필요(AHG, 자동 적합 금지)', () => {
    const r = determineCrossmatch({ ...base, antibodyScreen: 'POS' });
    expect(r.result).toBe('추가검사필요');
    expect(r.compatible).toBe(false);
    expect(r.requiresAhg).toBe(true);
  });

  it('비예기항체 양성 + ABO 부적합 → 부적합(우선)', () => {
    const r = determineCrossmatch({ ...base, antibodyScreen: 'POS', unitAbo: 'B' });
    expect(r.result).toBe('부적합');
  });

  it('혈장(FFP)은 ABO 역방향 — A 수혜자에 O 혈장은 부적합, AB 혈장은 적합', () => {
    expect(determineCrossmatch({ ...base, productType: 'FFP', unitAbo: 'O' }).result).toBe('부적합');
    expect(determineCrossmatch({ ...base, productType: 'FFP', unitAbo: 'AB' }).result).toBe('적합');
  });

  it('혈장(FFP)은 RhD 미적용 — 음성 환자에 양성도 적합', () => {
    expect(determineCrossmatch({ ...base, productType: '신선동결혈장', recipientRhD: 'NEG', unitRhD: 'POS' }).result).toBe('적합');
  });

  it('C1 전혈(Whole Blood)은 ABO 동일형만 — A 환자에 O 전혈은 부적합', () => {
    // RBC 매트릭스라면 A←O 허용되지만, 전혈은 혈장 포함이라 동일형만 적합
    expect(determineCrossmatch({ ...base, productType: 'WHOLE BLOOD', unitAbo: 'O' }).result).toBe('부적합');
    expect(determineCrossmatch({ ...base, productType: '전혈', unitAbo: 'A' }).result).toBe('적합');
  });

  it('C2 항체선별이 명시적 NEG가 아니면 fail-safe(항체 있음 취급) — 전자교차 금지', () => {
    for (const ab of ['POS', '양성', 'POSITIVE', '', 'unknown']) {
      const r = determineCrossmatch({ ...base, antibodyScreen: ab });
      expect(r.requiresAhg).toBe(true);
      expect(r.result).not.toBe('적합'); // ABO/RhD 맞아도 자동 적합 금지
    }
    // 오직 정확한 'NEG'만 전자교차 적합
    expect(determineCrossmatch({ ...base, antibodyScreen: 'NEG' }).result).toBe('적합');
  });
});

describe('parseBloodGroup — 혈액형 문자열 파싱', () => {
  it('A+/O-/AB+ 파싱', () => {
    expect(parseBloodGroup('A+')).toEqual({ abo: 'A', rhD: 'POS' });
    expect(parseBloodGroup('O-')).toEqual({ abo: 'O', rhD: 'NEG' });
    expect(parseBloodGroup('AB+')).toEqual({ abo: 'AB', rhD: 'POS' });
    expect(parseBloodGroup('B NEG')).toEqual({ abo: 'B', rhD: 'NEG' });
  });
  it('불명/빈값 → null', () => {
    expect(parseBloodGroup(null)).toBeNull();
    expect(parseBloodGroup('')).toBeNull();
    expect(parseBloodGroup('XYZ')).toBeNull();
  });
});

describe('ABO/RhD 입력 검증(방벽 입력 오염 차단)', () => {
  // issueBlood의 ABO 독립방벽은 BloodTyping 최신 레코드를 입력으로 쓴다.
  // 그 테이블에 쓰는 모든 경로가 이 검증을 통과해야 하며, 열거 밖 값이 들어가면
  // 방벽이 오염된 혈액형으로 통과할 수 있다(회귀 금지).
  it('정상 조합은 통과', () => {
    expect(validateTypingValues('O', 'NEG')).toBeNull();
    expect(validateTypingValues('AB', 'POS')).toBeNull();
  });
  it('열거 밖 ABO는 거부', () => {
    expect(validateTypingValues('XX', 'POS')).toContain('ABO');
    expect(validateTypingValues('a', 'POS')).toContain('ABO'); // 소문자도 거부(정규화 의존 금지)
    expect(validateTypingValues('', 'POS')).toContain('ABO');
    expect(validateTypingValues(undefined, 'POS')).toContain('ABO');
    expect(validateTypingValues({ toString: () => 'A' }, 'POS')).toContain('ABO'); // 객체 우회 차단
  });
  it('열거 밖 RhD는 거부', () => {
    expect(validateTypingValues('O', 'MAYBE')).toContain('RhD');
    expect(validateTypingValues('O', '+')).toContain('RhD');
  });
});
