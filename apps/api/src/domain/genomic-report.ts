/**
 * 유전체 보고서 조립 보조 — 이차소견(secondary findings) 판정(순수 함수).
 * 이차소견 = ACMG SF 유전자의 P/LP 변이(1차 적응증과 무관하게 회신 권고).
 * 환자가 이차소견 동의(secondaryFindingsOptin)를 하지 않으면 보고서에서 제외한다.
 * 유전자 심볼은 수탁 VCF 자유 텍스트라 별칭·표기 변형이 흔함 → 정규화 후 판정.
 * 미확정(빈/미표준) 심볼의 P/LP는 자동 primary 금지(무동의 이차소견 누출 방지) → 'review'.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
// ACMG SF v3.2(2023) 기준. 개시 전 최신본 재확인(F-3).
export const ACMG_SF_GENES = new Set([
  // 유전성 암
  'BRCA1', 'BRCA2', 'PALB2', 'TP53', 'PTEN', 'STK11', 'MLH1', 'MSH2', 'MSH6', 'PMS2', 'APC', 'MUTYH',
  'BMPR1A', 'SMAD4', 'CDH1', 'CDKN2A', 'VHL', 'MEN1', 'RET', 'NF2', 'MAX', 'TMEM127',
  'SDHD', 'SDHAF2', 'SDHC', 'SDHB', 'TSC1', 'TSC2', 'WT1', 'RB1', 'NTRK1',
  // 심근·부정맥
  'MYH7', 'MYBPC3', 'TNNT2', 'TNNI3', 'TPM1', 'MYL2', 'MYL3', 'ACTC1', 'ACTN2', 'JPH2', 'PLN', 'PRKAG2', 'GLA', 'FLNC',
  'BAG3', 'DES', 'LMNA', 'TNNC1', 'RBM20', 'TTN', 'DSP', 'PKP2', 'DSG2', 'DSC2', 'TMEM43',
  'KCNQ1', 'KCNH2', 'SCN5A', 'RYR2', 'CASQ2', 'TRDN', 'CALM1', 'CALM2', 'CALM3',
  // 대동맥·결합조직
  'FBN1', 'TGFBR1', 'TGFBR2', 'SMAD3', 'ACTA2', 'MYH11', 'MYLK', 'COL3A1', 'LOX',
  // 지질/대사/기타
  'LDLR', 'APOB', 'PCSK9', 'RYR1', 'CACNA1S', 'OTC', 'ATP7B', 'BTD', 'GAA', 'HFE', 'RPE65', 'TTR', 'HNF1A',
]);

// 흔한 별칭·구심볼 → 현행 HGNC 심볼(부분집합). 운영 시 HGNC 별칭 테이블로 확장.
const GENE_ALIASES: Record<string, string> = {
  FBN: 'FBN1', 'FBN-1': 'FBN1',
  TGFBR: 'TGFBR1',
  P53: 'TP53', TRP53: 'TP53',
  BRCA: 'BRCA1',
  MYBPC: 'MYBPC3',
  HTRA1: 'HTRA1',
  MRE11A: 'MRE11',
};

const REPORTABLE_SF = new Set(['Pathogenic', 'Likely Pathogenic']);

/**
 * 유전자 심볼 정규화 — 트림·대문자·별칭 해소 + **부착물 제거**. 빈 문자열이면 null.
 * 수탁 VCF/PDF는 심볼에 전사체·주석을 붙여 온다("BRCA1;NM_007294","BRCA1(p.R1443X)","BRCA-1","TP_53").
 * 정규화가 이를 못 벗기면 SF 유전자(BRCA1 등)가 미인식→primary로 새어 **무동의 이차소견 누출**이 된다.
 * 그래서 구분자(; : , / 공백 괄호) 앞 첫 토큰만 취하고, 하이픈·점·언더스코어를 제거해 표준 심볼에 수렴시킨다.
 * (분류 전용 — 저장·표시는 원문 유지하므로 표준화가 다른 심볼을 훼손해도 버킷 판정만 안전측으로 작동.)
 */
export function normalizeGeneSymbol(gene: string | null | undefined): string | null {
  if (gene == null) return null;
  const head = gene.trim().toUpperCase().split(/[;:,/()[\]\s]/)[0]; // 구분자 앞 첫 토큰
  const g = head.replace(/[-._]/g, ''); // 하이픈·점·언더스코어 제거(BRCA-1→BRCA1, TP_53→TP53)
  if (!g) return null;
  return GENE_ALIASES[g] ?? g;
}

/** 변이가 이차소견 후보인지 — SF 유전자(정규화) + P/LP 분류. */
export function isSecondaryFinding(gene: string | null | undefined, classification: string | null | undefined): boolean {
  if (!classification) return false;
  const g = normalizeGeneSymbol(gene);
  if (!g) return false;
  return ACMG_SF_GENES.has(g) && REPORTABLE_SF.has(classification);
}

/**
 * 보고 버킷 결정 — 'secondary' | 'primary' | 'review'.
 *  - SF 유전자 P/LP → secondary(동의 게이트 적용)
 *  - P/LP인데 유전자 심볼 미확정(null/빈) → review(무동의 누출 방지 위해 자동 primary 금지, 큐레이션 보류)
 *  - 그 외 → primary(1차 적응증 결과)
 */
export function findingBucket(gene: string | null | undefined, classification: string | null | undefined): 'secondary' | 'primary' | 'review' {
  if (isSecondaryFinding(gene, classification)) return 'secondary';
  if (classification && REPORTABLE_SF.has(classification) && !normalizeGeneSymbol(gene)) return 'review';
  return 'primary';
}
