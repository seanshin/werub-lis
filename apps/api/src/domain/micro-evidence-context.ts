/**
 * 미생물 감수성(AST) 근거 종합 번들(Domain, 순수 함수).
 *
 * 유전체 근거 종합 번들(genomic-evidence-context)과 같은 패턴을 미생물에 적용한다.
 * 한 분리주(isolate)의 경험적/표적 항생제 선택 근거를 **한 곳에** 모은다:
 *  균 동정 · 검체원 · MIC→S/I/R 판정(브레이크포인트·기준 버전) · expert-rule 경고(고유내성 등) ·
 *  MDRO 분류 · 법정감염병 여부 · 환자 과거 내성 이력.
 *
 * 두 가지로 쓴다.
 *  ① 지금: 미생물 검사자·임상의가 흩어진 근거를 한 화면에서 검토(항생제 선택 판단 보조).
 *  ② 나중: 원내 LLM(RAG)이 이 번들(promptContext)만 받아 경험적 치료 코멘트 초안을 쓴다(근거 밖 생성 억제).
 *
 * ★설계 원칙: 순수·로컬. 외부 전송 없음. 판정 자체는 기존 판정엔진(interpretMic)이 이미 확정했고,
 * 이 함수는 그 근거를 조립만 한다(재판정하지 않음 — 확정값은 Susceptibility에 저장됨).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export interface MicroSusEvidence {
  antibiotic: string | null;
  mic: string | null;
  interpretation: string | null; // S/I/R
  method: string | null;         // MIC/DISK/GRADIENT
  standard: string | null;       // 판정기준·버전(CLSI/EUCAST)
  breakpointNote?: string | null; // 브레이크포인트 요약(S≤a / R≥b) 또는 미정의 사유
}
export interface AstWarningLite { antibiotic: string; rule: string; message: string }
export interface PriorResistance {
  organism: string | null;
  antibiotic: string | null;
  interpretation: string | null;
  specimenNo: string | null;
  reportedDate: string | null;
}

export interface MicroEvidenceContextInput {
  organism: string | null;
  specimenType: string | null;
  specimenNo: string | null;
  susceptibilities: MicroSusEvidence[];
  warnings: AstWarningLite[];
  mdro: { mdro: string | null; isolation: boolean };
  notifiable: { reportable: boolean; disease?: string | null; grade?: string | null };
  priorResistance: PriorResistance[];
  standard: string | null; // 활성 브레이크포인트 카탈로그 버전
}

export interface MicroEvidenceContext {
  isolate: { organism: string | null; specimenType: string | null; specimenNo: string | null };
  susceptibilities: MicroSusEvidence[];
  warnings: AstWarningLite[];
  mdro: { mdro: string | null; isolation: boolean };
  notifiable: { reportable: boolean; disease?: string | null; grade?: string | null };
  priorResistance: PriorResistance[];
  sources: string[];
  promptContext: string;
  llmNote: string;
}

function line(label: string, v: string | number | null | undefined): string {
  return v == null || v === '' ? '' : `${label}: ${v}`;
}

export function buildMicroEvidenceContext(input: MicroEvidenceContextInput): MicroEvidenceContext {
  const sources: string[] = [];
  if (input.standard) sources.push(`브레이크포인트 ${input.standard}`);
  if (input.warnings.length) sources.push('expert-rule(고유내성 등)');
  if (input.mdro.mdro) sources.push(`MDRO ${input.mdro.mdro}`);
  if (input.notifiable.reportable) sources.push('법정감염병');
  if (input.priorResistance.length) sources.push('과거 내성 이력');

  const susLines = input.susceptibilities.map(
    (s) => `- ${s.antibiotic ?? '?'}: ${s.interpretation ?? '판정없음'}${s.mic ? ` (MIC ${s.mic})` : ''}${s.method ? ` [${s.method}]` : ''}${s.breakpointNote ? ` · ${s.breakpointNote}` : ''}`,
  );
  const ctx = [
    '# 미생물 감수성 근거 종합(로컬)',
    '## 분리주',
    line('균종', input.organism),
    line('검체원', input.specimenType),
    line('검체번호', input.specimenNo),
    line('판정기준', input.standard),
    input.mdro.mdro ? line('MDRO', `${input.mdro.mdro}${input.mdro.isolation ? ' · 격리필요' : ''}`) : '',
    input.notifiable.reportable ? line('법정감염병', `${input.notifiable.disease ?? ''}${input.notifiable.grade ? `(${input.notifiable.grade})` : ''}`) : '',
    '## 감수성(MIC→S/I/R)',
    ...susLines,
    input.warnings.length ? '## expert-rule 경고(입력·표현형 재확인)' : '',
    ...input.warnings.map((w) => `- [${w.rule}] ${w.antibiotic}: ${w.message}`),
    input.priorResistance.length ? '## 환자 과거 내성 이력' : '',
    ...input.priorResistance.map((p) => `- ${p.reportedDate ?? '?'} ${p.organism ?? ''} ${p.antibiotic ?? ''} ${p.interpretation ?? ''} (${p.specimenNo ?? ''})`),
    '## 지시',
    '위 근거만 사용해 경험적/표적 항생제 선택 코멘트 초안을 작성하되, 근거에 없는 사실을 만들지 말 것. ' +
      '고유내성·법정감염병·과거 내성 이력을 반드시 반영하고, 확정은 미생물 전문가 판단임을 명시할 것.',
  ].filter(Boolean).join('\n');

  return {
    isolate: { organism: input.organism, specimenType: input.specimenType, specimenNo: input.specimenNo },
    susceptibilities: input.susceptibilities,
    warnings: input.warnings,
    mdro: input.mdro,
    notifiable: input.notifiable,
    priorResistance: input.priorResistance,
    sources,
    promptContext: ctx,
    llmNote:
      '온프레미스 LLM 미구성 — 현재는 판정엔진(브레이크포인트)·expert-rule이 근거를 산출하고, 해석 코멘트는 전문가가 작성합니다. ' +
      '이 번들은 향후 원내 호스팅 모델(RAG)의 컨텍스트로 그대로 사용됩니다(외부 전송 없음).',
  };
}
