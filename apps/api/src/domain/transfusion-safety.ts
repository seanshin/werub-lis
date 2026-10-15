/**
 * 수혈 출고 전 안전 검증 — 근거: 04 파트A(A-3 안전규칙), 07 §11.2.
 * 출고 게이트: 하나라도 위배 시 출고 차단.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export interface IssueCheckInput {
  aboVerifiedTwice: boolean; // ABO 2회(서로 다른 시점/검체) 확인
  aboMatchesHistory: boolean; // 현재 혈액형 == 과거 이력
  crossmatchResult: string | null; // '적합' | '부적합'
  expiryDate: string; // 제제 유효기간 YYYY-MM-DD
  now: string; // 기준일 YYYY-MM-DD
  specialRequired: string[]; // 처방 특수요구(방사선조사/CMV음성 등)
  unitAttributes: string[]; // 제제 속성
}

export interface IssueCheckResult {
  eligible: boolean;
  reasons: string[]; // 차단 사유(있으면 부적격)
}

export function checkIssueEligibility(input: IssueCheckInput): IssueCheckResult {
  const reasons: string[] = [];

  if (!input.aboVerifiedTwice) reasons.push('ABO 2회 확인 미완료');
  if (!input.aboMatchesHistory) reasons.push('현재 혈액형이 과거 이력과 불일치');
  if (input.crossmatchResult !== '적합') reasons.push('교차시험 부적합/미완료');
  if (input.expiryDate < input.now) reasons.push('제제 유효기간 만료');

  const missing = input.specialRequired.filter((req) => !input.unitAttributes.includes(req));
  if (missing.length > 0) reasons.push(`특수요구 미충족: ${missing.join(', ')}`);

  return { eligible: reasons.length === 0, reasons };
}

// ── 교차시험 혈청학적 판정 (04 A-3, 07 §11.2) ──────────────────────────────
export type Abo = 'A' | 'B' | 'O' | 'AB';
export type RhD = 'POS' | 'NEG';

/**
 * 교차시험 판정값 정본. '추가검사필요'는 항체양성 → AHG 교차가 필요한 경우로,
 * 자동 판정(determineCrossmatch)이 실제로 쓰는 값이다. DTO가 2값만 허용하면
 * **그 상태를 수기로 기록할 수 없다**(실제로 그랬다).
 */
export const CROSSMATCH_RESULTS = ['적합', '부적합', '추가검사필요'] as const;
export type CrossmatchVerdict = typeof CROSSMATCH_RESULTS[number];

export const ABO_VALUES: readonly Abo[] = ['A', 'B', 'O', 'AB'];
export const RHD_VALUES: readonly RhD[] = ['POS', 'NEG'];

export function isAbo(v: unknown): v is Abo {
  return typeof v === 'string' && (ABO_VALUES as readonly string[]).includes(v);
}
export function isRhD(v: unknown): v is RhD {
  return typeof v === 'string' && (RHD_VALUES as readonly string[]).includes(v);
}

/**
 * BloodTyping 저장 전 ABO/RhD 열거값 강제 — 부적합 시 사유 문자열, 정상이면 null.
 * BloodTyping은 issueBlood의 ABO 독립방벽(불가침)이 읽는 정본이므로, 이 테이블에 쓰는
 * 모든 경로가 이 검증을 통과해야 한다. 열거 밖 값이 최신 레코드가 되면 방벽이 무력화된다.
 */
export function validateTypingValues(abo: unknown, rhD: unknown): string | null {
  if (!isAbo(abo)) return `ABO는 ${ABO_VALUES.join('/')} 중 하나여야 합니다: ${String(abo)}`;
  if (!isRhD(rhD)) return `RhD는 ${RHD_VALUES.join('/')} 중 하나여야 합니다: ${String(rhD)}`;
  return null;
}

/** 적혈구(RBC) 제제 ABO 적합: 수혜자 ← 공혈자 적혈구(항원)가 수혜자 혈장 항체와 비반응. */
const RBC_ABO_COMPAT: Record<Abo, Abo[]> = {
  O: ['O'],
  A: ['A', 'O'],
  B: ['B', 'O'],
  AB: ['A', 'B', 'O', 'AB'],
};
/** 혈장(FFP) ABO 적합: 공혈자 혈장 항체가 수혜자 적혈구(항원)와 비반응(RBC의 역방향). */
const PLASMA_ABO_COMPAT: Record<Abo, Abo[]> = {
  O: ['O', 'A', 'B', 'AB'],
  A: ['A', 'AB'],
  B: ['B', 'AB'],
  AB: ['AB'],
};

