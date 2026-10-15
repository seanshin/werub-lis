/**
 * IntegrationHealthService — integration 도메인 서비스.
 *
 * 주요 진입점: `onModuleInit()`, `metrics()`, `status()`, `monitor()`
 * 스케줄 작업 1건 — env 스위치로 켜고 끈다(운영단계 정의서 §4 참조).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { SettingsService } from '../modules/settings/settings.service';
import {
  evaluateIntegrationHealth,
  thresholdsFromEnv,
  type IntegrationMetrics,
  type HealthVerdict,
} from '../domain/integration-health';

/**
 * 연계 운영 감시(개시 전 백로그: DLQ/stuck 알림) — 임상 위험치 채널과 분리된 OPS 감시.
 *  - 10분 주기로 DLQ 적재·발신 정체·위험치 미전달을 집계, 임계 초과 시 OPS_WEBHOOK_URL로 알림(best-effort).
 *  - OPS_WEBHOOK_URL 미설정 시 크게 로깅(무알림 방치 방지). GET 엔드포인트로 대시보드/수동 점검 가능.
 * 정체 기준시간 OPS_STUCK_MINUTES(기본 30분) — 그보다 오래된 미발신 OUTBOUND를 정체로 간주.
 */
@Injectable()
export class IntegrationHealthService implements OnModuleInit {
  private readonly logger = new Logger('IntegrationHealth');
  /** 알림함 경보 유형 — 임상 알림(위험치 등)과 섞이지 않게 별도 유형. */
  private readonly ALERT_NTYPE = '연계경보';

