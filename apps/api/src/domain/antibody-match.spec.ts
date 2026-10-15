/**
 * 항원음성 유닛 매칭 — 단위 테스트 6건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { antigenCompatible, requiredAntigenNeg, parseAntigenNeg } from './antibody-match';

describe('항원음성 유닛 매칭', () => {
  it('anti-K 환자 + K-neg 유닛 → 적합', () => {
    const r = antigenCompatible('anti-K', 'K-neg');
    expect(r.compatible).toBe(true);
    expect(r.requiredNeg).toEqual(['K']);
  });
  it('anti-K 환자 + 항원음성 미확인 유닛 → 부적합', () => {
    const r = antigenCompatible('anti-K', null);
    expect(r.compatible).toBe(false);
    expect(r.missing).toEqual(['K']);
  });
  it('다중 항체(anti-K, anti-E) + K,E-neg 유닛 → 적합', () => {
    expect(antigenCompatible('anti-K, anti-E', 'K-neg, E-neg').compatible).toBe(true);
  });
  it('다중 항체 중 일부만 음성 → 부적합(missing 반영)', () => {
    const r = antigenCompatible('anti-K, anti-Fya', 'K-neg');
    expect(r.compatible).toBe(false);
    expect(r.missing).toEqual(['FYA']);
  });
  it('항체 없음 → 항원 제약 없음(적합)', () => {
    expect(antigenCompatible(null, null).compatible).toBe(true);
    expect(antigenCompatible('음성', 'K-neg').compatible).toBe(true);
  });
  it('파싱: anti- 접두 제거·대문자 / 항원음성 정규화', () => {
    expect(requiredAntigenNeg('anti-Jka; anti-c')).toEqual(['JKA', 'C']);
    expect([...parseAntigenNeg('K neg, E-negative, Jka')].sort()).toEqual(['E', 'JKA', 'K']);
  });
});
