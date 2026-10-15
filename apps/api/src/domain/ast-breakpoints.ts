/**
 * MIC→S/I/R 판정엔진(Domain, 순수 함수).
 * 브레이크포인트는 **카탈로그 반입(CLSI M100 개정판)으로 갈아 끼운다** — 활성 카탈로그가 있으면
 * 그것을, 없으면 아래 스타터셋을 쓴다. 보고서에 실리는 표준명도 활성 카탈로그를 따른다.
 * MIC(µg/mL) 기준: ≤ s → S(감수성), ≥ r → R(내성), 그 사이 → I(중간).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { normalizeOrganism } from './organism';

export interface Breakpoint { s: number; r: number; }
export interface AstInterpretation {
  interpretation: 'S' | 'I' | 'R' | null;
  standard: string;
  breakpoint: Breakpoint | null;
  note?: string;
}

/** 활성 카탈로그가 없을 때 표기할 기준명 */
export const STARTER_STANDARD = 'CLSI-M100-2024(starter)';

export type BreakpointTable = Record<string, Record<string, Breakpoint>>;

/** 균군별 약제 브레이크포인트(대표값). 실제는 균종·감염부위별 세분 — 검사실 확정 대상. */
export const STARTER_BREAKPOINTS: BreakpointTable = {
  Enterobacterales: {
    ampicillin: { s: 8, r: 32 },
    'amoxicillin-clavulanate': { s: 8, r: 32 },
    'piperacillin-tazobactam': { s: 16, r: 128 },
    cefazolin: { s: 2, r: 8 },
    ceftriaxone: { s: 1, r: 4 },
    cefepime: { s: 2, r: 16 },
    ceftazidime: { s: 4, r: 16 },
    meropenem: { s: 1, r: 4 },
    imipenem: { s: 1, r: 4 },
    ertapenem: { s: 0.5, r: 2 },
    ciprofloxacin: { s: 0.25, r: 1 },
    levofloxacin: { s: 0.5, r: 2 },
    gentamicin: { s: 4, r: 16 },
    amikacin: { s: 16, r: 64 },
    'trimethoprim-sulfamethoxazole': { s: 2, r: 4 },
  },
  Staphylococcus: {
    oxacillin: { s: 2, r: 4 },
    cefoxitin: { s: 4, r: 8 },
    vancomycin: { s: 2, r: 16 },
    linezolid: { s: 4, r: 8 },
    daptomycin: { s: 1, r: 2 },
    clindamycin: { s: 0.5, r: 4 },
    erythromycin: { s: 0.5, r: 8 },
    'trimethoprim-sulfamethoxazole': { s: 2, r: 4 },
  },
  Enterococcus: {
    ampicillin: { s: 8, r: 16 },
    vancomycin: { s: 4, r: 32 },
    linezolid: { s: 2, r: 8 },
  },
  'Pseudomonas aeruginosa': {
    'piperacillin-tazobactam': { s: 16, r: 128 },
    ceftazidime: { s: 8, r: 32 },
    cefepime: { s: 8, r: 32 },
    meropenem: { s: 2, r: 8 },
    imipenem: { s: 2, r: 8 },
    ciprofloxacin: { s: 0.5, r: 2 },
    amikacin: { s: 16, r: 64 },
  },
};

function norm(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();
}

/** 균명 → 브레이크포인트 균군 키. 축약 속명(K. pneumoniae 등)은 normalizeOrganism로 확장 후 매칭. */
export function organismGroup(organism: string | null): string | null {
  const o = normalizeOrganism(organism);
  if (/pseudomonas aeruginosa/.test(o)) return 'Pseudomonas aeruginosa';
  if (/staphylococcus|staph|s aureus|아우레우스|포도알균|포도상구균/.test(o)) return 'Staphylococcus';
  if (/enterococcus|장알균|장구균/.test(o)) return 'Enterococcus';
  // 장내세균목(대표 속)
  if (/escherichia|coli|klebsiella|enterobacter|proteus|serratia|citrobacter|salmonella|shigella|morganella|providencia/.test(o)) return 'Enterobacterales';
  return null;
}

/**
 * MIC → S/I/R 해석. 균군·약제 브레이크포인트가 있으면 판정, 없으면 null(수기 유지).
 * mic 문자열은 '≤0.5','>32','2' 등 부등호 허용 — 수치만 추출해 비교.
 */
export function interpretMic(
  organism: string | null,
  antibiotic: string,
  mic: string | null,
  catalog?: { table: BreakpointTable; standard: string } | null,
): AstInterpretation {
  const table = catalog?.table ?? STARTER_BREAKPOINTS;
  const STANDARD = catalog?.standard ?? STARTER_STANDARD;
  const group = organismGroup(organism);
  const drug = norm(antibiotic).replace(/\//g, '-');
  const bp = group ? table[group]?.[drug] : undefined;
  if (!bp) return { interpretation: null, standard: STANDARD, breakpoint: null, note: '브레이크포인트 미정의(수기 판정 유지)' };

  const m = (mic ?? '').match(/([<>]=?|≤|≥)?\s*([0-9]*\.?[0-9]+)/);
  if (!m) return { interpretation: null, standard: STANDARD, breakpoint: bp, note: 'MIC 수치 파싱 불가' };
  const op = m[1] ?? '';
  const val = Number(m[2]);

  // 부등호 처리: '≤s'는 S, '≥r'는 R로만 확정 가능.
  const isLe = op === '<' || op === '<=' || op === '≤';
  const isGe = op === '>' || op === '>=' || op === '≥';
  if (isLe && val <= bp.s) return { interpretation: 'S', standard: STANDARD, breakpoint: bp };
  if (isGe && val >= bp.r) return { interpretation: 'R', standard: STANDARD, breakpoint: bp };
  // 부등호가 확정 구간 밖이면 실제 MIC를 알 수 없다 — 정확값처럼 비교하면 S/R을 오판한다
  //   (예: ceftriaxone s=1,r=4에서 ">0.5"를 0.5로 비교하면 S로 과소판정, "<4"를 4로 비교하면 R로 과대판정).
  //   자동판정 보류(null)로 두고 검사자가 수기 확정.
  if (op) return { interpretation: null, standard: STANDARD, breakpoint: bp, note: '부등호 MIC — 자동 S/I/R 확정 불가(수기 판정)' };

  let interp: 'S' | 'I' | 'R'; // op 없음(정확값)만 표준 비교
  if (val <= bp.s) interp = 'S';
  else if (val >= bp.r) interp = 'R';
  else interp = 'I';
  return { interpretation: interp, standard: STANDARD, breakpoint: bp };
}