  /**
   * ★기동 시 **외부 알림 채널 구성 여부를 한 번 크게 알린다.**
   *   OPS_WEBHOOK_URL 미설정이면 지표가 아무 데도 도달하지 않는다. 실제로 2026-07-21 개발서버는
   *   미설정 상태였고, 미적재 오더 유실 1건을 배포 검증 중 **우연히** 발견했다.
   *   10분마다 경고하면 소음이 되므로 기동 시 1회만 남긴다(상태는 status()에도 실어 화면에 표시).
   */
  onModuleInit(): void {
    if (!this.settings.get('OPS_WEBHOOK_URL')) {
      this.logger.error(
        '외부 알림 채널 미구성(OPS_WEBHOOK_URL) — 연계 이상이 외부로 통보되지 않습니다. ' +
        'LIS 알림함으로만 표시되므로 운영자가 화면을 봐야 인지합니다.',
      );
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  private stuckMinutes(): number {
    return this.settings.getNumber('OPS_STUCK_MINUTES', 30);
  }

  /** 현재 연계 운영 지표 집계(엔드포인트·크론 공용). */
  async metrics(): Promise<IntegrationMetrics> {
    const stuckBefore = new Date(Date.now() - this.stuckMinutes() * 60_000);
    const outboundIf = { in: ['IF-RX', 'IF-G08'] };
    // ★장비 결과 수집(IF-INSTR, INBOUND)은 감시 대상 밖이었다. 이 경로가 조용히 죽으면
    //   결과가 아예 들어오지 않는데 지표·알림 어디에도 잡히지 않는다.
    const [dlqDepth, stuckOutbound, oldestStuck, undeliveredCritical, instrumentFailed, orderCancelFailed, droppedOrders, hl7OrderFailed, pollState, mwlFailed, billingPending] = await Promise.all([
      this.prisma.interfaceLog.count({ where: { ifId: outboundIf, direction: 'OUTBOUND', status: 'DLQ' } }),
      this.prisma.interfaceLog.count({
        where: { ifId: outboundIf, direction: 'OUTBOUND', status: { in: ['STAGED', 'FAILED', 'SENDING'] }, createdDt: { lt: stuckBefore } },
      }),
      this.prisma.interfaceLog.findFirst({
        where: { ifId: outboundIf, direction: 'OUTBOUND', status: { in: ['STAGED', 'FAILED', 'SENDING'] }, createdDt: { lt: stuckBefore } },
        orderBy: { createdDt: 'asc' },
        select: { createdDt: true },
      }),
      // ★'미전달'이 아니라 '미확인'을 센다.
      //   dispatchStatus로만 거르면 웹훅이 200을 받았지만 수신자가 확인하지 않은 건이 0으로 집계되어,
      //   폐루프가 닫히지 않은 상태를 감시가 놓친다(임상 안전 직결).
      //   갓 생성된 건까지 세면 상시 경보가 되므로 stuck 임계 시간이 지난 것만 센다.
      this.prisma.criticalNotify.count({ where: { ackDt: null, createdDt: { lt: stuckBefore } } }),
      this.prisma.interfaceLog.count({
        where: { ifId: 'IF-INSTR', direction: 'INBOUND', status: { in: ['FAILED', 'PARTIAL'] }, createdDt: { gt: stuckBefore } },
      }),
      // ★HIS 오더 취소 적용 실패 — 워터마크가 붙잡혀 재시도되지만 계속 실패하면
      //   취소된 검사가 계속 수행·보고된다. 지표로 세워 사람이 개입하게 한다.
      this.prisma.interfaceLog.count({
        where: { ifId: 'IF-HISORD', direction: 'INBOUND', status: 'FAILED', createdDt: { gt: stuckBefore } },
      }),
      // ★미적재 오더는 시간이 지나도 저절로 해소되지 않는다(워터마크가 이미 지나감).
      //   최근 창이 아니라 **적체 총량**을 센다 — 오래된 것일수록 더 위험하다.
      this.prisma.interfaceLog.count({
        where: { ifId: 'IF-HISORD', direction: 'INBOUND', status: 'DROPPED' },
      }),
      // ★HL7 푸시(MLLP OML, IF-03) 오더 수신 실패 — FHIR-poll과 달리 재적재 큐가 없어 유실되는데 감시 사각이었다.
      this.prisma.interfaceLog.count({
        where: { ifId: 'IF-03', direction: 'INBOUND', status: 'FAILED', createdDt: { gt: stuckBefore } },
      }),
      // ★폴링 신선도 — 워터마크가 언제 마지막으로 움직였나. 폴링이 죽으면 이 값만 커진다.
      this.prisma.integrationState.findUnique({ where: { key: 'orders_watermark' }, select: { updatedDt: true } }),
      // PACS 워크리스트 송신 실패(IF-09) — 병리 접수는 됐는데 스캔 워크리스트가 없는 상태
      this.prisma.interfaceLog.count({
        where: { ifId: 'IF-09', direction: 'OUTBOUND', status: 'FAILED', createdDt: { gt: stuckBefore } },
      }),
      // ERP 청구 미전송 정체 — REJECTED(업무 반송)는 제외하고 PENDING만 센다
      this.prisma.billingClaim.count({ where: { status: 'PENDING', createdDt: { lt: stuckBefore } } }),
    ]);
    const oldestStuckAgeMin = oldestStuck ? Math.round((Date.now() - oldestStuck.createdDt.getTime()) / 60_000) : null;
    /**
     * 폴링이 꺼져 있으면 정체를 따지지 않는다(null) — 의도적으로 끈 것을 이상으로 보고하면
     * 경보가 상시 울려 다른 신호가 묻힌다. 켜져 있는데 워터마크가 안 움직이는 것만 이상이다.
     * 워터마크 자체가 없으면(최초 기동) 아직 판단 불가 → null.
     */
    const pollOn = process.env.HIS_ORDER_POLL === 'on';
    const orderPollStaleMin = pollOn && pollState
      ? Math.round((Date.now() - pollState.updatedDt.getTime()) / 60_000)
      : null;
    // ERP 미구성이면 전부 PENDING으로 쌓이는 게 정상이라 정체로 보지 않는다(상시 경보 방지)
    const billingStuck = process.env.ERP_BILLING_URL ? billingPending : null;
    return { dlqDepth, stuckOutbound, oldestStuckAgeMin, undeliveredCritical, instrumentFailed, orderCancelFailed, droppedOrders, hl7OrderFailed, orderPollStaleMin, mwlFailed, billingStuck };
  }

  /** 지표 + 임계 판정(엔드포인트 응답) + 알림 채널 구성 상태. */
  async status(): Promise<IntegrationMetrics & HealthVerdict & { externalAlertConfigured: boolean }> {
    const m = await this.metrics();
    return {
      ...m,
      ...evaluateIntegrationHealth(m, thresholdsFromEnv(process.env)),
      // 화면이 "감시가 살아 있는지"를 보여줄 수 있게 — 미구성이면 지표가 어디에도 도달하지 않는다.
      externalAlertConfigured: !!this.settings.get('OPS_WEBHOOK_URL'),
    };
  }

  @Cron(CronExpression.EVERY_10_MINUTES)
  async monitor(): Promise<void> {
    if (process.env.OPS_MONITOR === 'off') return;
    let s: IntegrationMetrics & HealthVerdict;
    try {
      s = await this.status();
    } catch (e) {
      this.logger.error(`연계 감시 집계 실패: ${e instanceof Error ? e.message : e}`);
      return;
    }
    if (s.healthy) {
      await this.resolveOpenAlert().catch((e) => this.logger.warn(`경보 해소 처리 실패: ${e instanceof Error ? e.message : e}`));
      return;
    }
    const summary = s.breaches.join(' · ');
    this.logger.error(`⚠ 연계 운영 이상: ${summary}`);
    // ★알림함에도 올린다. 외부 웹훅이 미구성이면 로그가 유일한 경로인데 로그는 아무도 읽지 않는다.
    //   알림함은 운영자가 이미 보는 화면이고 사이드바 배지에 잡힌다.
    await this.notifyOpenAlert(summary).catch((e) => this.logger.warn(`알림함 경보 생성 실패: ${e instanceof Error ? e.message : e}`));
    await this.alert(s).catch((e) => this.logger.warn(`OPS 알림 전송 실패: ${e instanceof Error ? e.message : e}`));
  }

  /**
   * 미확인 연계경보를 **1건만 유지**한다. 10분 주기로 새로 만들면 하루 144건이 쌓여
   * 알림함이 무용지물이 되고, 정작 임상 알림이 묻힌다.
   *  - 열린 경보가 없으면 생성
   *  - 있고 내용이 같으면 그대로 둔다(재알림 없음 — 이미 미확인 상태)
   *  - 있고 내용이 바뀌었으면 메시지만 갱신(현재 상태를 반영)
   */
  private async notifyOpenAlert(summary: string): Promise<void> {
    const message = `연계 운영 이상: ${summary}`;
    const open = await this.prisma.notification.findFirst({
      where: { ntype: this.ALERT_NTYPE, ackDt: null },
      orderBy: { createdDt: 'desc' },
    });
    if (!open) {
      await this.prisma.notification.create({
        data: { notifyId: `NTF-OPS-${Date.now().toString(36).toUpperCase()}`, ntype: this.ALERT_NTYPE, target: 'INTEGRATION', message, createdDt: new Date() },
      });
      this.logger.error(`연계경보 알림 생성: ${summary}`);
      return;
    }
    if (open.message !== message) {
      await this.prisma.notification.update({ where: { notifyId: open.notifyId }, data: { message } });
    }
  }

  /**
   * 정상 복귀 시 열린 경보를 닫는다 — 닫지 않으면 배지가 영구히 켜져 있어 곧 무시된다.
   * 사람이 확인하지 않았음을 남기기 위해 메시지에 자동 해소임을 표기한다(이력 보존).
   */
  private async resolveOpenAlert(): Promise<void> {
    const open = await this.prisma.notification.findMany({ where: { ntype: this.ALERT_NTYPE, ackDt: null } });
    for (const n of open) {
      await this.prisma.notification.update({
        where: { notifyId: n.notifyId },
        data: { ackDt: new Date(), message: `${n.message ?? ''} — 자동 해소(지표 정상 복귀, 사람 확인 없음)` },
      });
    }
    if (open.length) this.logger.log(`연계경보 자동 해소 ${open.length}건 — 지표 정상 복귀`);
  }

  /** OPS_WEBHOOK_URL로 이상 알림(best-effort). 미설정 시 로깅으로 대체(이미 monitor에서 error 로깅). */
  private async alert(s: IntegrationMetrics & HealthVerdict): Promise<void> {
    const url = this.settings.get('OPS_WEBHOOK_URL');
    if (!url) return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      await fetch(url, {
        method: 'POST',
        redirect: 'error', // 저장 시점 호스트 검증의 302 우회 차단(SSRF 완화)
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          kind: 'lis-integration-health',
          dlqDepth: s.dlqDepth,
          stuckOutbound: s.stuckOutbound,
          oldestStuckAgeMin: s.oldestStuckAgeMin,
          undeliveredCritical: s.undeliveredCritical,
          breaches: s.breaches,
        }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
