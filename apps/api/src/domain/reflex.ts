/**
 * Reflex(반사검사) 판정 — 1차 결과가 조건을 충족하면 후속검사를 자동 추가하는 규칙(순수 함수).
 *
 * ⚠ 규칙 자체는 여기 하드코딩하지 않는다. 사전승인된 `ReflexProtocol`(DB)만 실행되며,
 *   이 파일은 그 조건 평가와 HIS 오더번호 추출 같은 부작용 없는 계산만 담당한다.
 *   하드코딩 규칙은 임상이 관리할 수 없고 승인 근거도 남지 않아 거버넌스 엔진으로 옮겼다(문서 27).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { ResultFlag } from './result-evaluation';

/**
 * Reflex(반사검사) 트리거 매칭 — 기획 27 §5.
 * 승인(ACTIVE)된 프로토콜만 호출측에서 로드되며, 여기서는 순수 조건 판정만 한다.
 */
export interface ReflexTrigger {
  operator: string; // >= <= > < OUT_OF_REF FLAG
  threshold: number | null;
  thresholdHigh?: number | null;
  flag: string | null; // FLAG 연산자용
}

export const REFLEX_OPERATORS = ['>=', '<=', '>', '<', 'BETWEEN', 'OUT_OF_REF', 'FLAG'] as const;

/** 트리거 조건 충족 여부. value/flag는 확정된 결과에서 계산된 값. */
export function reflexMatches(t: ReflexTrigger, value: number | null, flag: ResultFlag | null): boolean {
  const abnormal = flag != null && flag !== 'N';
  switch (t.operator) {
    case '>=':
      return value != null && t.threshold != null && value >= t.threshold;
    case '<=':
      return value != null && t.threshold != null && value <= t.threshold;
    case '>':
      return value != null && t.threshold != null && value > t.threshold;
    case '<':
      return value != null && t.threshold != null && value < t.threshold;
    case 'BETWEEN': // threshold ≤ value ≤ thresholdHigh (범위 규칙 — thresholdHigh 사용)
      return value != null && t.threshold != null && t.thresholdHigh != null && value >= t.threshold && value <= t.thresholdHigh;
    case 'OUT_OF_REF':
      return abnormal; // 참고범위 밖(H/HH/L/LL)
    case 'FLAG':
      return flag != null && t.flag != null && flag === t.flag;
    default:
      return false;
  }
}

/** 프로토콜이 오늘 유효한가(유효기간). */
export function reflexEffective(effectiveFrom: string | null, effectiveTo: string | null, today = new Date().toISOString().slice(0, 10)): boolean {
  if (effectiveFrom && today < effectiveFrom) return false;
  if (effectiveTo && today > effectiveTo) return false;
  return true;
}

/** HIS FHIR ServiceRequest 식별자 배열. */
export interface FhirIdentifier {
  system?: string;
  value?: string;
}

/**
 * HIS 승인 응답(active)에서 정식 오더번호(urn:his:order) 추출 — R-5 폴링 계약(2026-07-15).
 * system이 'his:order'를 포함하는 첫 identifier의 value. 없으면 null(멱등키 urn:lis:weve:reflex-order는 제외).
 */
export function extractHisOrderNo(identifiers?: FhirIdentifier[] | null): string | null {
  if (!identifiers?.length) return null;
  // system이 정확히 urn:his:order 이거나 ':his:order'로 끝나는 것만(‘urn:this:order’ 등 오탐 방지, 멱등키 urn:lis:weve:reflex-order 제외)
  const hit = identifiers.find((i) => {
    if (!i?.value) return false;
    const s = (i.system ?? '').toLowerCase();
    return s === 'urn:his:order' || s.endsWith(':his:order');
  });
  return hit?.value ?? null;
}
