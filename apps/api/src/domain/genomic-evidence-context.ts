/**
 * 유전체 근거 종합 번들(Domain, 순수 함수).
 *
 * 한 변이에 대한 **모든 로컬 근거를 한 곳에** 모은다: 유전자 지식·인용 근거(ClinVar/gnomAD/OncoKB)·
 * ACMG·이전 해석 이력. 두 가지로 쓴다.
 *  ① 지금: 판독자가 근거를 흩어보지 않고 한 화면에서 검토(=즉시 유용).
 *  ② 나중: 온프레미스 LLM(RAG)의 **컨텍스트**가 이 번들이다. `promptContext`가 모델에 넘길 문맥.
 *
 * ★설계 원칙: 이 함수는 순수·로컬이다. 어떤 데이터도 외부로 내보내지 않는다. 실제 LLM 호출은
 * 별도 provider가 담당하며, **온프레미스 엔드포인트가 설정됐을 때만** 동작한다(미설정=로컬 규칙엔진).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import type { CitedEvidence } from './genomic-ai-interpret';
import type { AcmgEvidence } from './genomic';

export interface EvidenceContextInput {
  gene?: string | null;
  hgvsC?: string | null;
  hgvsP?: string | null;
  vaf?: number | null;
  zygosity?: string | null;
  testType?: string | null;
  chrom?: string | null;
  pos?: number | null;
}
export interface PriorInterpretation {
  classification: string | null;
  evidence: string | null;
  classifier: string | null;
  classifiedDate: string | null;
  status: string | null;
}
export interface GeneKnowledgeLite {
  role: string;
  conditions: string;
  germline?: boolean;
  somaticTherapy?: string;
}

export interface EvidenceContext {
  variant: { gene: string | null; hgvs: string | null; locus: string | null; vaf: number | null; zygosity: string | null; testType: string | null };
  geneKnowledge: GeneKnowledgeLite | null;
  citedEvidence: CitedEvidence | null;
  acmgEvidence: AcmgEvidence | null;
  priorInterpretations: PriorInterpretation[];
  /** 근거 출처 요약(화면 뱃지·감사용) */
  sources: string[];
  /** 온프레미스 LLM(RAG)에 넘길 문맥 — 로컬에서 조립, 외부 전송은 provider가 결정 */
  promptContext: string;
  /** LLM provider가 미구성이면 안내(현재 기본) */
  llmNote: string;
}

function line(label: string, v: string | number | null | undefined): string {
  return v == null || v === '' ? '' : `${label}: ${v}`;
}

export function buildEvidenceContext(
  input: EvidenceContextInput,
  kb: GeneKnowledgeLite | null,
  cited: CitedEvidence | null,
  acmg: AcmgEvidence | null,
  prior: PriorInterpretation[],
): EvidenceContext {
  const hgvs = input.hgvsP ?? input.hgvsC ?? null;
  const locus = input.chrom && input.pos != null ? `${input.chrom}:${input.pos}` : null;
  const sources: string[] = [];
  if (cited?.source) sources.push(cited.source);
  if (kb) sources.push('내장 유전자 지식기반');
  if (acmg) sources.push('ACMG 근거');

  // RAG 컨텍스트 — 근거를 구조화해 텍스트로. LLM이 이 문맥만 보고 초안을 쓰도록(환각 억제).
  const somatic = (input.testType ?? '').toUpperCase() === 'SOMATIC';
  const ctx = [
    '# 변이 해석 근거 종합(로컬)',
    '## 변이',
    line('유전자', input.gene),
    line('HGVS', hgvs),
    line('좌위', locus),
    line('VAF(%)', input.vaf),
    line('접합자', input.zygosity),
    line('검사유형', somatic ? '종양(체세포)' : '생식세포'),
    kb ? '## 유전자 지식' : '',
    kb ? line('기능', kb.role) : '',
    kb ? line('연관질환', kb.conditions) : '',
    kb?.somaticTherapy ? line('표적치료', kb.somaticTherapy) : '',
    cited ? '## 인용 근거(반입 DB)' : '',
    cited ? line('출처', cited.source) : '',
    cited ? line('유의성', cited.significance) : '',
    cited ? line('검토별점', cited.stars) : '',
    cited ? line('gnomAD 대립빈도', cited.gnomadAf) : '',
    cited ? line('OncoKB level', cited.oncokbLevel) : '',
    cited ? line('citation', cited.citation) : '',
    cited ? line('반입본', cited.catalogVersion) : '',
    acmg ? '## ACMG 근거 카운트' : '',
    acmg ? Object.entries(acmg).filter(([, n]) => (n ?? 0) > 0).map(([k, n]) => `${k}=${n}`).join(', ') : '',
    prior.length ? '## 이전 해석 이력' : '',
    ...prior.map((p) => `- ${p.classifiedDate ?? '?'} ${p.status ?? ''} ${p.classification ?? ''}${p.evidence ? ` (${p.evidence})` : ''}`),
    '## 지시',
    '위 근거만 사용해 변이 임상 유의성 해석 초안을 작성하되, 근거에 없는 사실을 만들지 말 것. 분류는 ACMG/AMP 체계를 따르고 인용을 명시할 것.',
  ].filter(Boolean).join('\n');

  return {
    variant: { gene: input.gene ?? null, hgvs, locus, vaf: input.vaf ?? null, zygosity: input.zygosity ?? null, testType: input.testType ?? null },
    geneKnowledge: kb,
    citedEvidence: cited,
    acmgEvidence: acmg,
    priorInterpretations: prior,
    sources,
    promptContext: ctx,
    llmNote:
      '온프레미스 LLM 미구성 — 현재는 로컬 규칙엔진(genomic-ai-interpret)이 해석 초안을 생성합니다. ' +
      '이 번들은 향후 원내 호스팅 모델(RAG)의 컨텍스트로 그대로 사용됩니다(외부 전송 없음).',
  };
}
