/**
 * 검체 품질 HIL(용혈·황달·지질혈) 간섭 판정(Domain, 순수 함수) — 스타터 규칙.
 * ⚠ 영향 analyte·간섭 임계는 장비·시약별 검사실 확정. 여기선 대표 규칙만.
 * 용혈 검체는 K·LDH·AST 등을 거짓 상승시킴 → 영향 검사에 경고(재채취 판단은 사람).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export type HilGrade = 'NONE' | '1+' | '2+' | '3+' | null | undefined;
export interface Hil { hemolysis?: HilGrade; icterus?: HilGrade; lipemia?: HilGrade }

const GRADE_RANK: Record<string, number> = { NONE: 0, '1+': 1, '2+': 2, '3+': 3 };
const rank = (g: HilGrade): number => (g ? GRADE_RANK[g] ?? 0 : 0);

// 검사코드 → 영향 인자(hemolysis/icterus/lipemia) 목록(대표 스타터).
const AFFECTED: Record<string, ('H' | 'I' | 'L')[]> = {
  'CHE-K': ['H'],        // 칼륨 — 용혈로 거짓 상승(적혈구 K 방출)
  'CHE-LDH': ['H'],      // LDH
  'CHE-AST': ['H'],      // AST
  'CHE-PHOS': ['H'],     // 인
  'CHE-TBIL': ['H', 'L'],// 총빌리루빈
  'CHE-TP': ['L', 'I'],  // 총단백
  'CHE-ALB': ['L'],      // 알부민
  'CHE-GLU': ['L'],      // 포도당(지질혈 간섭)
  'IMM-CRP': ['L'],      // CRP(면역비탁 — 지질혈)
};

const FACTOR_KO: Record<string, string> = { H: '용혈', I: '황달', L: '지질혈' };

/** 검사코드 + 검체 HIL → 간섭 경고(2+ 이상 유의). 없으면 null. */
export function hilInterference(testCode: string, hil: Hil): { factors: string[]; message: string } | null {
  const affects = AFFECTED[testCode];
  if (!affects) return null;
  const present: string[] = [];
  for (const f of affects) {
    const g = f === 'H' ? hil.hemolysis : f === 'I' ? hil.icterus : hil.lipemia;
    if (rank(g) >= 2) present.push(`${FACTOR_KO[f]}(${g})`); // 2+ 이상 유의 간섭
  }
  if (present.length === 0) return null;
  return { factors: present, message: `검체 ${present.join('·')} — ${testCode} 결과 간섭 가능(재채취 검토)` };
}
