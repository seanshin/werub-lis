/**
 * 병리 근거 종합 번들(Domain, 순수 함수).
 *
 * 근거 종합 번들 패턴(유전체·미생물)을 병리 케이스에 적용한다.
 * 한 케이스의 진단 근거를 **한 곳에** 모은다:
 *  검체부위·유형 · 진단/소견 · IHC/특수염색 패널 · 구조화 병기(TNM·ICD-O) ·
 *  synoptic(CAP 프로토콜) 필수요소 충족/결손 · 세포병리 분류(Bethesda 등) · 결속된 분자/체세포 소견.
 *
 * 두 가지로 쓴다.
 *  ① 지금: 판독의가 흩어진 근거(IHC·병기·synoptic·분자)를 한 화면에서 검토(진단·합성보고 판단 보조).
 *  ② 나중: 원내 LLM(RAG)이 이 번들(promptContext)만 받아 synoptic/진단 코멘트 초안을 쓴다(근거 밖 생성 억제).
 *
 * ★설계 원칙: 순수·로컬. 외부 전송 없음. 진단·병기 확정값은 이미 저장돼 있고, 이 함수는 근거를 조립만 한다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export interface IhcEvidence {
  marker: string | null;
  result: string | null;      // POS/NEG/EQUIVOCAL
  intensity: string | null;
  percentPos: number | null;
  score: string | null;
  interpretation: string | null;
}
export interface StagingEvidence {
  pT: string | null; pN: string | null; pM: string | null;
  stageGroup: string | null; icdoTopo: string | null; icdoMorph: string | null;
}
export interface LinkedFinding { kind: 'molecular' | 'somatic'; label: string }

export interface PathologyEvidenceContextInput {
  spNo: string;
  specimenSite: string | null;
  caseType: string | null;
  diagnosis: string | null;
  findings: string | null;
  ihc: IhcEvidence[];
  staging: StagingEvidence | null;
  synopticProtocol: string | null;
  synopticProtocolLabel: string | null;
  synopticValues: Record<string, string> | null;
  synopticRequired: string[];
  synopticMissing: string[];
  cytology: { specimenType: string | null; adequacy: string | null; category: string | null } | null;
  linked: LinkedFinding[];
}

export interface PathologyEvidenceContext {
  case: { spNo: string; specimenSite: string | null; caseType: string | null; diagnosis: string | null };
  ihc: IhcEvidence[];
  staging: StagingEvidence | null;
  synoptic: { protocol: string | null; label: string | null; required: string[]; missing: string[]; complete: boolean } | null;
  cytology: { specimenType: string | null; adequacy: string | null; category: string | null } | null;
  linked: LinkedFinding[];
  sources: string[];
  promptContext: string;
  llmNote: string;
}

function line(label: string, v: string | number | null | undefined): string {
  return v == null || v === '' ? '' : `${label}: ${v}`;
}

export function buildPathologyEvidenceContext(input: PathologyEvidenceContextInput): PathologyEvidenceContext {
  const synoptic = input.synopticProtocol
    ? { protocol: input.synopticProtocol, label: input.synopticProtocolLabel, required: input.synopticRequired, missing: input.synopticMissing, complete: input.synopticMissing.length === 0 }
    : null;

  const sources: string[] = [];
  if (input.ihc.length) sources.push(`IHC ${input.ihc.length}개`);
  if (input.staging && (input.staging.pT || input.staging.pN || input.staging.stageGroup)) sources.push('병기(TNM)');
  if (input.staging?.icdoMorph || input.staging?.icdoTopo) sources.push('ICD-O');
  if (synoptic) sources.push(`synoptic ${synoptic.label ?? synoptic.protocol}${synoptic.complete ? '' : `(결손 ${synoptic.missing.length})`}`);
  if (input.cytology?.category) sources.push('세포병리 분류');
  if (input.linked.length) sources.push(`분자/체세포 ${input.linked.length}건`);

  const ihcLines = input.ihc.map(
    (h) => `- ${h.marker ?? '?'}: ${h.result ?? h.interpretation ?? '판정없음'}${h.intensity ? ` 강도 ${h.intensity}` : ''}${h.percentPos != null ? ` ${h.percentPos}%` : ''}${h.score ? ` (${h.score})` : ''}`,
  );
  const st = input.staging;
  const ctx = [
    '# 병리 진단 근거 종합(로컬)',
    '## 케이스',
    line('검체부위', input.specimenSite),
    line('검체유형', input.caseType),
    line('진단', input.diagnosis),
    input.findings ? line('소견', input.findings.slice(0, 400)) : '',
    input.ihc.length ? '## IHC/특수염색' : '',
    ...ihcLines,
    st && (st.pT || st.pN || st.pM || st.stageGroup) ? '## 구조화 병기(AJCC TNM)' : '',
    st ? [line('pT', st.pT), line('pN', st.pN), line('pM', st.pM), line('병기군', st.stageGroup)].filter(Boolean).join(' · ') : '',
    st && (st.icdoTopo || st.icdoMorph) ? line('ICD-O', `${st.icdoTopo ?? ''} ${st.icdoMorph ?? ''}`.trim()) : '',
    synoptic ? `## synoptic(${synoptic.label ?? synoptic.protocol})` : '',
    synoptic ? (synoptic.complete ? '필수요소 충족' : `필수요소 결손: ${synoptic.missing.join(', ')}`) : '',
    synoptic && input.synopticValues ? Object.entries(input.synopticValues).filter(([, val]) => (val ?? '').toString().trim()).map(([k, val]) => `  - ${k}: ${val}`).join('\n') : '',
    input.cytology?.category ? '## 세포병리' : '',
    input.cytology ? [line('검체', input.cytology.specimenType), line('적정성', input.cytology.adequacy), line('분류', input.cytology.category)].filter(Boolean).join(' · ') : '',
    input.linked.length ? '## 결속된 분자/체세포 소견' : '',
    ...input.linked.map((l) => `- [${l.kind === 'molecular' ? '분자' : '체세포'}] ${l.label}`),
    '## 지시',
    '위 근거만 사용해 synoptic/진단 코멘트 초안을 작성하되, 근거에 없는 사실을 만들지 말 것. ' +
      'synoptic 필수요소 결손이 있으면 명시하고, IHC·병기·분자 소견을 진단 논리에 반영하며, 확정은 판독전문의 판단임을 명시할 것.',
  ].filter(Boolean).join('\n');

  return {
    case: { spNo: input.spNo, specimenSite: input.specimenSite, caseType: input.caseType, diagnosis: input.diagnosis },
    ihc: input.ihc,
    staging: input.staging,
    synoptic,
    cytology: input.cytology,
    linked: input.linked,
    sources,
    promptContext: ctx,
    llmNote:
      '온프레미스 LLM 미구성 — 현재는 synoptic 프로토콜 검증·구조화 병기가 근거를 산출하고, 진단 코멘트는 판독의가 작성합니다. ' +
      '이 번들은 향후 원내 호스팅 모델(RAG)의 컨텍스트로 그대로 사용됩니다(외부 전송 없음).',
  };
}
