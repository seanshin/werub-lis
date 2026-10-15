/**
 * 진단검사 결과 근거 종합 번들(Domain, 순수 함수).
 *
 * 근거 종합 번들 패턴(유전체·미생물·병리)을 진단검사 결과 검증에 적용한다.
 * 검사자가 결과를 검증할 때 필요한 근거를 **한 곳에** 모은다:
 *  값·단위·판정(H/L/HH/LL) · 적용된 참고치와 그 선택 근거(성별·연령대) · 패닉 임계 ·
 *  델타체크(직전값 대비 변화) · 보류 사유 · QC 상태 · 검체 품질(HIL) · 최근 추세.
 *
 * ★왜 필요한가: "왜 이 결과가 H로 뜨는가/왜 자동검증이 막혔는가"의 근거가 여러 곳(참고치 마스터·
 * 이전 결과·QC·HIL)에 흩어져 있어, 검사자가 매번 짜맞춰야 했다. 보류 사유 코드(DELTA/QC 등)만으론
 * **무엇과 비교해 얼마나 벗어났는지**를 알 수 없다.
 *
 * 두 가지로 쓴다.
 *  ① 지금: 검증 판단 근거를 한 화면에서(수동검증 속도·정확성).
 *  ② 나중: 원내 LLM(RAG)이 이 번들(promptContext)만 받아 검증 코멘트·해석문 초안을 쓴다.
 *
 * ★설계 원칙: 순수·로컬. 외부 전송 없음. 판정(flag·holdReason)은 이미 확정·저장돼 있고,
 * 이 함수는 그 근거를 조립·설명만 한다(재판정하지 않음).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export interface RefRangeEvidence {
  sex: string; ageMin: number; ageMax: number;
  low: number | null; high: number | null;
  panicLow: number | null; panicHigh: number | null;
}
export interface DeltaEvidence {
  hasPrev: boolean; prev: number | null; absDelta: number | null; pctDelta: number | null; exceeded: boolean;
  prevReportedDt: string | null;
}
export interface TrendPoint { value: string | null; flag: string | null; reportedDt: string | null }

export interface ResultEvidenceContextInput {
  resultId: string;
  testCode: string;
  testName: string | null;
  value: string | null;
  unit: string | null;
  flag: string | null;
  verifyState: string | null;
  holdReason: string | null;
  source: string | null;          // INSTRUMENT/MANUAL/DOCUMENT
  instrument: string | null;
  dilutionFactor: number | null;
  rerun: boolean;
  comment: string | null;
  patientSex: string | null;
  patientAge: number | null;
  refRange: RefRangeEvidence | null;
  delta: DeltaEvidence | null;
  qcOk: boolean | null;
  hil: { hemolysis: string | null; icterus: string | null; lipemia: string | null } | null;
  /** 이 검사에 대한 HIL 간섭(해당 등급이 이 검사 값을 왜곡하는가) — 없으면 null */
  hilInterference: { factors: string[]; message: string } | null;
  trend: TrendPoint[];
}

export interface ResultEvidenceContext {
  result: { resultId: string; testCode: string; testName: string | null; value: string | null; unit: string | null; flag: string | null; verifyState: string | null; holdReason: string | null };
  refRange: RefRangeEvidence | null;
  /** 참고치가 왜 이 구간인지(성별·연령 근거) */
  refBasis: string | null;
  delta: DeltaEvidence | null;
  qcOk: boolean | null;
  hil: { hemolysis: string | null; icterus: string | null; lipemia: string | null } | null;
  hilInterference: { factors: string[]; message: string } | null;
  trend: TrendPoint[];
  /** 보류 사유를 근거 수치로 풀어 쓴 설명(코드만으론 알 수 없던 부분) */
  holdExplanation: string | null;
  sources: string[];
  promptContext: string;
  llmNote: string;
}

function line(label: string, v: string | number | null | undefined): string {
  return v == null || v === '' ? '' : `${label}: ${v}`;
}
const sexLabel = (s: string): string => (s === 'M' ? '남' : s === 'F' ? '여' : '전체');

/** 참고치 선택 근거 — 어떤 성별·연령대 구간이 적용됐는지. */
function describeRefBasis(r: RefRangeEvidence | null): string | null {
  if (!r) return null;
  return `${sexLabel(r.sex)} · ${r.ageMin}~${r.ageMax}세 구간 적용`;
}

/** 보류 사유를 실제 수치 근거로 풀어 설명(예: DELTA → 직전 3.2 → 현재 9.8, +206%). */
function explainHold(input: ResultEvidenceContextInput): string | null {
  const { holdReason: h, delta, refRange: r, value } = input;
  if (!h) return null;
  switch (h) {
    case 'DELTA':
      return delta?.hasPrev
        ? `직전 ${delta.prev} → 현재 ${value}${input.unit ? ` ${input.unit}` : ''} (변화 ${delta.absDelta}${delta.pctDelta != null ? `, ${delta.pctDelta}%` : ''}) — 델타 한계 초과로 자동검증 차단`
        : '델타 한계 초과로 자동검증 차단(직전값 정보 없음)';
    case 'CRITICAL': {
      const th = r ? [r.panicLow != null ? `패닉저 ${r.panicLow}` : '', r.panicHigh != null ? `패닉고 ${r.panicHigh}` : ''].filter(Boolean).join(' / ') : '';
      return `위험치(panic) 범위 — 현재 ${value}${input.unit ? ` ${input.unit}` : ''}${th ? ` (임계 ${th})` : ''} · 폐루프 통보 대상`;
    }
    case 'QC':
      return '해당 검사·장비의 최신 QC가 FAIL — QC 시정 전 자동검증 차단';
    case 'INSTRUMENT':
      return '장비 오류 플래그 — 재검·장비 점검 대상';
    case 'NONNUMERIC':
      return '수치가 아닌 결과 — 자동 판정 대상 아님(수동 검증)';
    case 'NO_RANGE':
      return '참고치 미등록 검사 — 판정 근거 없음(마스터 등록 필요)';
    case 'POLICY':
      return '자동검증 정책상 수동검증 대상';
    case 'SENDOUT':
      return '위탁(수탁) 검사 — 수탁기관 회신값 검증 대상';
    default:
      return `보류 사유 ${h}`;
  }
}

