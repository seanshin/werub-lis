/**
 * CriticalNotifierService — result 도메인 서비스.
 *
 * 주요 진입점: `onCritical()`, `dispatch()`, `escalateStale()`, `retryUndelivered()`
 * 스케줄 작업 2건 — env 스위치로 켜고 끈다(운영단계 정의서 §4 참조).
 * 이벤트 구독: `critical.created`.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, Logger } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';

/**
 * 위험치 실통보 디스패처 — DB 기록에 그치지 않고 실제 채널로 전파.
 * 채널: 환경변수 CRITICAL_WEBHOOK_URL(HIS 메신저/SMS 게이트웨이 어댑터).
 * 미설정 시 PENDING으로 남겨 재발송 대상으로 표시. (기획 22 §6-6)
 */
/** 위험치 통보 에스컬레이션 사다리 — 미확인 시 순차 상향. */
const ESCALATION_TIERS = ['담당의', '수간호사', '당직전문의'];

@Injectable()
export class CriticalNotifierService {
  private readonly logger = new Logger(CriticalNotifierService.name);
  private escalateInFlight = false; // 크론 중첩 가드(웹훅 무응답 시 주기 초과 대비)
  private retryInFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** 미확인 위험치 상향 간격(분, 기본 15) — 이 시간 지나도 ack 없으면 다음 계층으로. */
  private escalationMinutes(): number {
    return this.settings.getNumber('CRITICAL_ESCALATION_MINUTES', 15);
  }

  @OnEvent('critical.created')
  async onCritical(payload: { notifyId: string }): Promise<void> {
    await this.dispatch(payload.notifyId).catch((e) =>
      this.logger.warn(`위험치 통보 디스패치 실패: ${e instanceof Error ? e.message : e}`),
    );
  }

