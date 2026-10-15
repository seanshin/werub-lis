/**
 * 항체동정 패널(11-cell) 판정 — 룰아웃 로직(순수 함수).
 * 각 패널 세포의 항원 프로파일과 환자 혈청 반응(+/0)으로:
 *  - 룰아웃: 항원+ 세포에 비반응(0)이 있으면 해당 anti-항원 배제
 *  - 후보: 룰아웃 안 됐고 반응 세포에 항원+가 존재
 *  - 동정: 반응 패턴이 항원 유무와 완전 일치(모든 반응세포 항원+, 모든 비반응세포 항원-)
 * STANDARD_PANEL은 내부 정합 예시 그리드 — 운영 시 실제 시약 패널 로트로 교체.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface PanelCell {
  cell: number;
  antigens: Record<string, boolean>;
}

// 11-cell 예시 패널 — 주요 항원(D C E c e K Fya Jka S M) 프로파일
const AG = ['D', 'C', 'E', 'c', 'e', 'K', 'Fya', 'Jka', 'S', 'M'];
const G = (bits: string): Record<string, boolean> => Object.fromEntries(AG.map((a, i) => [a, bits[i] === '1']));
export const STANDARD_PANEL: PanelCell[] = [
  { cell: 1, antigens: G('1101110101') },
  { cell: 2, antigens: G('1010111010') },
  { cell: 3, antigens: G('1101100011') },
  { cell: 4, antigens: G('0011101100') },
  { cell: 5, antigens: G('1100110110') },
  { cell: 6, antigens: G('0011010011') },
  { cell: 7, antigens: G('1010101101') },
  { cell: 8, antigens: G('0101110010') },
  { cell: 9, antigens: G('1011011001') },
  { cell: 10, antigens: G('0110100110') },
  { cell: 11, antigens: G('1100011011') },
];

export interface PanelInterpretation {
  ruledOut: string[];
  candidates: string[];
  identified: string[]; // 패턴 완전 일치 항체(anti- 제외 항원명)
  antibodies: string; // 동정 항체 "anti-X, anti-Y"
}

export function interpretPanel(panel: PanelCell[], reactivity: boolean[]): PanelInterpretation {
  const antigens = [...new Set(panel.flatMap((c) => Object.keys(c.antigens)))];
  const ruledOut: string[] = [];
  const candidates: string[] = [];
  const identified: string[] = [];
  for (const ag of antigens) {
    // 룰아웃: 항원+ 세포에 비반응(0)이 있으면 배제
    if (panel.some((c, i) => c.antigens[ag] && reactivity[i] === false)) { ruledOut.push(ag); continue; }
    // 반응 근거: 반응 세포 중 항원+가 있어야 후보
    if (!panel.some((c, i) => reactivity[i] && c.antigens[ag])) continue;
    candidates.push(ag);
    // 동정: 모든 반응세포 항원+ AND 모든 비반응세포 항원-
    const allReactivePos = panel.every((c, i) => !reactivity[i] || c.antigens[ag]);
    const allNonReactiveNeg = panel.every((c, i) => reactivity[i] || !c.antigens[ag]);
    if (allReactivePos && allNonReactiveNeg) identified.push(ag);
  }
  return { ruledOut, candidates, identified, antibodies: identified.map((a) => `anti-${a}`).join(', ') };
}
