/**
 * 연계 운영 건강도 평가 (Domain, 순수 함수).
 * DLQ 적재·발신 정체·위험치 통보 미전달을 임계와 대조해 breach 목록 산출.
 * IO(집계·webhook)는 서비스가 담당하고, 임계 판정만 여기서(테스트 용이).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

export interface IntegrationMetrics {
  dlqDepth: number; // OUTBOUND DLQ 격리 건수(사람 개입 대기)
  stuckOutbound: number; // STAGED/FAILED/SENDING이 임계시간 이상 미발신
  oldestStuckAgeMin: number | null; // 가장 오래 정체된 발신 건 나이(분)
  undeliveredCritical: number; // 미확인 위험치 통보(ack 전) — 발송 성공분도 포함(폐루프 미완결)
  instrumentFailed: number; // 장비 결과 수집 실패·부분실패(IF-INSTR, 최근 창)
  // HIS 오더 취소 적용 실패(IF-HISORD, 최근 창). 취소 누락은 **취소된 검사를 계속 수행·보고**로
  // 이어지므로 임상 위험이다. 워터마크가 실패분 앞에서 멈춰 재시도되지만, 계속 실패하면 사람이 봐야 한다.
  orderCancelFailed: number;
  // 미적재 HIS 오더 대기열 적체(IF-HISORD DROPPED). 워터마크가 이미 지나가 재폴링되지 않으므로
  // 사람이 코드매핑을 고치고 재적재하지 않으면 그 오더는 영원히 LIS에 없다.
  droppedOrders: number;
  // HL7 푸시(MLLP OML^O21, IF-03) 오더 수신 실패(최근 창). FHIR-poll(IF-HISORD)과 달리 재적재 큐가
  // 없어 실패 시 오더가 유실되는데 감시 사각이었다 — 사람이 코드매핑 고치고 HIS 재전송을 요청해야 한다.
  hl7OrderFailed: number;
  /**
   * 오더 폴링 정체(분) — 마지막 워터마크 갱신 이후 경과. 폴링 off면 null.
   * ★가장 조용한 실패를 잡는 지표다: 폴링이 죽으면 오더가 아예 안 들어오는데,
   *   다른 지표는 "들어온 것"만 세므로 **전부 초록으로 남는다**(접수가 통째로 멈춰도).
   */
  orderPollStaleMin: number | null;
  /**
   * PACS 워크리스트(MWL, IF-09) 송신 실패 — 최근 창.
   * 병리 접수 시 자동 송신되는데 실패하면 PACS에 워크리스트가 없어 스캔이 누락된다.
   */
  mwlFailed: number;
  /**
   * ERP 청구 전송 정체 — PENDING(미전송)이 임계시간 이상 남아 있는 건수. ERP 미구성이면 null.
   * ★4xx 반송(REJECTED)은 여기서 세지 않는다 — 그건 연계 장애가 아니라 **업무 정정 대상**이고,
   *   청구 화면의 반송 워크리스트가 담당한다. 여기서 세면 정상적인 업무 반려가 연계 경보로
   *   울려 진짜 전송 장애가 묻힌다.
   */
  billingStuck: number | null;
}

export interface HealthThresholds {
  dlqDepth: number; // 초과 시 breach (기본 0: DLQ는 1건이라도 격리 = 개입 필요)
  stuckOutbound: number; // 초과 시 breach (기본 0)
  undeliveredCritical: number; // 초과 시 breach (기본 0: 위험치 미전달 무관용)
  instrumentFailed: number; // 초과 시 breach (기본 0: 결과 유입 중단은 즉시 인지해야 함)
  orderCancelFailed: number; // 초과 시 breach (기본 0: 취소 미반영은 임상 위험)
  droppedOrders: number; // 초과 시 breach (기본 0: 접수 누락은 검사 자체가 없던 일이 된다)
  hl7OrderFailed: number; // 초과 시 breach (기본 0: HL7 푸시 오더 유실은 접수 누락)
  orderPollStaleMin: number; // 초과 시 breach (분) — 폴링 주기 5분의 여유배수
  mwlFailed: number; // 초과 시 breach (기본 0: 워크리스트 누락 = 스캔 누락)
  billingStuck: number; // 초과 시 breach (기본 0: 전송 자체가 계속 실패 중)
}

export const DEFAULT_THRESHOLDS: HealthThresholds = {
  dlqDepth: 0,
  stuckOutbound: 0,
  undeliveredCritical: 0,
  instrumentFailed: 0,
  orderCancelFailed: 0,
  droppedOrders: 0,
  hl7OrderFailed: 0,
  // 폴링 주기 5분 × 6 = 30분. 일시적 HIS 무응답으로 매번 울리지 않으면서,
  // 반나절 멈춘 것을 놓치지도 않는 값.
  orderPollStaleMin: 30,
  mwlFailed: 0,
  billingStuck: 0,
};

export interface HealthVerdict {
  healthy: boolean;
  breaches: string[]; // 사람이 읽는 위반 요약(알림 본문)
}

