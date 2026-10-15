/**
 * 유전체 AI 해석 보조(Domain, 순수 함수) — **로컬 지식기반**.
 *
 * ⚠ 설계 원칙: 유전체 데이터는 고민감 개인정보(PHI)다. 환자 변이를 외부 LLM/클라우드로 보내면
 * 임상 프라이버시가 무너진다. 따라서 이 엔진은 **어떤 데이터도 시스템 밖으로 내보내지 않는다** —
 * 내장 지식기반(임상적 actionable 유전자·질환·표적치료 연관)과 ACMG 규칙으로 해석 초안을 만든다.
 *
 * ⚠ 임상 원칙: 산출물은 **초안(제안)**이다. 자동 확정하지 않으며, 반드시 판독 전문가가 검토·수정·
 * 확정한다. 이 엔진은 판단을 대체하지 않고 근거 정리·놓친 시사점 환기를 돕는다.
 *
 * (실 LLM을 붙이려면 별도 PHI 거버넌스(비식별화·전용 온프레미스 모델·계약)가 선행돼야 한다.)
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { acmgClassify, type AcmgEvidence } from './genomic';

export interface AiInterpretInput {
  gene?: string | null;
  hgvsC?: string | null;
  hgvsP?: string | null;
  variantType?: string | null; // VARIANT/FUSION/CNV 등(종양)
  classification?: string | null; // 이미 잠정 분류가 있으면 참고
  acmgEvidence?: AcmgEvidence | null;
  vaf?: number | null;
  zygosity?: string | null; // HET/HOM
  testType?: string | null; // GERMLINE/SOMATIC
}

/** 변이 임상근거(활성 VARIANT_EVIDENCE에서 조회) — 해석의 인용 출처 */
export interface CitedEvidence {
  significance?: string;
  stars?: number | string;
  gnomadAf?: number | string;
  condition?: string;
  source?: string;
  citation?: string;
  oncokbLevel?: string;
  catalogVersion?: string;
}

export interface AiInterpretResult {
  suggestedClassification: string | null;
  confidence: 'high' | 'moderate' | 'low';
  geneContext: { gene: string; role: string; conditions: string; actionable: boolean } | null;
  /** 근거 DB 인용(있을 때만) — ClinVar 유의성·별점·gnomAD 빈도·출처 */
  citedEvidence: CitedEvidence | null;
  rationale: string[];
  clinicalSignificance: string;
  therapyImplications: string[];
  caveats: string[];
  disclaimer: string;
  /** 판독자가 해석란에 붙여넣을 수 있는 초안 문단(그대로 확정 금지) */
  draftNarrative: string;
}

const DISCLAIMER =
  'AI 자동 해석 초안(로컬 지식기반) — 반드시 판독 전문가가 검토·수정·확정해야 합니다. ' +
  '임상 판단을 대체하지 않으며, 환자 데이터는 외부로 전송되지 않았습니다.';

/**
 * 임상적으로 중요한 유전자 지식기반(대표셋). 실 운영은 검사실이 큐레이션·확장.
 * germline=유전성 질환, somatic=종양 표적치료 시사점.
 */
interface GeneKnowledge {
  role: string; // 유전자 기능·경로
  conditions: string; // 연관 질환/증후군
  germline?: boolean;
  somaticTherapy?: string; // 종양에서의 표적치료 시사점
}