export interface CrossmatchInput {
  recipientAbo: Abo;
  recipientRhD: RhD;
  antibodyScreen: string; // 비예기항체 선별 — 'NEG'만 음성 인정(그 외는 fail-safe로 항체 있음 취급)
  unitAbo: Abo;
  unitRhD: RhD;
  productType?: string | null; // RBC(기본)/FFP·혈장/전혈 구분
}

export interface CrossmatchResult {
  result: '적합' | '부적합' | '추가검사필요'; // 추가검사필요 = 항체양성 → AHG 교차 필요(전자교차 불가)
  compatible: boolean; // 즉시 출고 가능 여부(적합만 true)
  method: string; // 판정 방법
  requiresAhg: boolean; // 항글로불린법(AHG) 추가 필요
  reasons: string[]; // 부적합/추가검사 사유
}

/**
 * 교차시험 혈청학적 판정 — ABO(제제유형별 방향성)·RhD·비예기항체선별로 적합성 결정.
 *  - ABO 부적합 또는 RhD 부적합(음성 환자에 양성 적혈구) → 부적합
 *  - 항체선별 양성 → 전자/즉시원심 교차 불가, AHG 교차 필요 → '추가검사필요'(자동 적합 금지)
 *  - 항체선별 음성 + ABO/RhD 적합 → '적합'(전자교차적합)
 * 혈장(FFP) 제제는 ABO 역방향 매트릭스, RhD 미적용.
 */
export function determineCrossmatch(input: CrossmatchInput): CrossmatchResult {
  const reasons: string[] = [];
  const pt = input.productType ?? '';
  const isPlasma = /FFP|PLASMA|혈장|FRESH/i.test(pt);
  // 전혈(Whole Blood)은 공혈자 혈장+적혈구 모두 수혈 → ABO **동일**만 적합(RBC 매트릭스로는 A←O를 허용해 위험).
  const isWholeBlood = /WHOLE|전혈|WB\b/i.test(pt);
  const matrix = isPlasma ? PLASMA_ABO_COMPAT : RBC_ABO_COMPAT;

  const aboCompatible = isWholeBlood
    ? input.recipientAbo === input.unitAbo
    : (matrix[input.recipientAbo]?.includes(input.unitAbo) ?? false);
  if (!aboCompatible) {
    reasons.push(
      isWholeBlood
        ? `ABO 부적합(전혈은 동일형만): 수혜자 ${input.recipientAbo} ← 제제 ${input.unitAbo}`
        : `ABO 부적합: 수혜자 ${input.recipientAbo}${isPlasma ? '(혈장)' : ''} ← 제제 ${input.unitAbo}`,
    );
  }

  // RhD: 혈장 제외 전 제제(적혈구·전혈) 적용. RhD 음성 환자에 RhD 양성 → 부적합(동종면역 위험).
  const rhCompatible = isPlasma || input.recipientRhD === 'POS' || input.unitRhD === 'NEG';
  if (!rhCompatible) reasons.push('RhD 부적합: RhD 음성 환자에 RhD 양성 제제');

  const serologicOk = aboCompatible && rhCompatible;

  // C2 fail-safe: 명시적 'NEG'만 음성으로 인정. 그 외(POS·오타·null)는 항체 있는 것으로 간주 → 전자교차 금지.
  if (input.antibodyScreen !== 'NEG') {
    // 비예기항체 양성 → 전자교차 불가. ABO/RhD가 맞아도 AHG 교차로 확인 필요.
    reasons.push('비예기항체 양성 — 항글로불린법(AHG) 교차시험 필요(전자교차 불가)');
    return {
      result: serologicOk ? '추가검사필요' : '부적합',
      compatible: false,
      method: '항글로불린법(AHG) 필요',
      requiresAhg: true,
      reasons,
    };
  }

  return {
    result: serologicOk ? '적합' : '부적합',
    compatible: serologicOk,
    method: '전자교차적합(즉시원심)',
    requiresAhg: false,
    reasons,
  };
}

/** 혈액형 문자열("A+","O-","AB+") → { abo, rhD }. 파싱 실패 시 null. */
export function parseBloodGroup(bg?: string | null): { abo: Abo; rhD: RhD } | null {
  if (!bg) return null;
  const m = /^(AB|A|B|O)\s*([+-]|POS|NEG)?$/i.exec(bg.trim());
  if (!m) return null;
  const abo = m[1].toUpperCase() as Abo;
  const sign = (m[2] ?? '').toUpperCase();
  const rhD: RhD = sign === '-' || sign === 'NEG' ? 'NEG' : 'POS';
  return { abo, rhD };
}
