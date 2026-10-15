/**
 * 선택적/단계적 AST 보고(cascade/selective reporting) — Domain 순수 함수, 스타터 규칙.
 * CLSI M100 cascade 원칙 간소화: 1차 계열 약제가 감수성(S)이면 광범위·예비(reserve) 약제는 억제(보고 보류).
 * ⚠ 정식 계열·억제 규칙은 검사실·감염내과 확정(항생제 스튜어드십). 여기선 대표 계열만.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

/** 예비(reserve)·광범위 약제 — 1차약 감수성 시 억제 대상(스타터). */
const RESERVE_DRUGS = new Set([
  'Meropenem', 'Imipenem', 'Ertapenem', // 카바페넴
  'Colistin', 'Tigecycline', 'Linezolid', 'Daptomycin', 'Vancomycin', // 마지막 보루
  'Piperacillin-Tazobactam', 'Cefepime', // 광범위 β-lactam(일부)
]);

/** 1차 계열 약제(감수성 시 cascade 억제 트리거) — 스타터. */
const FIRST_LINE = new Set([
  'Ampicillin', 'Amoxicillin-Clavulanate', 'Cefazolin', 'Ceftriaxone', 'Cefotaxime',
  'Ciprofloxacin', 'Levofloxacin', 'Trimethoprim-Sulfamethoxazole', 'Gentamicin', 'Nitrofurantoin',
]);

export interface AstItem { antibiotic: string; interpretation: string | null }
export interface SelectiveAstItem extends AstItem { report: boolean; suppressReason: string | null }

/**
 * 감수성 목록 → 보고 여부 주석. 1차약 중 S가 하나라도 있으면 reserve 약제 억제(보고 보류).
 * R/I(내성·중간)인 reserve 약제는 항상 보고(임상 필요). 규칙 미해당은 보고.
 */
export function selectiveAstReport(items: AstItem[]): { items: SelectiveAstItem[]; firstLineSusceptible: boolean } {
  const firstLineSusceptible = items.some((i) => FIRST_LINE.has(i.antibiotic) && i.interpretation === 'S');
  const out = items.map<SelectiveAstItem>((i) => {
    const isReserve = RESERVE_DRUGS.has(i.antibiotic);
    // reserve 약제는 1차약 S일 때 & 본인이 S(=대안 불필요)일 때만 억제. R/I는 보고.
    if (isReserve && firstLineSusceptible && i.interpretation === 'S') {
      return { ...i, report: false, suppressReason: '1차약 감수성 — cascade 억제(선택적 보고)' };
    }
    return { ...i, report: true, suppressReason: null };
  });
  return { items: out, firstLineSusceptible };
}