const GENE_KB: Record<string, GeneKnowledge> = {
  BRCA1: { role: 'DNA 이중가닥 손상 상동재조합 복구', conditions: '유전성 유방·난소암 증후군(HBOC)', germline: true, somaticTherapy: 'PARP 억제제(olaparib 등) 감수성 시사' },
  BRCA2: { role: 'DNA 이중가닥 손상 상동재조합 복구', conditions: '유전성 유방·난소암 증후군(HBOC)·췌장암', germline: true, somaticTherapy: 'PARP 억제제 감수성 시사' },
  TP53: { role: '종양억제(세포주기·아폽토시스)', conditions: 'Li-Fraumeni 증후군(germline)·다수 종양(somatic)', germline: true },
  MLH1: { role: 'DNA 불일치복구(MMR)', conditions: 'Lynch 증후군(유전성 비용종증 대장암)', germline: true, somaticTherapy: 'MMR 결손 시 면역관문억제제(pembrolizumab) 고려' },
  MSH2: { role: 'DNA 불일치복구(MMR)', conditions: 'Lynch 증후군', germline: true, somaticTherapy: 'MMR 결손 시 면역관문억제제 고려' },
  APC: { role: '종양억제(WNT 경로)', conditions: '가족성 선종성 용종증(FAP)', germline: true },
  EGFR: { role: '수용체 티로신인산화효소(RTK)', conditions: '비소세포폐암 등', somaticTherapy: 'EGFR TKI(osimertinib 등) — 활성화 변이(L858R·exon19del) 감수성, T790M 내성' },
  KRAS: { role: 'RAS/MAPK 신호전달 GTP분해효소', conditions: '대장암·폐암·췌장암', somaticTherapy: 'G12C 변이는 sotorasib/adagrasib 대상. 그 외 변이는 EGFR 항체 내성 시사' },
  BRAF: { role: 'RAS/MAPK 세린/트레오닌 인산화효소', conditions: '흑색종·대장암·갑상선암', somaticTherapy: 'V600E는 BRAF 억제제(±MEK 억제제) 대상' },
  ALK: { role: '수용체 티로신인산화효소', conditions: '비소세포폐암', somaticTherapy: 'ALK 융합은 alectinib/lorlatinib 등 ALK 억제제 대상' },
  ERBB2: { role: 'HER2 수용체 티로신인산화효소', conditions: '유방암·위암 등', somaticTherapy: '증폭/활성화 시 HER2 표적(trastuzumab 등)' },
  FLT3: { role: '수용체 티로신인산화효소(조혈)', conditions: '급성골수성백혈병(AML)', somaticTherapy: 'ITD/TKD 변이는 midostaurin/gilteritinib 대상' },
  NPM1: { role: '핵소체 샤페론', conditions: 'AML', somaticTherapy: '변이는 예후 인자(정상핵형 AML에서 대체로 양호), FLT3-ITD 동반 여부와 함께 해석' },
  IDH1: { role: '대사효소(2-HG 생성)', conditions: '신경교종·AML', somaticTherapy: 'ivosidenib 등 IDH1 억제제 대상' },
  IDH2: { role: '대사효소', conditions: 'AML', somaticTherapy: 'enasidenib 등 IDH2 억제제 대상' },
  MET: { role: '수용체 티로신인산화효소', conditions: '비소세포폐암', somaticTherapy: 'exon14 skipping은 capmatinib 등 대상' },
  RET: { role: '수용체 티로신인산화효소', conditions: '갑상선수질암·폐암', somaticTherapy: '융합/변이는 selpercatinib 등 RET 억제제 대상' },
};

/** 유전자 지식 조회(근거 종합 번들·컨텍스트 조립에 재사용). 없으면 null. */
export function geneKnowledge(gene?: string | null): { role: string; conditions: string; germline?: boolean; somaticTherapy?: string } | null {
  return GENE_KB[normGene(gene)] ?? null;
}

function normGene(g?: string | null): string {
  return (g ?? '').trim().toUpperCase();
}

/** ACMG 근거 강도가 실제로 채워졌는지 */
function hasEvidence(e?: AcmgEvidence | null): boolean {
  if (!e) return false;
  return [e.pvs, e.strongP, e.moderateP, e.supportingP, e.standaloneB, e.strongB, e.supportingB].some((v) => (v ?? 0) > 0);
}

