/**
 * 수혈 출고 적격성 근거 종합 번들(Domain, 순수 함수).
 *
 * 근거 종합 번들 패턴(유전체·미생물·병리·진단검사)을 수혈 출고에 적용한다.
 * (환자, 제제) 한 쌍의 출고 판단 근거를 **한 곳에** 모은다:
 *  ABO/RhD 판정 이력과 독립 2회 확인 충족 여부 · 교차시험 결과와 경과시간(72h 유효창) ·
 *  ABO 독립검증(2차 방벽) 결과 · 특수수혈 요구 대 제제 속성 · 동정 항체 대 항원음성 매칭 ·
 *  제제 상태·유효기간·회수격리.
 *
 * ★왜 필요한가: 이전엔 출고를 **시도해야만** 차단 사유를 알 수 있었다(예외로 튀어나옴).
 * 조작자가 제제를 들고 온 뒤에야 "교차시험 만료"를 아는 식이다. 또 사유 문구만으론
 * "얼마나 지났는지·몇 회 일치했는지" 같은 수치 근거를 알 수 없다.
 *
 * ★안전 원칙: 판정은 서비스의 evaluateIssueEligibility 정본이 하고, 이 함수는 **조립·설명만** 한다.
 * 여기서 적격성을 다시 계산하지 않는다(복제하면 실제 게이트와 갈릴 수 있다 — 그 자체가 위험).
 * 순수·로컬, 외부 전송 없음.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export interface TypingEvidence {
  abo: string | null; rhD: string | null; testedDt: string | null; tester: string | null; antibodyId: string | null;
}
export interface CrossmatchEvidence {
  result: string | null; method: string | null; tester: string | null;
  testedDt: string; ageHours: number | null; expired: boolean;
}
export interface UnitEvidence {
  unitNo: string; bloodGroup: string | null; productType: string | null;
  status: string | null; expiryDate: string | null;
  recallStatus: string | null; recallReason: string | null;
  attributes: string[]; antigenNeg: string | null;
}

export interface TransfusionEvidenceContextInput {
  patient: { patientId: string; name: string };
  unit: UnitEvidence;
  typings: TypingEvidence[];
  concordantCount: number;
  aboVerifiedTwice: boolean;
  aboMatchesHistory: boolean;
  crossmatch: CrossmatchEvidence | null;
  independentAboResult: string | null;
  specialRequired: string[];
  requiredFromProfile: string[];
  identifiedAntibodies: string | null;
  antigenCompatible: boolean;
  antigenMissing: string[];
  softReasons: string[];
  hardReasons: string[];
  blockers: string[];
}

export interface TransfusionEvidenceContext {
  patient: { patientId: string; name: string };
  unit: UnitEvidence;
  abo: { latest: string | null; typingCount: number; concordantCount: number; verifiedTwice: boolean; matchesHistory: boolean; independentResult: string | null };
  crossmatch: CrossmatchEvidence | null;
  special: { required: string[]; fromProfile: string[]; unitAttributes: string[]; missing: string[] };
  antigen: { identifiedAntibodies: string | null; compatible: boolean; missing: string[] };
  /** 출고 가능 여부(정본 판정 결과의 요약) */
  eligible: boolean;
  /** 응급 시 사후처리 조건으로 우회 가능한 사유 */
  softReasons: string[];
  /** 응급에도 불가침인 사유 */
  hardReasons: string[];
  /** 차단 사유를 수치 근거로 풀어 쓴 설명 */
  blockerExplanations: string[];
  sources: string[];
  promptContext: string;
  llmNote: string;
}

function line(label: string, v: string | number | null | undefined): string {
  return v == null || v === '' ? '' : `${label}: ${v}`;
}

/** 차단 사유를 실제 수치 근거로 풀어 설명(사유 문구만으론 "얼마나/몇 회"를 알 수 없다). */
function explainBlockers(input: TransfusionEvidenceContextInput): string[] {
  const out: string[] = [];
  for (const b of input.blockers) {
    if (b.includes('ABO 2회 확인 미완료')) {
      out.push(`${b} — 동일 판정 ${input.concordantCount}회(2회 필요), 총 검사 ${input.typings.length}건`);
    } else if (b.includes('교차시험 72시간 초과')) {
      out.push(`${b} — 교차시험 ${input.crossmatch?.testedDt ?? '?'} 시행, ${input.crossmatch?.ageHours ?? '?'}시간 경과(한계 72h)`);
    } else if (b.includes('교차시험 부적합/미완료')) {
      out.push(input.crossmatch ? `${b} — 최근 교차시험 결과 '${input.crossmatch.result ?? '없음'}'('적합'만 통과)` : `${b} — 이 제제에 대한 교차시험 기록 없음`);
    } else if (b.includes('특수요구 미충족')) {
      out.push(`${b} — 요구 [${input.specialRequired.join(', ') || '없음'}] vs 제제 속성 [${input.unit.attributes.join(', ') || '없음'}]`);
    } else if (b.includes('항원 부적합')) {
      out.push(`${b} — 동정 항체 '${input.identifiedAntibodies ?? '없음'}', 제제 항원음성 '${input.unit.antigenNeg ?? '미표기'}'`);
    } else if (b.includes('혈액형이 과거 이력과 불일치')) {
      out.push(`${b} — 이력 ${input.typings.map((t) => `${t.abo}/${t.rhD}`).join(', ')}`);
    } else if (b.includes('유효기간 만료')) {
      out.push(`${b} — 오늘 기준 만료(제제 ${input.unit.unitNo})`);
    } else {
      out.push(b);
    }
  }
  return out;
}

