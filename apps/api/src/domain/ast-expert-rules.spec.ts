/**
 * validateAst (expert-rule 검증) — 단위 테스트 12건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { validateAst } from './ast-expert-rules';

const S = (a: string) => ({ antibiotic: a, interpretation: 'S' });
const R = (a: string) => ({ antibiotic: a, interpretation: 'R' });

describe('validateAst (expert-rule 검증)', () => {
  it('Klebsiella + Ampicillin S → 고유내성 경고', () => {
    const w = validateAst('Klebsiella pneumoniae', [S('Ampicillin')]);
    expect(w.length).toBe(1);
    expect(w[0].rule).toBe('고유내성');
  });
  it('Klebsiella + Ampicillin R → 경고 없음(정상)', () => {
    expect(validateAst('Klebsiella pneumoniae', [R('Ampicillin')])).toHaveLength(0);
  });
  it('Enterococcus + Cephalosporin S → 고유내성 경고', () => {
    const w = validateAst('Enterococcus faecalis', [S('Ceftriaxone')]);
    expect(w[0].rule).toBe('고유내성');
  });
  it('MRSA + Meropenem S → MRSA 표현형 경고', () => {
    const w = validateAst('Staphylococcus aureus', [R('Cefoxitin'), S('Meropenem')]);
    expect(w.some((x) => x.rule === 'MRSA 표현형')).toBe(true);
  });
  it('MSSA(Oxacillin S) + β-lactam S → 경고 없음', () => {
    expect(validateAst('Staphylococcus aureus', [S('Oxacillin'), S('Cefazolin')])).toHaveLength(0);
  });
  it('Acinetobacter + Ertapenem S → 고유내성 경고', () => {
    expect(validateAst('Acinetobacter baumannii', [S('Ertapenem')]).some((w) => w.rule === '고유내성')).toBe(true);
  });
  it('Listeria + Ceftriaxone S → 고유내성 경고(모든 세팔로스포린)', () => {
    expect(validateAst('Listeria monocytogenes', [S('Ceftriaxone')]).some((w) => w.rule === '고유내성')).toBe(true);
  });
  it('VRSA — S.aureus + Vancomycin R → 중대 경고', () => {
    expect(validateAst('Staphylococcus aureus', [R('Vancomycin')]).some((w) => w.rule === 'VRSA(중대)')).toBe(true);
  });
  it('ESBL 불일치 — 3세대 Cef R인데 Ampicillin S', () => {
    expect(validateAst('Escherichia coli', [R('Ceftriaxone'), S('Ampicillin')]).some((w) => w.rule === 'ESBL 표현형')).toBe(true);
  });
  it('CRE 이례적 — Carbapenem R인데 3세대 Cef S', () => {
    expect(validateAst('Klebsiella pneumoniae', [R('Meropenem'), S('Ceftriaxone')]).some((w) => w.rule === 'CRE 이례적')).toBe(true);
  });
  it('Penicillin-S S.aureus → 확인 경고', () => {
    expect(validateAst('Staphylococcus aureus', [S('Penicillin')]).some((w) => w.rule === 'Penicillin-S 확인')).toBe(true);
  });
  it('정상 표현형(E.coli, 고유내성 없음) → 경고 없음', () => {
    expect(validateAst('Escherichia coli', [S('Meropenem'), R('Ceftriaxone')])).toHaveLength(0);
  });
});
