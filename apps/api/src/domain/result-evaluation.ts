/**
 * 결과 평가 도메인 로직 (Domain) — LIS 핵심 규칙
 * 근거: 07_상세설계_기능상세.md §4 (결과 수집/자동검증)
 *
 * 순수 함수로 구현하여 단위 테스트·재사용이 용이하도록 한다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export type Sex = 'M' | 'F' | 'O' | 'U';
export type ResultFlag = 'N' | 'H' | 'L' | 'HH' | 'LL';

export interface RefRange {
  sex: string; // 'A' | 'M' | 'F'
  ageMin: number;
  ageMax: number;
  low: number | null;
  high: number | null;
  panicLow: number | null;
  panicHigh: number | null;
}

/**
 * (검사코드에 대한) 참고치 후보 중 환자 성별·연령에 맞는 1건 선택.
 * 성별은 정확 매칭 우선, 없으면 'A'(전체) 사용.
 */
export function pickReferenceRange(
  ranges: RefRange[],
  sex: Sex | null,
  age: number | null,
): RefRange | null {
  const bySex = (r: RefRange) => r.sex === sex || r.sex === 'A';
  // 나이 불명(생년월일 누락/파싱 실패)을 0으로 취급하면 성인에게 신생아 참고치가 적용된다(위험, R3).
  //   불명이면 연령 하위대(신생아·소아·성인 sub-band)를 절대 적용하지 않고, 전 연령 포괄(≈0~120+) 참고치만 쓴다.
  //   그런 참고치가 없으면 미선택→NO_RANGE 보류(사람이 판단). 나이 아는 경우만 정상 대역 매칭.
  const matched = age == null
    ? ranges.filter((r) => bySex(r) && r.ageMin <= 0 && r.ageMax >= 120)
    : ranges.filter((r) => bySex(r) && age >= r.ageMin && age <= r.ageMax);
  if (matched.length === 0) return null;
  // 성별 정확 매칭을 'A'보다 우선
  matched.sort((x, y) => (x.sex === 'A' ? 1 : 0) - (y.sex === 'A' ? 1 : 0));
  return matched[0];
}

/**
 * 수치 결과의 판정 플래그 결정.
 * 위험치(panic) → HH/LL, 참고치 밖 → H/L, 이내 → N.
 */
/**
 * 참고치 정합성 검증 — **판정 로직이 옳아도 참고치가 틀리면 모든 결과가 틀린다.**
 *
 * determineFlag는 위험치를 먼저 본다(`value <= panicLow → LL`, `value >= panicHigh → HH`).
 * 그래서 다음이 저장되면 임상 사고로 이어진다(실측: 세 경우 모두 그대로 저장됐다):
 *  - `panicLow > panicHigh`  → 거의 모든 값이 LL로 판정돼 **위험치 통보가 폭주**한다(경보 피로 →
 *    진짜 위험치를 무시하게 된다)
 *  - `panicHigh <= high`     → **정상 범위 안의 값이 위험치로** 판정된다(오발령)
 *  - `panicLow >= low`       → 동상(하한 쪽)
 *  - `low > high`            → 정상 범위가 존재할 수 없어 모든 값이 L 또는 H
 *
 * 반환: 위반 사유 목록(빈 배열이면 정상).
 */
