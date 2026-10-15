/**
 * computeSdi — 단위 테스트 3건.
 *
 * 묶음: eqaVerdict.
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { computeSdi, eqaVerdict } from './eqa';

describe('computeSdi', () => {
  it('(값-평균)/SD', () => {
    expect(computeSdi(105, 100, 2.5)).toBe(2);
    expect(computeSdi(97, 100, 2)).toBe(-1.5);
  });
  it('SD 0 → 0', () => expect(computeSdi(105, 100, 0)).toBe(0));
});

describe('eqaVerdict', () => {
  it('|SDI| 경계', () => {
    expect(eqaVerdict(2)).toBe('ACCEPT');
    expect(eqaVerdict(-2)).toBe('ACCEPT');
    expect(eqaVerdict(2.5)).toBe('WARNING');
    expect(eqaVerdict(3)).toBe('WARNING');
    expect(eqaVerdict(3.5)).toBe('UNACCEPTABLE');
  });
});
