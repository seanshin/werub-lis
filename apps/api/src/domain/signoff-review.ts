/**
 * 서명·결재 재검토 판정(Domain, 순수 함수).
 * 두 축: (1) 인력변경 이벤트 플래그(needsReview/reviewReason, 저장형) + (2) 정기 재검토 만료(nextReviewDate<오늘, 계산형).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
export const DEFAULT_REVIEW_INTERVAL_DAYS = 365;

/** 조직 게이트 결재 lifecycle(EAS 전자결재 흐름 대응) — 수기·향후 자동피드 공통. */
export const GATE_STATUSES = ['PENDING', 'SUBMITTED', 'IN_PROGRESS', 'APPROVED', 'REJECTED'] as const;
export type GateStatus = typeof GATE_STATUSES[number];
export const GATE_STATUS_LABEL: Record<string, string> = {
  PENDING: '미상신', SUBMITTED: '상신', IN_PROGRESS: '진행중', APPROVED: '완료(승인)', REJECTED: '반려',
};
/**
 * 결재 전이로 **지정할 수 있는** 상태 — PENDING(미상신)은 초기값이라 전이 대상이 아니다.
 * DTO(@IsIn)와 서비스 검증이 각자 배열을 들고 있으면 어긋난다(실제로 어긋나 있었다).
 * 이 상수 하나만 참조할 것.
 */
export const GATE_TRANSITION_STATUSES = GATE_STATUSES.filter((s) => s !== 'PENDING');

export function isTransitionableGateStatus(s: string): boolean {
  return (GATE_TRANSITION_STATUSES as readonly string[]).includes(s);
}

export function isValidGateStatus(s: string): s is GateStatus {
  return (GATE_STATUSES as readonly string[]).includes(s);
}

/** YYYY-MM-DD에 일수 더하기(UTC 기준). */
export function addDaysIso(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface ReviewableGate {
  status: string;
  needsReview?: boolean;
  reviewReason?: string | null;
  nextReviewDate?: string | null;
}

/** 재검토 필요 사유 목록(빈 배열이면 유효). todayIso는 서비스가 주입(순수성 유지). */
export function reviewFlags(g: ReviewableGate, todayIso: string): string[] {
  const flags: string[] = [];
  if (g.needsReview && g.reviewReason) flags.push(g.reviewReason);
  if (g.status === 'APPROVED' && g.nextReviewDate && g.nextReviewDate < todayIso) {
    flags.push(`정기 재검토 기간 만료(예정 ${g.nextReviewDate})`);
  }
  return flags;
}

export function isStale(g: ReviewableGate, todayIso: string): boolean {
  return reviewFlags(g, todayIso).length > 0;
}