export function validateReferenceRange(r: {
  low?: number | null; high?: number | null; panicLow?: number | null; panicHigh?: number | null;
  ageMin?: number | null; ageMax?: number | null;
}): string[] {
  const errs: string[] = [];
  const { low, high, panicLow, panicHigh } = r;
  // 연령대가 뒤집히면 `age >= ageMin && age <= ageMax`를 만족하는 환자가 없다 —
  // 참고치가 **영원히 선택되지 않아** 해당 검사의 모든 결과가 참고치 없음으로 보류된다.
  if (r.ageMin != null && r.ageMax != null && r.ageMin > r.ageMax) {
    errs.push(`연령 하한(${r.ageMin})이 상한(${r.ageMax})보다 큽니다 — 어떤 환자에게도 적용되지 않습니다`);
  }
  if (low != null && high != null && low > high) {
    errs.push(`정상 하한(${low})이 상한(${high})보다 큽니다`);
  }
  if (panicLow != null && panicHigh != null && panicLow >= panicHigh) {
    errs.push(`위험 하한(${panicLow})이 위험 상한(${panicHigh}) 이상입니다 — 모든 값이 위험치로 판정됩니다`);
  }
  if (panicHigh != null && high != null && panicHigh <= high) {
    errs.push(`위험 상한(${panicHigh})이 정상 상한(${high}) 이하입니다 — 정상 범위 값이 위험치로 통보됩니다`);
  }
  if (panicLow != null && low != null && panicLow >= low) {
    errs.push(`위험 하한(${panicLow})이 정상 하한(${low}) 이상입니다 — 정상 범위 값이 위험치로 통보됩니다`);
  }
  return errs;
}

export function determineFlag(value: number, r: RefRange): ResultFlag {
  if (r.panicLow != null && value <= r.panicLow) return 'LL';
  if (r.panicHigh != null && value >= r.panicHigh) return 'HH';
  if (r.low != null && value < r.low) return 'L';
  if (r.high != null && value > r.high) return 'H';
  return 'N';
}

export interface AutoVerifyContext {
  numeric: boolean;
  flag: ResultFlag;
  qcOk?: boolean; // 해당 항목 당일 QC 정상 (기본 true)
  deltaExceeded?: boolean; // 델타체크 초과 (기본 false)
  instrumentError?: boolean; // 장비 오류 플래그 (기본 false)
}

/**
 * 자동검증(Auto-verification) 가능 여부.
 * 모두 만족 시에만 자동확정: 수치 결과 · 위험치 아님 · QC 정상 · 델타 이내 · 장비오류 없음.
 * (위험치 HH/LL, 델타 초과, QC 위반, 장비오류는 수동검증 대상)
 */
export function isAutoVerifiable(ctx: AutoVerifyContext): boolean {
  if (!ctx.numeric) return false;
  if (ctx.flag === 'HH' || ctx.flag === 'LL') return false;
  if (ctx.qcOk === false) return false;
  if (ctx.deltaExceeded === true) return false;
  if (ctx.instrumentError === true) return false;
  return true;
}

/** 위험치(즉시 통보 대상) 여부 */
export function isCritical(flag: ResultFlag): boolean {
  return flag === 'HH' || flag === 'LL';
}

/** 문자열 결과가 수치인지 판정 */
export function isNumeric(value: string | null | undefined): boolean {
  if (value == null || value.trim() === '') return false;
  return !Number.isNaN(Number(value));
}

// ─────────────────────────────────────────────
// 델타 체크(Delta check) — 직전 동일검사 대비 급변 감지 (근거: 07 §4, 기획 22 §6-1)
// ─────────────────────────────────────────────
export interface DeltaCheckResult {
  hasPrev: boolean;
  prev: number | null;
  absDelta: number | null;
  pctDelta: number | null; // 백분율(%)
  exceeded: boolean;
}

/**
 * 직전 수치 대비 변화가 한계를 넘는지 판정. 넘으면 자동검증을 차단(수동검증 대상).
 * 기본 한계: 백분율 50%. absLimit 지정 시 절대값 기준도 함께 적용(OR).
 */
export function checkDelta(
  prev: number | null,
  cur: number,
  opts?: { pctLimit?: number; absLimit?: number },
): DeltaCheckResult {
  if (prev == null || Number.isNaN(prev)) {
    return { hasPrev: false, prev: null, absDelta: null, pctDelta: null, exceeded: false };
  }
  const pctLimit = opts?.pctLimit ?? 50;
  const absDelta = Math.abs(cur - prev);
  const pctDelta = prev !== 0 ? (absDelta / Math.abs(prev)) * 100 : null;
  const byPct = pctLimit != null && pctDelta != null && pctDelta >= pctLimit;
  const byAbs = opts?.absLimit != null && absDelta >= opts.absLimit;
  return {
    hasPrev: true,
    prev,
    absDelta,
    pctDelta: pctDelta == null ? null : Math.round(pctDelta * 10) / 10,
    exceeded: Boolean(byPct || byAbs),
  };
}

