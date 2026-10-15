/**
 * selectiveAstReport — cascade 억제 — 단위 테스트 7건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { selectiveAstReport } from './ast-selective-report';

/**
 * 선택적 AST 보고는 **어떤 감수성 결과를 임상의에게 숨길지** 결정한다.
 * 억제가 과하면 필요한 약제 선택지가 사라지고, 억제가 안 되면 스튜어드십이 무너진다.
 * 근거: docs/재검토_2026-07-21_발견목록.md Q5
 */
describe('selectiveAstReport — cascade 억제', () => {
  it('1차약 감수성이 없으면 아무것도 억제하지 않는다', () => {
    const r = selectiveAstReport([
      { antibiotic: 'Ampicillin', interpretation: 'R' },
      { antibiotic: 'Meropenem', interpretation: 'S' },
    ]);
    expect(r.firstLineSusceptible).toBe(false);
    expect(r.items.every((i) => i.report)).toBe(true);
  });

  it('1차약이 S면 감수성인 reserve 약제를 억제한다', () => {
    const r = selectiveAstReport([
      { antibiotic: 'Cefazolin', interpretation: 'S' },
      { antibiotic: 'Meropenem', interpretation: 'S' },
    ]);
    expect(r.firstLineSusceptible).toBe(true);
    expect(r.items.find((i) => i.antibiotic === 'Meropenem')?.report).toBe(false);
    expect(r.items.find((i) => i.antibiotic === 'Cefazolin')?.report).toBe(true);
  });

  it('★내성·중간(R/I)인 reserve 약제는 1차약이 S여도 반드시 보고한다', () => {
    // 임상적으로 "이 약도 안 듣는다"는 정보는 숨기면 안 된다.
    const r = selectiveAstReport([
      { antibiotic: 'Cefazolin', interpretation: 'S' },
      { antibiotic: 'Meropenem', interpretation: 'R' },
      { antibiotic: 'Vancomycin', interpretation: 'I' },
    ]);
    expect(r.items.find((i) => i.antibiotic === 'Meropenem')?.report).toBe(true);
    expect(r.items.find((i) => i.antibiotic === 'Vancomycin')?.report).toBe(true);
  });

  it('규칙에 없는 약제는 항상 보고(억제는 명시된 것만)', () => {
    const r = selectiveAstReport([
      { antibiotic: 'Cefazolin', interpretation: 'S' },
      { antibiotic: '미등록약제', interpretation: 'S' },
    ]);
    expect(r.items.find((i) => i.antibiotic === '미등록약제')?.report).toBe(true);
  });

  it('억제된 항목에는 사유가 남는다(왜 안 보이는지 추적 가능해야 함)', () => {
    const r = selectiveAstReport([
      { antibiotic: 'Ciprofloxacin', interpretation: 'S' },
      { antibiotic: 'Colistin', interpretation: 'S' },
    ]);
    const sup = r.items.find((i) => i.antibiotic === 'Colistin');
    expect(sup?.report).toBe(false);
    expect(sup?.suppressReason).toContain('1차약');
  });

  it('interpretation이 null이면 억제하지 않는다(판정 전)', () => {
    const r = selectiveAstReport([
      { antibiotic: 'Cefazolin', interpretation: 'S' },
      { antibiotic: 'Meropenem', interpretation: null },
    ]);
    expect(r.items.find((i) => i.antibiotic === 'Meropenem')?.report).toBe(true);
  });

  it('빈 목록도 안전하게 처리', () => {
    const r = selectiveAstReport([]);
    expect(r.items).toEqual([]);
    expect(r.firstLineSusceptible).toBe(false);
  });
});
