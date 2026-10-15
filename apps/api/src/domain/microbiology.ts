/**
 * 미생물 단계보고 도메인 (순수 함수) — 그람 분류·단계 전이·보고 상태.
 * 근거: 기획 22 §5(미생물 단계보고: 그람→예비→동정→감수성 최종).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export const CULTURE_STAGES = ['INOCULATED', 'GRAM', 'ID', 'AST_FINAL'] as const;
export type CultureStage = (typeof CULTURE_STAGES)[number];

/** 그람 염색 소견 → 분류 코드(예비보고 힌트). */
export function gramCategory(gramStain: string): string {
  const s = gramStain.toLowerCase();
  const pos = /gram[\s-]*pos|양성/.test(s);
  const neg = /gram[\s-]*neg|음성/.test(s);
  const cocci = /cocci|coccus|구균/.test(s);
  const rods = /rod|bacill|간균|막대/.test(s);
  if (pos && cocci) return 'GPC'; // 그람양성 구균
  if (pos && rods) return 'GPR'; // 그람양성 간균
  if (neg && cocci) return 'GNC'; // 그람음성 구균
  if (neg && rods) return 'GNR'; // 그람음성 간균
  if (/yeast|효모|candida/.test(s)) return 'YEAST';
  if (/no organism|없음|음성 배양|no growth/.test(s)) return 'NONE';
  return 'OTHER';
}

/** 그람 소견 기록 가능 단계(접종/그람까지). */
export function canRecordGram(stage: string | null): boolean {
  return stage == null || stage === 'INOCULATED' || stage === 'GRAM';
}

/** 최종(동정+AST) 확정 가능 여부 — 그람 예비 후 진행. */
export function canFinalize(stage: string | null): boolean {
  return stage === 'GRAM' || stage === 'ID' || stage === 'AST_FINAL';
}

/** 예비보고 요약 문구 생성. */
export function preliminaryText(gramStain: string): string {
  const cat = gramCategory(gramStain);
  const label: Record<string, string> = {
    GPC: '그람양성 구균', GPR: '그람양성 간균', GNC: '그람음성 구균',
    GNR: '그람음성 간균', YEAST: '효모양 진균', NONE: '균 미검출', OTHER: '기타',
  };
  return `[예비] 그람염색: ${gramStain} (${label[cat] ?? cat})`;
}
