/**
 * 데이터 수명주기·보존 정책 (Domain, 순수 함수).
 * 근거: 기획 22 §P3(데이터 수명주기/보존).
 * 임상 결과는 법정 보존기간(수년~수십년)으로 자동 삭제 대상에서 제외(purgeable=false).
 * 운영 로그(연계·감사·알림)만 보존기간 경과 시 정리 가능.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export interface RetentionRule {
  key: string; // 논리 테이블 키
  label: string;
  days: number; // 보존 일수
  purgeable: boolean; // 자동 정리 대상 여부
  dateField: string; // 경과 판정 기준 컬럼
  /** 법정 하한(일). 설정·env 어느 경로로도 이 아래로 못 내려간다 — 적용 시점에서 강제. */
  minDays?: number;
}

// 개시 전 상향(개인정보보호법 시행령 §30 접속기록 보존: 일반 1년·민감/고유식별정보 2년 이상).
// 감사로그는 유전정보 등 민감접근을 포함 → 2년 floor에 여유를 둔 3년. 최종값은 보안·법무 확정 대상.
// minDays: **법정 하한**. 설정(화면·env) 어느 경로로도 이 아래로 내려갈 수 없다 —
//   적용 시점(LifecycleService.daysFor)에서도 강제한다. env는 저장 검증을 타지 않기 때문이다.
export const RETENTION_POLICY: RetentionRule[] = [
  { key: 'interface_log', label: '연계 로그', days: 365, purgeable: true, dateField: 'createdDt', minDays: 90 }, // 장애조사·소명(90→365)
  { key: 'audit_log', label: '감사 로그', days: 1095, purgeable: true, dateField: 'createdDt', minDays: 730 }, // 민감접근 접속기록(365→3년). tamper-evident 체인은 prefix 퍼지 정상 처리
  { key: 'notification', label: '알림', days: 365, purgeable: true, dateField: 'createdDt', minDays: 180 }, // 위험치 통보 소명(180→365)
  { key: 'result', label: '검사 결과', days: 3650, purgeable: false, dateField: 'reportedDt' }, // 법정 보존 — 자동삭제 안 함
];

/** 보존 경계 시각 — 이보다 오래된 데이터가 정리 대상. */
export function cutoffDate(days: number, nowMs: number): Date {
  return new Date(nowMs - days * 86400_000);
}

export function ruleFor(key: string): RetentionRule | undefined {
  return RETENTION_POLICY.find((r) => r.key === key);
}