/** 지표를 임계와 대조 — 초과 항목을 breach 문자열로. healthy=위반 없음. */
export function evaluateIntegrationHealth(
  m: IntegrationMetrics,
  t: HealthThresholds = DEFAULT_THRESHOLDS,
): HealthVerdict {
  const breaches: string[] = [];
  if (m.dlqDepth > t.dlqDepth) breaches.push(`DLQ 격리 ${m.dlqDepth}건(임계 ${t.dlqDepth}) — 수동 재큐 필요`);
  if (m.stuckOutbound > t.stuckOutbound) {
    const age = m.oldestStuckAgeMin != null ? ` · 최고령 ${m.oldestStuckAgeMin}분` : '';
    breaches.push(`발신 정체 ${m.stuckOutbound}건(임계 ${t.stuckOutbound})${age}`);
  }
  if (m.undeliveredCritical > t.undeliveredCritical) breaches.push(`위험치 통보 미확인 ${m.undeliveredCritical}건 — 채널·확인 점검`);
  if (m.instrumentFailed > t.instrumentFailed) breaches.push(`장비 결과 수집 실패 ${m.instrumentFailed}건 — 코드매핑·장비 연결 점검`);
  if (m.orderCancelFailed > t.orderCancelFailed) breaches.push(`HIS 오더 취소 적용 실패 ${m.orderCancelFailed}건 — 취소된 검사가 계속 수행될 수 있음`);
  if (m.droppedOrders > t.droppedOrders) breaches.push(`미적재 HIS 오더 ${m.droppedOrders}건 대기 — 코드매핑 보정 후 재적재 필요(접수 누락)`);
  if (m.hl7OrderFailed > t.hl7OrderFailed) breaches.push(`HL7 푸시 오더 수신 실패 ${m.hl7OrderFailed}건 — 코드매핑 보정 후 HIS 재전송 필요(오더 유실)`);
  if (m.orderPollStaleMin != null && m.orderPollStaleMin > t.orderPollStaleMin) {
    breaches.push(`HIS 오더 폴링 정체 ${m.orderPollStaleMin}분(임계 ${t.orderPollStaleMin}분) — 접수가 멈췄을 수 있음. 자격증명·HIS 상태 확인`);
  }
  if (m.mwlFailed > t.mwlFailed) breaches.push(`PACS 워크리스트 송신 실패 ${m.mwlFailed}건 — 병리 스캔 누락 위험(재송신 필요)`);
  if (m.billingStuck != null && m.billingStuck > t.billingStuck) {
    breaches.push(`ERP 청구 전송 정체 ${m.billingStuck}건 — 전송이 반복 실패 중(반송 REJECTED는 별개·청구 화면에서 처리)`);
  }
  return { healthy: breaches.length === 0, breaches };
}

/** 환경변수에서 임계 로드(미설정 시 기본). 음수/NaN은 기본값으로 방어. */
export function thresholdsFromEnv(env: NodeJS.ProcessEnv): HealthThresholds {
  const num = (v: string | undefined, dflt: number): number => {
    // ★빈 문자열은 '미설정'이다 — compose가 `KEY: ${KEY:-}` 형태로 넘기면 값이 없을 때 ''가 온다.
    //   Number('')는 0이라 그대로 통과시키면 **기본값이 조용히 0으로 덮인다.**
    //   기본값이 0인 지표들에선 티가 안 나다가, 0이 아닌 기본값(폴링 정체 30분)에서 드러났다.
    if (v === undefined || v.trim() === '') return dflt;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : dflt;
  };
  return {
    dlqDepth: num(env.OPS_DLQ_THRESHOLD, DEFAULT_THRESHOLDS.dlqDepth),
    stuckOutbound: num(env.OPS_STUCK_THRESHOLD, DEFAULT_THRESHOLDS.stuckOutbound),
    undeliveredCritical: num(env.OPS_CRITICAL_THRESHOLD, DEFAULT_THRESHOLDS.undeliveredCritical),
    instrumentFailed: num(env.OPS_INSTRUMENT_THRESHOLD, DEFAULT_THRESHOLDS.instrumentFailed),
    orderCancelFailed: num(env.OPS_CANCEL_THRESHOLD, DEFAULT_THRESHOLDS.orderCancelFailed),
    droppedOrders: num(env.OPS_DROPPED_ORDER_THRESHOLD, DEFAULT_THRESHOLDS.droppedOrders),
    hl7OrderFailed: num(env.OPS_HL7_ORDER_THRESHOLD, DEFAULT_THRESHOLDS.hl7OrderFailed),
    orderPollStaleMin: num(env.OPS_POLL_STALE_MINUTES, DEFAULT_THRESHOLDS.orderPollStaleMin),
    mwlFailed: num(env.OPS_MWL_THRESHOLD, DEFAULT_THRESHOLDS.mwlFailed),
    billingStuck: num(env.OPS_BILLING_THRESHOLD, DEFAULT_THRESHOLDS.billingStuck),
  };
}