  /**
   * 전송 대상 URL 검증 — 환자 식별정보와 임상수치가 나가는 경로이므로 평문(http)은 거부한다.
   * 원내 전용 HTTP 게이트웨이를 부득이 써야 하면 CRITICAL_WEBHOOK_ALLOW_HTTP=on으로 명시 승인.
   * 잘못 설정된 URL로 PHI가 반복 발송되는 것을 막기 위해 파싱 실패도 미전송 처리한다.
   */
  private webhookUrl(): string | null {
    const raw = this.settings.get('CRITICAL_WEBHOOK_URL');
    if (!raw) return null;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      this.logger.error('CRITICAL_WEBHOOK_URL 형식 오류 — 위험치 웹훅 미전송(유선 통보 필요)');
      return null;
    }
    if (u.protocol === 'https:') return raw;
    if (u.protocol === 'http:' && this.settings.getBool('CRITICAL_WEBHOOK_ALLOW_HTTP')) return raw;
    this.logger.error(`CRITICAL_WEBHOOK_URL이 https가 아닙니다(${u.protocol}) — PHI 평문 전송 방지로 미전송`);
    return null;
  }

  /** 위험치 통보를 실제 채널로 전송하고 상태를 기록. 수동 재발송에도 사용. */
  async dispatch(notifyId: string): Promise<{ notifyId: string; dispatchStatus: string }> {
    const cn = await this.prisma.criticalNotify.findUnique({
      where: { notifyId },
      include: { result: { include: { specimen: { include: { order: { include: { patient: true } } } } } } },
    });
    if (!cn) return { notifyId, dispatchStatus: 'FAILED' };

    // 소스 무관 통보 페이로드 — Result 연결이 있으면 그 값, 없으면(미생물 등) 비정규화 필드 사용.
    const p = cn.result?.specimen?.order?.patient;
    const payloadCore = cn.result
      ? { category: cn.category ?? 'CHEM', testCode: cn.result.testCode, value: cn.result.value, flag: cn.result.flag, specimenNo: cn.result.specimenNo, patientId: p?.patientId ?? cn.patientId, patientName: p?.name ?? cn.patientName }
      : { category: cn.category ?? 'MICRO', testCode: cn.label, value: cn.value, flag: null as string | null, specimenNo: cn.specimenNo, patientId: cn.patientId, patientName: cn.patientName };

    const url = this.webhookUrl();
    let status = 'PENDING';
    let method = cn.notifyMethod ?? '유선';

    if (url) {
      method = 'WEBHOOK';
      // 이 페이로드는 사내 메신저·SMS 게이트웨이 등 **LIS 밖으로** 나간다.
      //   위험치 통보는 담당의가 즉시 환자를 특정할 수 있어야 하므로 식별자는 필요하지만,
      //   외부 채널에 환자 실명을 그대로 흘리지는 않는다(CRITICAL_WEBHOOK_FULL_NAME=on 시에만 전체).
      //   기본은 성 + 마스킹(홍*동)이며, 정확한 확인은 LIS 화면에서 하도록 유도한다.
      const body = JSON.stringify({
        notifyId,
        resultId: cn.resultId,
        sourceRef: cn.sourceRef,
        ...payloadCore,
        patientName: maskName(payloadCore.patientName, this.settings.getBool('CRITICAL_WEBHOOK_FULL_NAME')),
        target: cn.notifyTarget,
      });
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 5000);
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...signHeaders(body, this.settings.get('CRITICAL_WEBHOOK_SECRET')) },
          body,
          signal: ctrl.signal,
          redirect: 'error', // 302로 위험치 페이로드가 다른 호스트로 흘러가는 것 차단
        });
        clearTimeout(timer);
        status = res.ok ? 'SENT' : 'FAILED';
      } catch {
        status = 'FAILED';
      }
    }

    await this.prisma.criticalNotify.update({
      where: { notifyId },
      data: {
        dispatchStatus: status,
        notifyMethod: method,
        notifiedDt: status === 'SENT' ? new Date() : cn.notifiedDt,
      },
    });
    return { notifyId, dispatchStatus: status };
  }

  /**
   * 미전달 위험치 통보 자동 재발송(5분) — 미확인(ack 전) & 미전송(PENDING/FAILED) 대상.
   * 위험치 통보 유실은 환자안전 사고이므로 확인될 때까지 재시도. 채널 미설정 시 크게 경고.
   */
  /**
   * 미확인 위험치 에스컬레이션(5분 크론) — 마지막 통보(escalatedDt ?? notifiedDt ?? createdDt) 이후
   * 상향간격이 지나도 ack 없으면 다음 계층으로 target 상향 + 재통보. 최상위 계층 도달 시 상향만 멈추고
   * 재통보는 계속. 미확인 위험치가 조용히 방치되지 않도록.
   */
  @Cron('0 */3 * * * *')
  async escalateStale(): Promise<void> {
    // [cron-guard:escalateStale] 크론에서 던진 예외는 unhandledRejection이 되어 프로세스를 죽인다.
    //   죽지 않더라도 조용히 멈추면 다음 주기까지 아무도 모르므로 반드시 로깅한다.
    // ★중첩 가드: dispatch가 웹훅 5초 타임아웃×최대 100건 순차라 수신측 무응답이면
    //   한 주기가 3분을 넘는다 — 다음 틱과 겹치면 커넥션·소켓이 누적된다.
    if (this.escalateInFlight) return;
    this.escalateInFlight = true;
    try {
      if (process.env.CRITICAL_RETRY === 'off') return;
      const windowMs = this.escalationMinutes() * 60_000;
      // ★orderBy 필수 — Postgres는 정렬 없는 LIMIT의 순서를 보장하지 않는다.
      //   미확인 위험치가 상한을 넘으면 매 주기 '임의의 100건'만 처리되어 나머지가 영구 누락될 수 있다.
      const CAP = 100;
      const stale = await this.prisma.criticalNotify.findMany({
        where: { ackDt: null },
        orderBy: { createdDt: 'asc' }, // 오래된 것부터
        take: CAP,
      });
      if (stale.length === CAP) {
        this.logger.error(`⚠ 미확인 위험치가 처리 상한(${CAP})에 도달 — 적체 발생. 즉시 확인 필요`);
      }
      const now = Date.now();
      for (const cn of stale) {
        const ref = (cn.escalatedDt ?? cn.notifiedDt ?? cn.createdDt).getTime();
        if (now - ref < windowMs) continue;
        const nextLevel = Math.min(cn.escalationLevel + 1, ESCALATION_TIERS.length - 1);
        if (nextLevel === cn.escalationLevel) {
          // 최상위 계층까지 갔는데도 미확인 — 여기서 조용히 멈추면 아무도 모른다.
          this.logger.error(
            `⚠ 위험치 미확인이 최상위 에스컬레이션에 도달(${cn.notifyId}) — 확인자 없음. 유선 확인 필요`,
          );
          continue;
        } // 이미 최상위 — 재통보는 retryUndelivered가 담당
        await this.prisma.criticalNotify.update({
          where: { notifyId: cn.notifyId },
          data: { escalationLevel: nextLevel, notifyTarget: ESCALATION_TIERS[nextLevel], escalatedDt: new Date(), dispatchStatus: 'PENDING' },
        });
        this.logger.warn(`⚠ 위험치 통보 상향 ${cn.notifyId}: ${ESCALATION_TIERS[cn.escalationLevel]}→${ESCALATION_TIERS[nextLevel]}(미확인 ${Math.round((now - ref) / 60000)}분)`);
        await this.dispatch(cn.notifyId).catch(() => undefined);
      }
  
    } catch (e) {
      this.logger.error(`크론 escalateStale 실패: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.escalateInFlight = false;
    }
}

  @Cron('0 */5 * * * *')
  async retryUndelivered(): Promise<void> {
    // [cron-guard:retryUndelivered] 크론에서 던진 예외는 unhandledRejection이 되어 프로세스를 죽인다.
    //   죽지 않더라도 조용히 멈추면 다음 주기까지 아무도 모르므로 반드시 로깅한다.
    if (this.retryInFlight) return; // 중첩 가드(웹훅 무응답 시 주기 초과 대비)
    this.retryInFlight = true;
    try {
      if (process.env.CRITICAL_RETRY === 'off') return;
      const RETRY_CAP = 100;
      const pending = await this.prisma.criticalNotify.findMany({
        where: { ackDt: null, dispatchStatus: { in: ['PENDING', 'FAILED'] } },
        orderBy: { createdDt: 'asc' }, // 정렬 없는 LIMIT은 재발송 대상이 매 주기 달라진다
        take: RETRY_CAP,
      });
      if (pending.length === RETRY_CAP) {
        this.logger.error(`⚠ 위험치 재발송 대기가 상한(${RETRY_CAP})에 도달 — 전송 채널 점검 필요`);
      }
      if (pending.length === 0) return;
      if (!this.settings.get('CRITICAL_WEBHOOK_URL')) {
        this.logger.error(`⚠ 위험치 통보 ${pending.length}건 미전달 — 통보 채널 미설정(전송 채널 없음). /admin/settings에서 즉시 구성 필요.`);
        return;
      }
      let sent = 0;
      for (const cn of pending) {
        const r = await this.dispatch(cn.notifyId).catch(() => ({ dispatchStatus: 'FAILED' }));
        if (r.dispatchStatus === 'SENT') sent++;
      }
      this.logger.warn(`위험치 통보 재발송: 대상 ${pending.length} · 성공 ${sent}`);
  
    } catch (e) {
      this.logger.error(`크론 retryUndelivered 실패: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.retryInFlight = false;
    }
}
}

