/**
 * 도메인 열거값 정본 — 자연스러운 소유 도메인 파일이 없는 공통 상태값들.
 *
 * ⚠ **DTO의 `@IsIn`과 서비스 검증 배열이 각자 리터럴을 들고 있으면 반드시 어긋난다.**
 * 실제로 2026-07-21에 11건이 한 번에 어긋난 채 발견됐다(NGS `COMPLETED`↔`COMPLETE`,
 * tier `IA`↔`TIER_I`, priority `ROUTINE`↔`R`, terminology `ACTIVE`↔`USE` 등).
 * 새 열거값은 여기(또는 해당 도메인 파일)에 두고, DTO·서비스·화면이 **참조만** 할 것.
 * 배열 리터럴을 컨트롤러·서비스에 다시 쓰지 말 것.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

/** 마스터·용어 사용 상태 — 이력 보존을 위해 하드삭제 대신 STOP으로 중지한다. */
export const USE_STATUSES = ['USE', 'STOP'] as const;
export type UseStatus = typeof USE_STATUSES[number];

/** 병리 추가 염색·재검 오더 유형 */
export const STAIN_ORDER_TYPES = ['IHC', 'SPECIAL', 'RECUT', 'DEEPER'] as const;
export type StainOrderType = typeof STAIN_ORDER_TYPES[number];

/** 오더 진행 상태(염색 오더 등 요청→완료 워크플로 공통) */
export const WORK_ORDER_STATUSES = ['REQUESTED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export type WorkOrderStatus = typeof WORK_ORDER_STATUSES[number];

/** 동결절편 ↔ 영구절편 일치도 */
export const CONCORDANCE_VALUES = ['CONCORDANT', 'DISCORDANT'] as const;
export type Concordance = typeof CONCORDANCE_VALUES[number];

/** QC 월간 검토 판정 */
export const QC_REVIEW_VERDICTS = ['승인', '보류'] as const;
export type QcReviewVerdict = typeof QC_REVIEW_VERDICTS[number];

/** 바코드 자동 제출 방식 */
export const AUTO_SUBMIT_MODES = ['ENTER', 'LENGTH', 'IDLE'] as const;
export type AutoSubmitMode = typeof AUTO_SUBMIT_MODES[number];

/**
 * 병리 보고서 상태 — **서명이 끝난(법적 확정) 상태**.
 * 이 상태의 보고서는 제자리에서 덮어쓰지 않는다. 수정은 개정(amend)으로만 하며,
 * 개정은 버전 증가와 사유 기록을 강제한다. `PathologyReport`에 이력 테이블이 없어
 * 덮어쓰면 **이전 확정 진단을 복구할 수 없다.**
 */
export const SIGNED_PATHOLOGY_STATUSES = ['최종', '개정'] as const;

export function isSignedPathologyStatus(status: string | null | undefined): boolean {
  return !!status && (SIGNED_PATHOLOGY_STATUSES as readonly string[]).includes(status);
}

/**
 * 연계 로그(InterfaceLog.status) 상태 어휘 정본 — DB 컬럼은 String이라 어휘가 코드마다
 * 흩어져 있었다(재검토 P2). 새 상태는 반드시 여기 추가하고, 쓰기 지점은 이 타입으로 받는다.
 *
 * 수신(INBOUND): PROCESSING(선점 클레임)→PROCESSED/PARTIAL/FAILED, DROPPED(미적재 대기열)
 * 발신(OUTBOUND): STAGED→SENDING→PROCESSED/FAILED→DLQ(재시도 소진),
 *                 APPROVED/REJECTED(리플렉스 승인), REJECTED_CANCELLED/REJECTED_KEPT(취소 심사)
 */
export const INTERFACE_LOG_STATUSES = [
  'PROCESSING', 'RECEIVED', 'PROCESSED', 'PARTIAL', 'FAILED', 'DROPPED',
  'STAGED', 'SENDING', 'DLQ', 'APPROVED', 'REJECTED', 'REJECTED_CANCELLED', 'REJECTED_KEPT',
] as const;
export type InterfaceLogStatus = typeof INTERFACE_LOG_STATUSES[number];

/** 열거 포함 여부(서비스 검증용) — `@IsIn`은 상수 배열을 그대로 넘긴다. */
export function isOneOf<T extends readonly string[]>(values: T, v: unknown): v is T[number] {
  return typeof v === 'string' && (values as readonly string[]).includes(v);
}