export function buildResultEvidenceContext(input: ResultEvidenceContextInput): ResultEvidenceContext {
  const refBasis = describeRefBasis(input.refRange);
  const holdExplanation = explainHold(input);

  const sources: string[] = [];
  if (input.refRange) sources.push('참고치 마스터');
  if (input.delta?.hasPrev) sources.push('직전 결과(델타)');
  if (input.qcOk != null) sources.push(`QC ${input.qcOk ? 'PASS' : 'FAIL'}`);
  if (input.hil && (input.hil.hemolysis || input.hil.icterus || input.hil.lipemia)) sources.push('검체 품질(HIL)');
  if (input.hilInterference) sources.push('HIL 간섭 경고');
  if (input.trend.length) sources.push(`추세 ${input.trend.length}건`);

  const r = input.refRange;
  const ctx = [
    '# 진단검사 결과 근거 종합(로컬)',
    '## 결과',
    line('검사', `${input.testName ?? ''}(${input.testCode})`),
    line('값', `${input.value ?? ''}${input.unit ? ` ${input.unit}` : ''}`),
    line('판정', input.flag),
    line('상태', input.verifyState),
    line('출처', input.source === 'INSTRUMENT' ? `장비${input.instrument ? `(${input.instrument})` : ''}` : input.source === 'MANUAL' ? '수기입력' : input.source),
    input.dilutionFactor != null ? line('희석배수', input.dilutionFactor) : '',
    input.rerun ? '재검: 예' : '',
    input.comment ? line('기술 코멘트', input.comment) : '',
    '## 환자',
    [line('성별', input.patientSex), line('나이', input.patientAge != null ? `${input.patientAge}세` : null)].filter(Boolean).join(' · '),
    r ? '## 적용 참고치' : '',
    r ? line('정상범위', `${r.low ?? '-'} ~ ${r.high ?? '-'}${input.unit ? ` ${input.unit}` : ''}`) : '',
    r && (r.panicLow != null || r.panicHigh != null) ? line('패닉 임계', `${r.panicLow ?? '-'} / ${r.panicHigh ?? '-'}`) : '',
    refBasis ? line('선택 근거', refBasis) : '',
    input.delta?.hasPrev ? '## 델타체크(직전 대비)' : '',
    input.delta?.hasPrev ? line('직전값', `${input.delta.prev}${input.delta.prevReportedDt ? ` (${input.delta.prevReportedDt})` : ''}`) : '',
    input.delta?.hasPrev ? line('변화', `${input.delta.absDelta}${input.delta.pctDelta != null ? ` (${input.delta.pctDelta}%)` : ''}${input.delta.exceeded ? ' — 한계 초과' : ''}`) : '',
    input.qcOk != null ? line('QC 상태', input.qcOk ? 'PASS' : 'FAIL(차단)') : '',
    input.hil && (input.hil.hemolysis || input.hil.icterus || input.hil.lipemia)
      ? line('검체 품질(HIL)', [input.hil.hemolysis ? `용혈 ${input.hil.hemolysis}` : '', input.hil.icterus ? `황달 ${input.hil.icterus}` : '', input.hil.lipemia ? `지질 ${input.hil.lipemia}` : ''].filter(Boolean).join(' · '))
      : '',
    input.hilInterference ? `## HIL 간섭(이 검사에 영향)\n${input.hilInterference.message}` : '',
    holdExplanation ? `## 보류 사유\n${holdExplanation}` : '',
    input.trend.length ? '## 최근 추세' : '',
    ...input.trend.map((t) => `- ${t.reportedDt ?? '?'} ${t.value ?? ''}${t.flag && t.flag !== 'N' ? ` [${t.flag}]` : ''}`),
    '## 지시',
    '위 근거만 사용해 결과 검증 코멘트·해석문 초안을 작성하되, 근거에 없는 사실을 만들지 말 것. ' +
      '보류 사유가 있으면 그 수치 근거를 인용하고, 검체 품질(HIL)이 값에 미칠 영향을 반영하며, 확정은 검사자·의사 판단임을 명시할 것.',
  ].filter(Boolean).join('\n');

  return {
    result: { resultId: input.resultId, testCode: input.testCode, testName: input.testName, value: input.value, unit: input.unit, flag: input.flag, verifyState: input.verifyState, holdReason: input.holdReason },
    refRange: input.refRange,
    refBasis,
    delta: input.delta,
    qcOk: input.qcOk,
    hil: input.hil,
    hilInterference: input.hilInterference,
    trend: input.trend,
    holdExplanation,
    sources,
    promptContext: ctx,
    llmNote:
      '온프레미스 LLM 미구성 — 현재는 참고치·델타·QC 엔진이 근거를 산출하고, 검증 코멘트는 검사자가 작성합니다. ' +
      '이 번들은 향후 원내 호스팅 모델(RAG)의 컨텍스트로 그대로 사용됩니다(외부 전송 없음).',
  };
}