/**
 * 외부 채널로 나가는 환자명 마스킹 — 성 + 마지막 글자만 노출(홍*동 / 홍*).
 * 통보 수신자가 환자를 특정하기엔 충분하고, 메신저·SMS에 실명이 그대로 남지 않는다.
 * 전체 이름이 반드시 필요한 채널은 CRITICAL_WEBHOOK_FULL_NAME=on으로 명시 승인.
 */
export function maskName(name?: string | null, fullNameOverride?: boolean): string | null {
  if (!name) return null;
  if (fullNameOverride ?? process.env.CRITICAL_WEBHOOK_FULL_NAME === 'on') return name;
  const n = name.trim();
  if (n.length <= 1) return n;
  if (n.length === 2) return `${n[0]}*`;
  return `${n[0]}${'*'.repeat(n.length - 2)}${n[n.length - 1]}`;
}

/**
 * 수신측이 통보의 진위를 검증할 수 있도록 HMAC 서명을 붙인다(CRITICAL_WEBHOOK_SECRET 설정 시).
 * 서명이 없으면 엔드포인트 URL만 아는 누구나 가짜 위험치 통보를 주입할 수 있다.
 */
export function signHeaders(body: string, secret?: string): Record<string, string> {
  // 시크릿은 호출자(SettingsService.get)가 단일 해석 — 여기서 process.env로 폴백하면
  //   화면에서 '해제'한 시크릿이 되살아나(cleared 무력화) "껐는데 계속 서명돼 나감"이 된다.
  if (!secret) return {};
  return { 'x-lis-signature': `sha256=${createHmac('sha256', secret).update(body).digest('hex')}` };
}
