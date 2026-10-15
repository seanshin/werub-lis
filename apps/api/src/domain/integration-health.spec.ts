/**
 * evaluateIntegrationHealth — 단위 테스트 11건.
 *
 * 묶음: thresholdsFromEnv, 장비 결과 수집 감시(P1-11).
 * 임상 판정·안전 방어를 검증하는 테스트는 회귀 금지 — 실패하면 로직이 아니라 원인을 먼저 본다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { describe, it, expect } from 'vitest';
import { evaluateIntegrationHealth, thresholdsFromEnv, DEFAULT_THRESHOLDS, type IntegrationMetrics } from './integration-health';

const clean: IntegrationMetrics = { dlqDepth: 0, stuckOutbound: 0, oldestStuckAgeMin: null, undeliveredCritical: 0 };

describe('evaluateIntegrationHealth', () => {
  it('모든 지표 0 → healthy', () => {
    const v = evaluateIntegrationHealth(clean);
    expect(v.healthy).toBe(true);
    expect(v.breaches).toHaveLength(0);
  });

  it('DLQ 1건 → breach(무관용 기본)', () => {
    const v = evaluateIntegrationHealth({ ...clean, dlqDepth: 1 });
    expect(v.healthy).toBe(false);
    expect(v.breaches[0]).toContain('DLQ');
  });

  it('발신 정체 → breach에 최고령 분 포함', () => {
    const v = evaluateIntegrationHealth({ ...clean, stuckOutbound: 3, oldestStuckAgeMin: 47 });
    expect(v.healthy).toBe(false);
    expect(v.breaches.some((b) => b.includes('47분'))).toBe(true);
  });

  it('위험치 미전달 → breach', () => {
    const v = evaluateIntegrationHealth({ ...clean, undeliveredCritical: 2 });
    expect(v.breaches.some((b) => b.includes('위험치'))).toBe(true);
  });

  it('여러 위반 동시 집계', () => {
    const v = evaluateIntegrationHealth({ dlqDepth: 2, stuckOutbound: 1, oldestStuckAgeMin: 10, undeliveredCritical: 1 });
    expect(v.breaches).toHaveLength(3);
  });

  it('임계 상향 시 그 이하는 healthy', () => {
    const v = evaluateIntegrationHealth({ ...clean, dlqDepth: 3 }, { ...DEFAULT_THRESHOLDS, dlqDepth: 5 });
    expect(v.healthy).toBe(true);
  });
});

describe('thresholdsFromEnv', () => {
  it('미설정 → 기본(무관용 0)', () => {
    expect(thresholdsFromEnv({})).toEqual(DEFAULT_THRESHOLDS);
  });
  it('env 파싱, 음수·NaN은 기본으로 방어', () => {
    const t = thresholdsFromEnv({ OPS_DLQ_THRESHOLD: '5', OPS_STUCK_THRESHOLD: '-1', OPS_CRITICAL_THRESHOLD: 'x' } as NodeJS.ProcessEnv);
    expect(t.dlqDepth).toBe(5);
    expect(t.stuckOutbound).toBe(0);
    expect(t.undeliveredCritical).toBe(0);
  });
});

describe('장비 결과 수집 감시(P1-11)', () => {
  // IF-INSTR(INBOUND)이 감시 대상 밖이라, 시약 로트 교체로 매핑이 어긋나 오전 검사 전량이
  // 드롭돼도 지표·알림 어디에도 잡히지 않았다.
  const base = { dlqDepth: 0, stuckOutbound: 0, oldestStuckAgeMin: null, undeliveredCritical: 0, instrumentFailed: 0 };
  it('장비 수집 실패가 있으면 breach로 잡힌다', () => {
    const r = evaluateIntegrationHealth({ ...base, instrumentFailed: 3 }, DEFAULT_THRESHOLDS);
    expect(r.healthy).toBe(false);
    expect(r.breaches.join()).toContain('장비 결과 수집 실패');
  });
  it('0건이면 정상', () => {
    expect(evaluateIntegrationHealth(base, DEFAULT_THRESHOLDS).healthy).toBe(true);
  });
  it('기본 임계는 0 — 결과 유입 중단은 즉시 인지해야 한다', () => {
    expect(DEFAULT_THRESHOLDS.instrumentFailed).toBe(0);
  });
});

describe('폴링 정체·MWL 감시(신규)', () => {
  const base = {
    dlqDepth: 0, stuckOutbound: 0, oldestStuckAgeMin: null, undeliveredCritical: 0,
    instrumentFailed: 0, orderCancelFailed: 0, droppedOrders: 0, hl7OrderFailed: 0,
    orderPollStaleMin: null as number | null, mwlFailed: 0, billingStuck: null as number | null,
  };

  it('★폴링이 멈추면 다른 지표가 전부 0이어도 이상으로 잡힌다', () => {
    // 이것이 가장 조용한 실패다 — 오더가 아예 안 들어오면 '들어온 것'을 세는 지표는 모두 정상으로 보인다
    const v = evaluateIntegrationHealth({ ...base, orderPollStaleMin: 45 });
    expect(v.healthy).toBe(false);
    expect(v.breaches.join(' ')).toContain('폴링 정체');
  });

  it('임계 이내면 정상', () => {
    expect(evaluateIntegrationHealth({ ...base, orderPollStaleMin: 10 }).healthy).toBe(true);
  });

  it('폴링 off(null)는 이상이 아니다 — 의도적으로 끈 것을 경보하면 다른 신호가 묻힌다', () => {
    expect(evaluateIntegrationHealth({ ...base, orderPollStaleMin: null }).healthy).toBe(true);
  });

  it('MWL 송신 실패는 1건이라도 이상 — 병리 스캔 누락으로 이어진다', () => {
    const v = evaluateIntegrationHealth({ ...base, mwlFailed: 1 });
    expect(v.healthy).toBe(false);
    expect(v.breaches.join(' ')).toContain('워크리스트');
  });
});

describe('임계 파싱 — 빈 문자열은 미설정', () => {
  it("★compose가 넘기는 ''가 기본값을 0으로 덮지 않는다", () => {
    // `KEY: ${KEY:-}`는 미설정 시 빈 문자열을 넘긴다. Number('')는 0이므로
    // 방어하지 않으면 0이 아닌 기본값(폴링 정체 30분)이 조용히 0이 되어 상시 경보가 된다.
    const t = thresholdsFromEnv({ OPS_POLL_STALE_MINUTES: '' } as NodeJS.ProcessEnv);
    expect(t.orderPollStaleMin).toBe(DEFAULT_THRESHOLDS.orderPollStaleMin);
  });
  it('공백만 있어도 미설정으로 본다', () => {
    expect(thresholdsFromEnv({ OPS_POLL_STALE_MINUTES: '   ' } as NodeJS.ProcessEnv).orderPollStaleMin)
      .toBe(DEFAULT_THRESHOLDS.orderPollStaleMin);
  });
  it('실제 값은 그대로 반영', () => {
    expect(thresholdsFromEnv({ OPS_POLL_STALE_MINUTES: '60' } as NodeJS.ProcessEnv).orderPollStaleMin).toBe(60);
  });
});

describe('ERP 청구 정체 감시', () => {
  const base = {
    dlqDepth: 0, stuckOutbound: 0, oldestStuckAgeMin: null, undeliveredCritical: 0,
    instrumentFailed: 0, orderCancelFailed: 0, droppedOrders: 0, hl7OrderFailed: 0,
    orderPollStaleMin: null as number | null, mwlFailed: 0, billingStuck: null as number | null,
  };
  it('전송 정체는 이상으로 잡는다', () => {
    const v = evaluateIntegrationHealth({ ...base, billingStuck: 2 });
    expect(v.healthy).toBe(false);
    expect(v.breaches.join(' ')).toContain('청구 전송 정체');
  });
  it('★ERP 미구성(null)은 이상이 아니다 — 전부 PENDING인 게 정상이라 상시 경보가 된다', () => {
    expect(evaluateIntegrationHealth({ ...base, billingStuck: null }).healthy).toBe(true);
  });
});