export function buildTransfusionEvidenceContext(input: TransfusionEvidenceContextInput): TransfusionEvidenceContext {
  const latest = input.typings[0] ?? null;
  const latestBg = latest ? `${latest.abo ?? '?'} ${latest.rhD ?? '?'}` : null;
  const missingSpecial = input.specialRequired.filter((r) => !input.unit.attributes.includes(r));
  const blockerExplanations = explainBlockers(input);
  const eligible = input.blockers.length === 0;

  const sources: string[] = [];
  if (input.typings.length) sources.push(`혈액형 ${input.typings.length}건`);
  if (input.crossmatch) sources.push('교차시험');
  if (input.independentAboResult) sources.push('ABO 독립검증(2차 방벽)');
  if (input.specialRequired.length) sources.push('특수수혈 요구');
  if (input.identifiedAntibodies) sources.push('동정 항체');

  const ctx = [
    '# 수혈 출고 적격성 근거 종합(로컬)',
    '## 환자·제제',
    line('환자', `${input.patient.name}(${input.patient.patientId})`),
    line('제제', `${input.unit.unitNo} · ${input.unit.bloodGroup ?? '?'} · ${input.unit.productType ?? '?'}`),
    line('제제 상태', input.unit.status),
    line('유효기간', input.unit.expiryDate),
    input.unit.recallStatus ? line('회수/격리', `${input.unit.recallStatus} ${input.unit.recallReason ?? ''}`) : '',
    '## ABO/RhD',
    line('최신 판정', latestBg),
    line('독립 2회 확인', `${input.aboVerifiedTwice ? '충족' : '미충족'}(동일 판정 ${input.concordantCount}회 / 총 ${input.typings.length}건)`),
    line('이력 일치', input.aboMatchesHistory ? '일치' : '불일치'),
    input.independentAboResult ? line('독립검증(2차 방벽)', input.independentAboResult) : '',
    '## 교차시험',
    input.crossmatch
      ? line('결과', `${input.crossmatch.result ?? '?'} · ${input.crossmatch.testedDt} · ${input.crossmatch.ageHours}시간 경과${input.crossmatch.expired ? '(72h 초과)' : ''}`)
      : '기록 없음',
    input.specialRequired.length ? '## 특수수혈 요구' : '',
    input.specialRequired.length ? line('요구', `${input.specialRequired.join(', ')}${input.requiredFromProfile.length ? ` (환자 프로파일: ${input.requiredFromProfile.join(', ')})` : ''}`) : '',
    input.specialRequired.length ? line('제제 속성', input.unit.attributes.join(', ') || '없음') : '',
    missingSpecial.length ? line('미충족', missingSpecial.join(', ')) : '',
    input.identifiedAntibodies ? '## 동종면역(항원음성 매칭)' : '',
    input.identifiedAntibodies ? line('동정 항체', input.identifiedAntibodies) : '',
    input.identifiedAntibodies ? line('제제 항원음성', input.unit.antigenNeg ?? '미표기') : '',
    input.identifiedAntibodies ? line('적합', input.antigenCompatible ? '예' : `아니오(미확인 ${input.antigenMissing.join(',')})`) : '',
    `## 판정: ${eligible ? '출고 가능' : '출고 차단'}`,
    ...blockerExplanations.map((b) => `- ${b}`),
    input.hardReasons.length ? `(불가침 사유 ${input.hardReasons.length}건 — 응급에도 우회 불가)` : '',
    '## 지시',
    '위 근거만 사용해 출고 판단 요약을 작성하되, 근거에 없는 사실을 만들지 말 것. ' +
      '차단 사유가 있으면 그 수치 근거(경과시간·일치 횟수 등)를 인용하고, 불가침 사유는 응급에도 우회 불가임을 명시하며, ' +
      '최종 확정은 수혈 담당자·의사의 2인 확인 절차임을 명시할 것.',
  ].filter(Boolean).join('\n');

  return {
    patient: input.patient,
    unit: input.unit,
    abo: { latest: latestBg, typingCount: input.typings.length, concordantCount: input.concordantCount, verifiedTwice: input.aboVerifiedTwice, matchesHistory: input.aboMatchesHistory, independentResult: input.independentAboResult },
    crossmatch: input.crossmatch,
    special: { required: input.specialRequired, fromProfile: input.requiredFromProfile, unitAttributes: input.unit.attributes, missing: missingSpecial },
    antigen: { identifiedAntibodies: input.identifiedAntibodies, compatible: input.antigenCompatible, missing: input.antigenMissing },
    eligible,
    softReasons: input.softReasons,
    hardReasons: input.hardReasons,
    blockerExplanations,
    sources,
    promptContext: ctx,
    llmNote:
      '온프레미스 LLM 미구성 — 출고 적격성 판정은 안전게이트(evaluateIssueEligibility) 정본이 산출하며 LLM이 대체하지 않습니다. ' +
      '이 번들은 향후 원내 호스팅 모델(RAG)의 컨텍스트로 사용됩니다(외부 전송 없음).',
  };
}
