/**
 * MDRO(다제내성균) 분류 — 감염관리 격리 판단(순수 함수).
 * 균명 + 항생제 감수성(AST)으로 MRSA/VRE/CRE/ESBL(추정)/MDR 비발효균을 식별.
 * 참고: 감염관리 지침 간소화 — 확정은 검사실/감염관리팀 판단.
 * 균명은 자유 텍스트 입력이 흔하므로(축약형 'S. aureus', 'K. pneumoniae' 등) normalizeOrganism로 확장 후 매칭.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { normalizeOrganism } from './organism';

export interface SusLike {
  antibiotic: string | null;
  interpretation: string | null; // S/I/R
}
export interface MdroResult {
  mdro: string | null; // MRSA/VRE/CRE/ESBL(추정)/MDR ... 또는 null
  isolation: boolean; // 격리 필요
  reason: string | null;
}

// 항생제 정규화: 소문자·마침표 제거·공백 정리(균명은 normalizeOrganism로 축약 속명까지 확장)
const norm = (s: string): string => (s ?? '').toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();
// 내성 판정 정규화: 'R', 'r', 'R ', 'Resistant', 'R*' 모두 내성으로 인정
const isR = (interp: string | null): boolean => (interp ?? '').trim().toUpperCase().startsWith('R');
const hasR = (sus: SusLike[], names: string[]): boolean =>
  sus.some((s) => isR(s.interpretation) && names.some((n) => norm(s.antibiotic ?? '').includes(n)));
const orgHas = (o: string, keywords: string[]): boolean => keywords.some((k) => o.includes(k));

// 장내세균목(Enterobacterales) 종 키워드(정규화 후). Morganella/Providencia/Hafnia 포함(CRE 미탐 방지).
const ENTEROBACTERALES = ['escherichia', 'coli', 'klebsiella', 'enterobacter', 'proteus', 'serratia', 'citrobacter', 'morganella', 'providencia', 'hafnia'];
const CARBAPENEMS = ['imipenem', 'meropenem', 'ertapenem', 'doripenem'];

// 항녹농균/아시네토박터 항생제 계열(정규화 후 부분일치). MDR = 3개 이상 '계열'에 내성(Magiorakos).
const NONFERMENTER_CLASSES: Record<string, string[]> = {
  '항슈도모나스 penicillin': ['piperacillin', 'ticarcillin'],
  cephalosporin: ['ceftazidime', 'cefepime'],
  carbapenem: ['imipenem', 'meropenem', 'doripenem'],
  fluoroquinolone: ['ciprofloxacin', 'levofloxacin'],
  aminoglycoside: ['gentamicin', 'tobramycin', 'amikacin'],
  monobactam: ['aztreonam'],
  polymyxin: ['colistin', 'polymyxin'],
};

export function classifyMdro(organism: string | null, sus: SusLike[]): MdroResult {
  const o = normalizeOrganism(organism); // 축약 속명(K. pneumoniae 등)까지 확장 — 미확장 시 CRE/MDRO 누락
  if (!o) return { mdro: null, isolation: false, reason: null };

  const isSaureus = orgHas(o, ['aureus', 'mrsa', 'mssa', 'vrsa', 'visa']);
  // VRSA/VISA — 황색포도상구균 + Vancomycin 내성. 제2급 법정감염병 → MRSA보다 먼저 판정(강한 신호 우선).
  if (isSaureus && (hasR(sus, ['vancomycin']) || o.includes('vrsa') || o.includes('visa'))) {
    return { mdro: 'VRSA', isolation: true, reason: 'Vancomycin 내성(제2급 법정감염병)' };
  }
  // MRSA — 황색포도상구균 + Oxacillin/Methicillin/Cefoxitin 내성 (또는 균명이 MRSA)
  if (isSaureus && (hasR(sus, ['oxacillin', 'methicillin', 'cefoxitin']) || o.includes('mrsa'))) {
    return { mdro: 'MRSA', isolation: true, reason: 'Oxacillin/Cefoxitin 내성' };
  }
  // VRE — 장구균 + Vancomycin 내성. E. gallinarum/casseliflavus/flavescens는 내인성 VanC(역학적 VRE 아님) → 제외.
  const isVanCSpecies = orgHas(o, ['gallinarum', 'casseliflavus', 'flavescens']);
  if (orgHas(o, ['enterococc', 'faecalis', 'faecium']) && !isVanCSpecies && hasR(sus, ['vancomycin'])) {
    return { mdro: 'VRE', isolation: true, reason: 'Vancomycin 내성' };
  }
  // CRE — 장내세균 + Carbapenem 내성. Proteus/Morganella/Providencia는 내인성 imipenem 감수성 저하 →
  //   imipenem 단독 R로는 CRE 판정 금지(meropenem/ertapenem/doripenem R 요구).
  const isProteusGroup = orgHas(o, ['proteus', 'morganella', 'providencia']);
  const carbaR = isProteusGroup ? hasR(sus, ['meropenem', 'ertapenem', 'doripenem']) : hasR(sus, CARBAPENEMS);
  if (orgHas(o, ENTEROBACTERALES) && carbaR) {
    return { mdro: 'CRE', isolation: true, reason: 'Carbapenem 내성' };
  }
  // ESBL(추정) — E.coli/Klebsiella + 3세대 cephalosporin 내성
  if (orgHas(o, ['escherichia', 'coli', 'klebsiella']) && hasR(sus, ['ceftriaxone', 'cefotaxime', 'ceftazidime'])) {
    return { mdro: 'ESBL(추정)', isolation: true, reason: '3세대 cephalosporin 내성' };
  }
  // 비발효균(Pseudomonas/Acinetobacter)
  const isPseudo = orgHas(o, ['pseudomonas', 'aeruginosa']);
  const isAcineto = orgHas(o, ['acinetobacter', 'baumannii', 'acineto']);
  if (isPseudo || isAcineto) {
    const label = isAcineto ? 'Acinetobacter' : 'Pseudomonas';
    // 카바페넴 내성 Acinetobacter(CRAB)/Pseudomonas(CRPA) — 단독 카바페넴 내성도 격리·표본감시 신고 대상.
    //   mdro 코드를 CRAB/CRPA 정본으로 emit해야 notifiable 분류(/CRE|CPE|CRAB|CRPA/)가 잡는다(라벨 문자열이면 누락).
    if (hasR(sus, CARBAPENEMS)) {
      return { mdro: isAcineto ? 'CRAB' : 'CRPA', isolation: true, reason: `Carbapenem 내성 ${label}(격리·표본감시)` };
    }
    // MDR — 3개 이상 '계열'에 내성
    const resistantClasses = Object.entries(NONFERMENTER_CLASSES).filter(([, drugs]) => hasR(sus, drugs)).length;
    if (resistantClasses >= 3) {
      return { mdro: `MDR ${label}`, isolation: true, reason: `다제내성(${resistantClasses}개 계열 R)` };
    }
  }
  return { mdro: null, isolation: false, reason: null };
}