// ─────────────────────────────────────────────
// Reflex(반사검사)는 거버넌스 엔진(modules/reflex + domain/reflex.ts)으로 이관됨(기획 27).
//   과거 하드코딩 REFLEX_RULES/reflexFor는 승인 프로토콜(ReflexProtocol) 기반 DB 규칙으로 대체.

/**
 * 확정(보고 가능) 결과 상태 정본.
 *
 * 이 판정이 "결과가 환자 차트·HIS·청구로 나가는가"를 가른다. 예전엔 이 규칙이 12곳 이상에
 * 인라인 배열로 복제돼 있어, 상태값을 하나 늘리면 전부 찾아 고쳐야 했다(놓친 곳이 청구면
 * 미청구, 발신이면 결과 미전송으로 **조용히** 틀린다). 새 상태를 추가할 때는 여기만 고칠 것.
 */
export const FINALIZED_VERIFY_STATES = ['AUTO', 'VERIFIED'] as const;
export type FinalizedVerifyState = typeof FINALIZED_VERIFY_STATES[number];

/** 결과가 확정(보고 가능) 상태인가. Prisma `where`에는 FINALIZED_VERIFY_STATES를 그대로 쓴다. */
export function isFinalized(verifyState: string | null | undefined): boolean {
  return !!verifyState && (FINALIZED_VERIFY_STATES as readonly string[]).includes(verifyState);
}

/** 보류(수동검증) 사유 — 워크리스트 우선순위·표시에 사용 */
/**
 * 수동검증 보류 사유.
 * SENDOUT = 외부위탁 회신 결과. 사람이 외부 검사실 보고서를 보고 옮겨 적은 값이고
 * 방법·참고치가 우리 것과 다를 수 있어, 자동검증으로 그냥 내보내지 않는다.
 */
export type HoldReason = 'CRITICAL' | 'DELTA' | 'QC' | 'INSTRUMENT' | 'UNIT_MISMATCH' | 'NONNUMERIC' | 'NO_RANGE' | 'PANIC_UNSET' | 'POLICY' | 'SENDOUT';

export function holdReasonFor(ctx: {
  numeric: boolean;
  critical: boolean;
  deltaExceeded: boolean;
  qcOk?: boolean;
  instrumentError?: boolean;
}): HoldReason | null {
  if (!ctx.numeric) return 'NONNUMERIC';
  if (ctx.critical) return 'CRITICAL';
  if (ctx.deltaExceeded) return 'DELTA';
  if (ctx.qcOk === false) return 'QC';
  if (ctx.instrumentError === true) return 'INSTRUMENT';
  return null;
}

/** 워크리스트 정렬 우선순위(작을수록 상단) */
export function holdPriority(reason: HoldReason | null): number {
  switch (reason) {
    case 'CRITICAL': return 0;
    case 'PANIC_UNSET': return 1; // 이상치인데 위험치 경계 미설정 — 위험 여부 불명, 즉시 검토
    case 'INSTRUMENT': return 1;
    case 'UNIT_MISMATCH': return 2; // 입력 단위 ≠ 마스터 단위 — 크기 오판 가능, 확인 필요
    case 'QC': return 2;
    case 'DELTA': return 3;
    case 'NONNUMERIC': return 4;
    case 'SENDOUT': return 4;
    default: return 5;
  }
}

/**
 * 만 나이(전체 날짜 기반) — 생일 경과 여부까지 반영해 연령대 참고치 오분류 방지.
 * 결과입력 화면 프리뷰·제출 판정·보고서가 **같은 나이**를 쓰도록 정본 하나로 공유(표시=판정).
 */
export function calcAge(birthDate: string | null): number | null {
  if (!birthDate) return null;
  const b = new Date(birthDate);
  if (Number.isNaN(b.getTime())) {
    const y = Number(birthDate.slice(0, 4));
    return Number.isNaN(y) ? null : new Date().getFullYear() - y;
  }
  const now = new Date();
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age >= 0 ? age : null;
}
