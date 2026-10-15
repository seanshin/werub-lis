/**
 * code128 — 라벨 실물 바코드(P1-19) — 단위 테스트 8건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { code128Widths, code128TotalModules, _CODE128_PATTERNS } from '@lis/shared';

describe('code128 — 라벨 실물 바코드(P1-19)', () => {
  it('패턴 테이블 불변식 — 데이터 심볼 106개는 6요소 11모듈, STOP은 7요소 13모듈', () => {
    expect(_CODE128_PATTERNS).toHaveLength(107);
    for (let i = 0; i < 106; i++) {
      const p = _CODE128_PATTERNS[i];
      expect(p, `code ${i}`).toHaveLength(6);
      expect(p.split('').reduce((s, c) => s + Number(c), 0), `code ${i} 모듈합`).toBe(11);
    }
    const stop = _CODE128_PATTERNS[106];
    expect(stop).toHaveLength(7);
    expect(stop.split('').reduce((s, c) => s + Number(c), 0)).toBe(13);
  });

  it('구조 — START B(211214)로 시작, STOP(2331112)으로 끝, 심볼 수 = 문자수+3', () => {
    const w = code128Widths('S2607220001');
    expect(w.slice(0, 6)).toEqual([2, 1, 1, 2, 1, 4]); // START B(code 104)
    expect(w.slice(-7)).toEqual([2, 3, 3, 1, 1, 1, 2]); // STOP
    // (문자 11 + START + 체크섬) × 6요소 + STOP 7요소
    expect(w).toHaveLength((11 + 2) * 6 + 7);
  });

  it('체크섬 — 스펙 공식(START값 + Σ 값×위치) mod 103. "A" → (104 + 33×1) % 103 = 34', () => {
    const w = code128Widths('A');
    // 심볼열: START(104)·'A'(33)·체크섬(34)·STOP — 세 번째 심볼이 code 34 패턴
    const third = w.slice(12, 18).join('');
    expect(third).toBe(_CODE128_PATTERNS[34].split('').join(''));
  });

  it('총 모듈 수 = 11×(심볼수-1) + 13', () => {
    const w = code128Widths('SP-2026-0001');
    expect(code128TotalModules(w)).toBe(11 * (12 + 2) + 13);
  });

  it('빈 문자열·비ASCII는 오류', () => {
    expect(() => code128Widths('')).toThrow();
    expect(() => code128Widths('한글')).toThrow();
  });
});
