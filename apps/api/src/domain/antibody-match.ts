/**
 * 항체동정 → 항원음성 유닛 매칭(순수 함수) — 동종면역 환자 수혈 안전.
 * 환자에 동정된 항체(anti-K 등)가 있으면, 해당 항원(K)에 음성인 제제만 적합.
 * 항체 문자열: "anti-K, anti-E" / 유닛 항원음성 문자열: "K-neg, E-neg" 또는 "K,E".
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

/** 항체 목록 → 유닛이 음성이어야 할 항원 목록(anti- 접두 제거·대문자). */
export function requiredAntigenNeg(antibodies: string | null | undefined): string[] {
  if (!antibodies) return [];
  return antibodies
    .split(/[,;/]+/)
    .map((a) => a.trim())
    .filter(Boolean)
    .map((a) => a.replace(/^anti[-\s]?/i, '').toUpperCase())
    .filter((a) => a && !['NEG', 'NEGATIVE', 'NONE', '음성', '없음'].includes(a));
}

/** 유닛 항원음성 문자열 → 음성 항원 집합. "K-neg","E neg","Jka" 모두 항원명으로 정규화. */
export function parseAntigenNeg(antigenNeg: string | null | undefined): Set<string> {
  if (!antigenNeg) return new Set();
  return new Set(
    antigenNeg
      .split(/[,;/]+/)
      .map((a) => a.trim().replace(/[-\s]?(neg|negative|음성).*$/i, '').toUpperCase())
      .filter(Boolean),
  );
}

export interface AntigenMatchResult {
  compatible: boolean;
  requiredNeg: string[]; // 유닛이 음성이어야 할 항원
  missing: string[]; // 유닛이 음성임을 확인 못 한 항원(부적합 사유)
}

/** 환자 항체 vs 유닛 항원음성 → 적합 여부. 항체 없으면 항원 제약 없음(적합). */
export function antigenCompatible(patientAntibodies: string | null | undefined, unitAntigenNeg: string | null | undefined): AntigenMatchResult {
  const requiredNeg = requiredAntigenNeg(patientAntibodies);
  const negSet = parseAntigenNeg(unitAntigenNeg);
  const missing = requiredNeg.filter((ag) => !negSet.has(ag));
  return { compatible: missing.length === 0, requiredNeg, missing };
}
