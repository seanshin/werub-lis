/**
 * 수혈 전주기 도메인 (순수 함수) — 유효기간·부작용 조치.
 * 근거: 기획 22 §5(수혈 전주기: 입고·유효기간·시행·부작용).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export type ExpiryStatus = 'OK' | 'EXPIRING' | 'EXPIRED';

/** 유효기간 상태 — 만료/임박(기본 7일)/정상. (YYYY-MM-DD 문자열 비교) */
export function expiryStatus(expiryDate: string | null, today: string, warnDays = 7): ExpiryStatus {
  if (!expiryDate) return 'OK';
  if (expiryDate < today) return 'EXPIRED';
  const warn = addDays(today, warnDays);
  if (expiryDate <= warn) return 'EXPIRING';
  return 'OK';
}

/** YYYY-MM-DD에 일수 더하기(UTC 기준, 순수 계산). */
export function addDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const ms = Date.UTC(y, m - 1, d) + days * 86400_000;
  const dt = new Date(ms);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

const REACTION_TYPES = ['FEBRILE', 'ALLERGIC', 'HEMOLYTIC', 'TACO', 'OTHER'];
const SEVERITIES = ['MILD', 'MODERATE', 'SEVERE'];

export function isValidReaction(type: string, severity: string): boolean {
  return REACTION_TYPES.includes(type) && SEVERITIES.includes(severity);
}

/** 부작용 유형·중증도 → 권고 조치. */
export function reactionGuidance(type: string, severity: string): string {
  if (severity === 'SEVERE' || type === 'HEMOLYTIC') {
    return '즉시 수혈 중단·활력징후 확인·잔여 제제/혈액 검사실 반환·주치의 통보';
  }
  if (type === 'TACO') return '수혈 속도 감속·이뇨제 고려·활력징후 관찰';
  if (type === 'ALLERGIC') return '항히스타민제 고려·경과 관찰';
  return '수혈 일시 중단·해열/대증 처치·경과 관찰';
}
