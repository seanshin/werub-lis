/**
 * 세포병리(Cytology) 분류·적정성(Domain, 순수 함수) — 스타터셋.
 * ⚠ 정식 분류(Bethesda 최신판·검체별 세부)는 검사실 확정. 여기선 대표 카테고리·검증만.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export const CYTO_SPECIMEN_TYPES = ['PAP', 'FNA', 'FLUID', 'URINE', 'SPUTUM', 'OTHER'];
export const ADEQUACY = ['SATISFACTORY', 'UNSATISFACTORY'];

/** Bethesda(자궁경부 Pap, TBS 2014) 대표 카테고리 + 일반 세포 카테고리. */
export const CYTO_CATEGORIES = [
  // Bethesda(Pap)
  'NILM', 'ASC-US', 'ASC-H', 'LSIL', 'HSIL', 'AGC', 'AIS', 'SCC', 'ADENOCARCINOMA',
  // 일반 세포(비-Pap)
  '양성', '비정형', '의심', '악성', '판정보류',
];

export function isValidCytoSpecimen(t: string): boolean { return CYTO_SPECIMEN_TYPES.includes(t); }
export function isValidAdequacy(a: string): boolean { return ADEQUACY.includes(a); }
/** 활성 카탈로그(codes)가 있으면 그 집합으로, 없으면 스타터 목록으로 검증. */
export function isValidCytoCategory(c: string, codes?: Set<string> | null): boolean {
  if (codes && codes.size) return codes.has(c);
  return CYTO_CATEGORIES.includes(c);
}
