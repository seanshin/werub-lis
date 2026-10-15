/**
 * classifyMdro (MDRO 분류·격리) — 단위 테스트 20건.
 *
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { classifyMdro } from './mdro';

const R = (antibiotic: string) => ({ antibiotic, interpretation: 'R' });
const S = (antibiotic: string) => ({ antibiotic, interpretation: 'S' });

describe('classifyMdro (MDRO 분류·격리)', () => {
  it('MRSA — S.aureus + Cefoxitin R', () => {
    const r = classifyMdro('Staphylococcus aureus', [R('Cefoxitin'), S('Vancomycin')]);
    expect(r.mdro).toBe('MRSA');
    expect(r.isolation).toBe(true);
  });
  it('MSSA — S.aureus + Oxacillin S → MDRO 아님', () => {
    const r = classifyMdro('Staphylococcus aureus', [S('Oxacillin')]);
    expect(r.mdro).toBeNull();
  });
  it('VRE — Enterococcus + Vancomycin R', () => {
    expect(classifyMdro('Enterococcus faecium', [R('Vancomycin')]).mdro).toBe('VRE');
  });
  it('CRE — Klebsiella + Meropenem R', () => {
    expect(classifyMdro('Klebsiella pneumoniae', [R('Meropenem')]).mdro).toBe('CRE');
  });
  it('ESBL(추정) — E.coli + Ceftriaxone R (carbapenem S)', () => {
    const r = classifyMdro('Escherichia coli', [R('Ceftriaxone'), S('Meropenem')]);
    expect(r.mdro).toBe('ESBL(추정)');
  });
  it('CRE 우선 — E.coli + Carbapenem R (3세대도 R)', () => {
    const r = classifyMdro('Escherichia coli', [R('Ceftriaxone'), R('Imipenem')]);
    expect(r.mdro).toBe('CRE');
  });
  it('CRPA 우선 — 카바페넴 R 포함(정본 코드로 emit → 표본감시 매칭)', () => {
    const r = classifyMdro('Pseudomonas aeruginosa', [R('Ceftazidime'), R('Meropenem'), R('Ciprofloxacin')]);
    expect(r.mdro).toBe('CRPA');
    expect(r.isolation).toBe(true);
  });
  it('MDR Pseudomonas — 카바페넴 외 3개 계열 R', () => {
    const r = classifyMdro('Pseudomonas aeruginosa', [R('Ceftazidime'), R('Ciprofloxacin'), R('Gentamicin')]);
    expect(r.mdro).toBe('MDR Pseudomonas');
    expect(r.isolation).toBe(true);
  });
  it('비발효균 1계열만 R → MDRO 아님', () => {
    expect(classifyMdro('Pseudomonas aeruginosa', [R('Ciprofloxacin'), S('Meropenem')]).mdro).toBeNull();
  });
  it('축약 균명(S. aureus) + Oxacillin R → MRSA(격리) — 정규화 검증', () => {
    const r = classifyMdro('S. aureus', [R('Oxacillin')]);
    expect(r.mdro).toBe('MRSA');
    expect(r.isolation).toBe(true);
  });
  it('내성 표기 변형(R 공백/소문자)도 인정', () => {
    expect(classifyMdro('Klebsiella pneumoniae', [{ antibiotic: 'Meropenem', interpretation: 'r ' }]).mdro).toBe('CRE');
  });
  it('내인성 VanC(E. gallinarum) + Vancomycin R → VRE 아님(오탐 제외)', () => {
    expect(classifyMdro('Enterococcus gallinarum', [R('Vancomycin')]).mdro).toBeNull();
  });
  it('Proteus + Imipenem 단독 R → CRE 아님(내인성 감수성 저하)', () => {
    expect(classifyMdro('Proteus mirabilis', [R('Imipenem'), S('Meropenem')]).mdro).toBeNull();
  });
  it('Proteus + Meropenem R → CRE(진성 카바페넴 내성)', () => {
    expect(classifyMdro('Proteus mirabilis', [R('Meropenem')]).mdro).toBe('CRE');
  });
  it('감수성 → MDRO 아님', () => {
    expect(classifyMdro('Escherichia coli', [S('Ceftriaxone'), S('Meropenem')]).mdro).toBeNull();
  });

  // 축약 속명(자유 텍스트) — 정규화 확장 없으면 CRE/MDRO 조용히 누락(격리·신고 미발) 회귀 금지
  it('축약 속명 "K. pneumoniae" + Meropenem R → CRE (확장 매칭)', () => {
    expect(classifyMdro('K. pneumoniae', [R('Meropenem')]).mdro).toBe('CRE');
  });
  it('축약 "E. cloacae"·"S. marcescens"·"C. freundii" + carbapenem R → CRE', () => {
    expect(classifyMdro('E. cloacae', [R('Ertapenem')]).mdro).toBe('CRE');
    expect(classifyMdro('S. marcescens', [R('Meropenem')]).mdro).toBe('CRE');
    expect(classifyMdro('C. freundii', [R('Imipenem')]).mdro).toBe('CRE');
  });
  it('"S. pneumoniae"는 Klebsiella로 오확장 안 됨(Enterobacterales 아님)', () => {
    expect(classifyMdro('S. pneumoniae', [R('Meropenem')]).mdro).toBeNull();
  });
  it('VRSA — S.aureus + Vancomycin R → VRSA(제2급, MRSA보다 우선)', () => {
    expect(classifyMdro('S. aureus', [R('Vancomycin'), R('Oxacillin')]).mdro).toBe('VRSA');
  });
  it('CRAB/CRPA — 카바페넴 내성 비발효균은 정본 코드로 emit(표본감시 매칭)', () => {
    expect(classifyMdro('Acinetobacter baumannii', [R('Meropenem')]).mdro).toBe('CRAB');
    expect(classifyMdro('Pseudomonas aeruginosa', [R('Imipenem')]).mdro).toBe('CRPA');
  });
});