export function aiInterpret(input: AiInterpretInput, cited?: CitedEvidence | null): AiInterpretResult {
  const gene = normGene(input.gene);
  const kb = gene ? GENE_KB[gene] : undefined;
  const somatic = (input.testType ?? '').toUpperCase() === 'SOMATIC';
  const rationale: string[] = [];
  const caveats: string[] = [];
  const therapyImplications: string[] = [];
  const starN = cited?.stars != null && cited.stars !== '' ? Number(cited.stars) : null;
  const afN = cited?.gnomadAf != null && cited.gnomadAf !== '' ? Number(cited.gnomadAf) : null;

  // ① 분류 제안 — 우선순위: (a)근거 DB 인용 → (b)ACMG 규칙 → (c)잠정분류/VUS
  let suggested: string | null = null;
  let confidence: AiInterpretResult['confidence'] = 'low';
  if (cited?.significance) {
    // 근거 DB(ClinVar 등)에 등재된 유의성을 1순위로 인용 — 별점(검토상태)이 신뢰도를 정한다
    suggested = cited.significance;
    const star = starN != null ? `${'★'.repeat(Math.max(0, Math.min(4, starN)))}${'☆'.repeat(4 - Math.max(0, Math.min(4, starN)))}` : '';
    rationale.push(
      `근거 DB 인용 — ${cited.source ?? 'DB'}: «${cited.significance}»${star ? ` (${star})` : ''}` +
        `${cited.citation ? ` · 출처 ${cited.citation}` : ''}${cited.catalogVersion ? ` · 반입본 ${cited.catalogVersion}` : ''}`,
    );
    confidence = starN != null && starN >= 2 ? 'high' : starN != null && starN >= 1 ? 'moderate' : 'low';
    if (starN != null && starN < 2) caveats.push(`검토상태 별점이 낮습니다(${starN}★) — 단일 제출·상충 가능. 추가 근거 확인 권장.`);
    // ACMG 근거도 함께 있으면 규칙 결과와 대조(불일치 환기)
    if (hasEvidence(input.acmgEvidence)) {
      const rule = acmgClassify(input.acmgEvidence!);
      if (rule !== cited.significance) caveats.push(`ACMG 규칙 결과(${rule})와 근거 DB 유의성(${cited.significance})이 다릅니다 — 판독자가 조정하세요.`);
    }
  } else if (hasEvidence(input.acmgEvidence)) {
    suggested = acmgClassify(input.acmgEvidence!);
    const e = input.acmgEvidence!;
    const parts: string[] = [];
    if (e.pvs) parts.push(`PVS(매우강함) ${e.pvs}`);
    if (e.strongP) parts.push(`Strong(강함) ${e.strongP}`);
    if (e.moderateP) parts.push(`Moderate(중간) ${e.moderateP}`);
    if (e.supportingP) parts.push(`Supporting(지지) ${e.supportingP}`);
    if (e.standaloneB || e.strongB || e.supportingB) parts.push('양성 근거 포함');
    rationale.push(`ACMG/AMP 근거 조합(${parts.join(' · ')}) → 규칙 기반 분류 «${suggested}»`);
    confidence = suggested === 'VUS' ? 'moderate' : 'high';
  } else if (input.classification) {
    suggested = input.classification;
    rationale.push(`입력된 잠정 분류(${input.classification})를 기준으로 삼음 — ACMG 근거 카운트가 없어 규칙 재계산은 생략`);
    confidence = 'low';
    caveats.push('ACMG 근거(PVS/Strong/Moderate/Supporting)를 입력하면 규칙 기반 분류를 재계산해 근거를 명확히 할 수 있습니다.');
  } else {
    suggested = 'VUS';
    rationale.push('분류 근거·잠정 분류가 없어 기본값 VUS로 제안 — 추가 근거 수집 필요');
    confidence = 'low';
  }

  // ② 유전자 맥락
  let clinicalSignificance: string;
  if (kb) {
    rationale.push(`${gene}: ${kb.role}. 연관 질환: ${kb.conditions}`);
    if (somatic && kb.somaticTherapy) {
      therapyImplications.push(`${gene} — ${kb.somaticTherapy}`);
      rationale.push('종양(체세포) 검사 맥락 — 표적치료 시사점을 함께 제시');
    }
    if (kb.germline && !somatic) {
      caveats.push(`${gene}은 유전성 질환(${kb.conditions})과 연관 — 병원성/유력병원성이면 유전상담·가족력 확인·재접촉 정책을 검토하세요.`);
    }
    clinicalSignificance =
      `${gene} 변이는 ${kb.conditions}과 연관됩니다(${kb.role}). ` +
      (suggested === 'Pathogenic' || suggested === 'Likely Pathogenic'
        ? '병원성 방향으로 제안된 분류를 고려할 때 임상적 유의성이 높을 수 있습니다.'
        : suggested === 'VUS'
          ? '현재 근거로는 임상적 유의성이 불확실(VUS)하여 추가 근거·기능연구·가족 분리분석이 필요할 수 있습니다.'
          : '양성 방향으로 제안되어 일반적으로 임상적 조치 대상이 아닐 수 있습니다.');
  } else {
    clinicalSignificance =
      (gene ? `${gene}` : '해당 변이') +
      '은 내장 지식기반에 등재되지 않았습니다 — 임상적 유의성은 최신 문헌·데이터베이스(ClinVar·gnomAD 등)와 판독 전문가 검토로 확정하세요.';
    caveats.push('지식기반 미등재 유전자입니다. 자동 시사점 없이 근거 확인이 필요합니다.');
  }

  // ②-b 근거 DB 부가정보 — 집단빈도·종양 actionability
  if (afN != null) {
    rationale.push(`gnomAD 집단 대립빈도 ${(afN * 100).toPrecision(3)}%`);
    if (afN >= 0.01) caveats.push(`집단 빈도가 높습니다(${(afN * 100).toPrecision(3)}%) — 흔한 변이로 병원성 가능성이 낮을 수 있습니다(BA1/BS1 고려).`);
  }
  if (cited?.oncokbLevel) {
    therapyImplications.push(`OncoKB ${cited.oncokbLevel}${cited.condition ? ` (${cited.condition})` : ''} — actionable 근거 등재`);
    rationale.push(`OncoKB actionability: ${cited.oncokbLevel}`);
  }

  // ③ VAF/접합자 맥락
  if (input.vaf != null) {
    if (somatic) {
      if (input.vaf < 5) caveats.push(`VAF ${input.vaf}%가 낮습니다 — 서브클론/오염/시퀀싱 노이즈 가능성을 감안하세요.`);
      else rationale.push(`VAF ${input.vaf}% — 종양 세포분율·클론성 해석에 참고`);
    } else if (input.vaf < 30 || input.vaf > 70) {
      caveats.push(`생식세포 검사에서 VAF ${input.vaf}%는 전형적 이형접합(~50%)에서 벗어남 — 모자이시즘/CNV/검사 아티팩트 가능성 확인.`);
    }
  }
  if (input.zygosity) rationale.push(`접합자 상태: ${input.zygosity}`);

  if (!cited) caveats.push('변이 임상근거 DB(ClinVar/gnomAD/OncoKB)에 등재된 인용을 찾지 못했습니다 — 근거는 최신 데이터베이스에서 직접 확인하세요.');
  caveats.push('본 초안은 지식기반·ACMG 규칙 간소화·반입된 근거 DB에 기반합니다. 최신 가이드라인과 대조해 확정하세요.');

  // ④ 초안 문단(판독란 붙여넣기용)
  const draftNarrative = [
    `[AI 해석 초안] ${gene || '변이'}${input.hgvsP ? ` ${input.hgvsP}` : input.hgvsC ? ` ${input.hgvsC}` : ''}`,
    `제안 분류: ${suggested} (신뢰도 ${confidence === 'high' ? '높음' : confidence === 'moderate' ? '보통' : '낮음'})`,
    cited?.significance ? `근거: ${cited.source ?? 'DB'} ${cited.significance}${starN != null ? ` (${starN}★)` : ''}${cited.citation ? ` · ${cited.citation}` : ''}${afN != null ? ` · gnomAD ${(afN * 100).toPrecision(3)}%` : ''}` : '',
    clinicalSignificance,
    therapyImplications.length ? `표적치료 시사점: ${therapyImplications.join('; ')}` : '',
    caveats.length ? `주의: ${caveats.join(' ')}` : '',
    '※ 본 문단은 자동 생성 초안이며 판독 전문가 검토·확정이 필요합니다.',
  ].filter(Boolean).join('\n');

  return {
    suggestedClassification: suggested,
    confidence,
    geneContext: kb ? { gene, role: kb.role, conditions: kb.conditions, actionable: !!kb.somaticTherapy } : null,
    citedEvidence: cited ?? null,
    rationale,
    clinicalSignificance,
    therapyImplications,
    caveats,
    disclaimer: DISCLAIMER,
    draftNarrative,
  };
}
