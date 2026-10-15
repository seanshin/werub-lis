/**
 * interpretMic — 단위 테스트 8건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { interpretMic, organismGroup } from './ast-breakpoints';

describe('interpretMic', () => {
  it('E. coli + ceftriaxone MIC 0.5 → S (≤1)', () => {
    const r = interpretMic('Escherichia coli', 'Ceftriaxone', '0.5');
    expect(r.interpretation).toBe('S');
    expect(r.standard).toContain('CLSI');
  });
  it('E. coli + ceftriaxone MIC 8 → R (≥4)', () => {
    expect(interpretMic('Escherichia coli', 'Ceftriaxone', '8').interpretation).toBe('R');
  });
  it('중간값 → I', () => {
    expect(interpretMic('Escherichia coli', 'Ceftriaxone', '2').interpretation).toBe('I');
  });
  it('부등호 ≤ 처리 — S. aureus vancomycin ≤1 → S', () => {
    expect(interpretMic('Staphylococcus aureus', 'Vancomycin', '≤1').interpretation).toBe('S');
  });
  it('브레이크포인트 미정의 → null(수기 유지)', () => {
    expect(interpretMic('Escherichia coli', 'ObscureDrug', '1').interpretation).toBeNull();
  });
  it('균군 매핑', () => {
    expect(organismGroup('Klebsiella pneumoniae')).toBe('Enterobacterales');
    expect(organismGroup('Pseudomonas aeruginosa')).toBe('Pseudomonas aeruginosa');
  });
  it('축약 속명 "K. pneumoniae"도 Enterobacterales로 매핑(확장)', () => {
    expect(organismGroup('K. pneumoniae')).toBe('Enterobacterales');
    expect(organismGroup('E. cloacae')).toBe('Enterobacterales');
  });
  it('부등호 MIC가 확정 구간 밖이면 자동판정 보류(정확값처럼 오판 금지)', () => {
    // ceftriaxone Enterobacterales s=1,r=4: ">0.5"는 S로 확정 불가(실제 MIC>0.5)
    expect(interpretMic('Klebsiella pneumoniae', 'ceftriaxone', '>0.5').interpretation).toBeNull();
    // "<4"는 R로 확정 불가(실제 MIC<4)
    expect(interpretMic('Klebsiella pneumoniae', 'ceftriaxone', '<4').interpretation).toBeNull();
    // 확정 구간은 그대로: "<=1"→S, ">=4"→R
    expect(interpretMic('Klebsiella pneumoniae', 'ceftriaxone', '<=1').interpretation).toBe('S');
    expect(interpretMic('Klebsiella pneumoniae', 'ceftriaxone', '>=4').interpretation).toBe('R');
  });
});
