/**
 * BillingService — billing 도메인 서비스.
 *
 * 주요 진입점: `onFinalized()`, `captureOrder()`, `unbilled()`, `createClaimBatch()`, `buildClaim()`, `transmit()`, `listClaims()`, `pollClaim()`…
 * 스케줄 작업 1건 — env 스위치로 켜고 끈다(운영단계 정의서 §4 참조).
 * 이벤트 구독: `result.finalized`.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, NotFoundException, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHmac } from 'node:crypto';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { isFinalized } from '../../domain/result-evaluation';
import { buildClaimMessage, claimIdFor, type ClaimItem, type ClaimMessage } from '../../domain/billing-claim';

/**
 * 청구 데이터 파운데이션(D3, C-대) — 확정 결과에서 청구 대상(EDI코드×건수)을 캡처.
 * ⚠ **심평원 EDI 청구파일 생성·수가 산정·비급여 규칙은 규격 대기(stub)** — 여기선 청구 대상 데이터만.
 * 결과 확정(result.finalized) 시 해당 오더의 EDI 매핑 검사를 BillingItem으로 멱등 캡처.
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private sweepInFlight = false; // 크론 중첩 가드 — ERP가 느리면 한 주기가 10분을 넘는다
  constructor(private readonly prisma: PrismaService) {}

  @OnEvent('result.finalized')
  async onFinalized(payload: { specimenNo: string }): Promise<void> {
    const spec = await this.prisma.specimen.findUnique({ where: { specimenNo: payload.specimenNo }, select: { orderId: true } });
    if (spec) await this.captureOrder(spec.orderId).catch(() => undefined);
  }

  /** 오더의 확정 결과 중 EDI 매핑 검사를 청구 대상으로 캡처(검사당 1회, 멱등). */
  async captureOrder(orderId: string) {
    const order = await this.prisma.labOrder.findUnique({
      where: { orderId },
      include: { specimens: { include: { results: { include: { test: true } } } } },
    });
    if (!order) throw new NotFoundException(`오더 없음: ${orderId}`);
    // 확정(AUTO/VERIFIED) 결과의 고유 검사코드
    const finalizedCodes = new Set<string>();
    const nameByCode = new Map<string, string>();
    for (const s of order.specimens) {
      for (const r of s.results) {
        if (isFinalized(r.verifyState)) {
          finalizedCodes.add(r.testCode);
          nameByCode.set(r.testCode, r.test.name);
        }
      }
    }
    if (finalizedCodes.size === 0) return { captured: 0 };
    const mappings = await this.prisma.codeMapping.findMany({ where: { lisCode: { in: [...finalizedCodes] } } });
    const ediByCode = new Map(mappings.map((m) => [m.lisCode, m.ediCode]));
    let captured = 0;
    for (const tc of finalizedCodes) {
      const res = await this.prisma.billingItem.upsert({
        where: { orderId_testCode: { orderId, testCode: tc } },
        update: {}, // 이미 있으면 유지(멱등)
        create: { orderId, patientId: order.patientId, testCode: tc, ediCode: ediByCode.get(tc) ?? null, testName: nameByCode.get(tc) ?? null },
      });
      if (res.capturedDt.getTime() > Date.now() - 5000) captured += 1;
    }
    return { captured };
  }

  /** 미청구(CAPTURED) 목록 — 청구 준비 워크리스트. */
  async unbilled() {
    return this.prisma.billingItem.findMany({ where: { status: 'CAPTURED' }, orderBy: { capturedDt: 'desc' }, take: 500 });
  }

  /**
   * 심평원 EDI 청구 배치 **미리보기(집계만)** — CAPTURED 항목을 EDI코드별로 집계해 반환.
   * ⚠ 상태를 바꾸지 않는다: 과거엔 여기서 CAPTURED→CLAIMED로 전이해 ERP 전송 큐(CAPTURED만 대상)에서
   *   항목을 가로채 미전송으로 남기는 문제가 있었다. 실 심평원 EDI 파일 포맷·수가 산정은 규격 확정 후 구현.
   */
  async createClaimBatch(from?: string, to?: string) {
    const where = {
      status: 'CAPTURED',
      ...(from || to ? { capturedDt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
    };
    const items = await this.prisma.billingItem.findMany({ where });
    if (items.length === 0) return { batchId: null, count: 0, byEdi: {}, note: '청구 대상 없음' };
    const byEdi: Record<string, number> = {};
    for (const it of items) byEdi[it.ediCode ?? '(미매핑)'] = (byEdi[it.ediCode ?? '(미매핑)'] ?? 0) + it.quantity;
    return { batchId: null, count: items.length, byEdi, note: '⚠ 미리보기(집계만) — 상태 미변경. 실제 청구는 ERP 전송 경로, 심평원 EDI 파일은 규격 대기' };
  }

  // ──────────────────────────────────────────────────────────────
  // ERP 청구 전송(API HMAC 웹훅) — 확정 규격: 1메시지=1오더·실시일·FINAL·EDI 미포함(ERP 산정).
  //   docs/ERP_회신_LIS답신_청구연동_2026-07-24.md
  // ──────────────────────────────────────────────────────────────

  /** 오더 → ERP 청구 메시지 조립. 실시일=검체 채취일(없으면 접수일), 검체·결과상태는 확정결과에서 조인. */
  async buildClaim(orderId: string): Promise<{ items: { billingId: string }[]; msg: ClaimMessage }> {
    const order = await this.prisma.labOrder.findUnique({
      where: { orderId },
      include: { specimens: { include: { results: { include: { test: true } } } } },
    });
    if (!order) throw new NotFoundException(`오더 없음: ${orderId}`);
    // 정정은 ERP 역분개(전량 재기술) — 취소 안 된 이 오더의 청구항목 전체를 대상으로 한다(ERP 규격 E-7).
    //   델타(신규 CAPTURED)만 보내면 재기술 시 기존 항목이 사라지거나(A,B 유실) 리비전이 무시된다.
    const billItems = await this.prisma.billingItem.findMany({ where: { orderId, status: { not: 'CANCELLED' } } });
    const capturedItems = billItems.filter((i) => i.status === 'CAPTURED');

    // 검사별 확정결과에서 검체종류·결과상태, 오더 실시일(채취일 우선, 없으면 접수일 — 가장 이른 날)
    const byCode = new Map<string, { specimen: string | null; resultStatus: string; testName: string }>();
    let performedOn: string | null = null;
    for (const s of order.specimens) {
      const d = s.collectedDt ?? s.receivedDt;
      const ymd = d ? d.toISOString().slice(0, 10) : null;
      if (ymd && (!performedOn || ymd < performedOn)) performedOn = ymd;
      for (const r of s.results) {
        if (isFinalized(r.verifyState) && !byCode.has(r.testCode)) {
          byCode.set(r.testCode, { specimen: s.specimenType, resultStatus: r.verifyState ?? 'FINAL', testName: r.test.name });
        }
      }
    }
    // 재기술 항목 = 현재 확정(FINAL)인 청구항목만. 철회돼 더는 확정이 아닌 항목은 빼서 ERP가 역분개하게 한다
    //   (기존엔 status를 못 찾으면 'FINAL'로 지어내 비확정 결과를 FINAL로 청구하는 버그가 있었다).
    const claimItems: ClaimItem[] = billItems
      .filter((it) => byCode.has(it.testCode))
      .map((it) => {
        const rr = byCode.get(it.testCode)!;
        return { testCode: it.testCode, testName: it.testName ?? rr.testName, quantity: it.quantity, specimen: rr.specimen, resultStatus: rr.resultStatus };
      });
    const existing = await this.prisma.billingClaim.findUnique({ where: { claimId: claimIdFor(orderId) } });
    // 리비전은 **성공(SENT/ACCEPTED)한 청구에 새 항목/정정이 붙을 때만** ++ (실 정정). 미성공(PENDING/REJECTED) 재시도는 같은 리비전 유지.
    const revision = existing
      ? (existing.status === 'SENT' || existing.status === 'ACCEPTED' ? existing.revision + 1 : existing.revision)
      : 1;
    // visitId — HIS 오더가 encounter를 실어주면 LabOrder.visitId에 보관됨(방문 단위 청구 묶음 근거)
    const msg = buildClaimMessage({ orderId, patientId: order.patientId, revision, visitId: order.visitId, performedOn, items: claimItems });
    return { items: capturedItems.map((i) => ({ billingId: i.billingId })), msg };
  }

  /** ERP로 HMAC 서명 POST. 미구성(ERP_BILLING_URL 없음)이면 로컬 스테이징(PENDING) — 유실 없음. */
  private async sendClaim(msg: ClaimMessage): Promise<{ status: string; sent: boolean; rejectReason?: string }> {
    const url = process.env.ERP_BILLING_URL;
    if (!url) return { status: 'PENDING', sent: false }; // 미구성 — 전송 보류(재시도 대상)
    const secret = process.env.ERP_BILLING_SECRET;
    // URL은 있는데 시크릿이 아직 없으면(개시 직전 흔한 창) 서명 없이 보내면 ERP가 4xx→REJECTED로 굳는다.
    //   서명 없이 실 청구를 보내지 말고 PENDING 유지 → 시크릿 주입 시 sweep이 자동 전송(유실·미서명 전송 없음).
    if (!secret) return { status: 'PENDING', sent: false, rejectReason: '서명 시크릿(ERP_BILLING_SECRET) 미구성 — 주입 시 자동 전송' };
    const body = JSON.stringify(msg);
    const ts = Math.floor(Date.now() / 1000).toString();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (secret) {
      // X-Integration-Signature = HMAC-SHA256(`<ts>.<body>`) — ts를 서명에 결속(재전송 방지, skew 300s는 ERP 검증)
      headers['X-Integration-Ts'] = ts;
      headers['X-Integration-Signature'] = `sha256=${createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex')}`;
    }
    try {
      const res = await fetch(url, { method: 'POST', headers, body });
      if (res.ok) return { status: 'SENT', sent: true };
      const txt = await res.text().catch(() => '');
      // 4xx = ERP 반송(수정 필요) / 5xx·네트워크 = 일시장애(PENDING 유지로 재시도)
      if (res.status >= 400 && res.status < 500) return { status: 'REJECTED', sent: false, rejectReason: `HTTP ${res.status} ${txt.slice(0, 200)}` };
      return { status: 'PENDING', sent: false, rejectReason: `HTTP ${res.status}(일시장애·재시도)` };
    } catch (e) {
      return { status: 'PENDING', sent: false, rejectReason: e instanceof Error ? e.message : '전송 실패(재시도)' };
    }
  }

  /**
   * 청구 전송 — CAPTURED 항목을 오더별로 묶어 ERP에 송신. orderId 지정 시 해당 오더만.
   * 전송 성공(SENT) 시 항목을 CLAIMED로 전이(멱등). 실패/보류면 CAPTURED 유지(재시도).
   */
  async transmit(opts?: { orderId?: string }) {
    const orderIds = opts?.orderId
      ? [opts.orderId]
      : [...new Set((await this.prisma.billingItem.findMany({ where: { status: 'CAPTURED' }, select: { orderId: true } })).map((x) => x.orderId))];
    const claims: { claimId: string; status: string; items: number; rejectReason?: string }[] = [];
    for (const oid of orderIds) {
      const { items, msg } = await this.buildClaim(oid);
      if (items.length === 0) continue; // 이 오더에 새로 청구할 CAPTURED 항목이 없음
      const outcome = await this.sendClaim(msg);
      /**
       * 연계 로그에도 남긴다 — 청구는 자체 상태(BillingClaim)로 관리되지만, 운영자는 연계 이상을
       * `/admin/integration` 한 화면에서 본다. ERP만 그 화면 밖에 있으면 "전 채널을 봤다"고
       * 믿는 순간 사각이 생긴다.
       * 재전송이 같은 행을 갱신하도록 upsert — (direction, mcid) 유니크라 create면 재시도에서 터진다.
       * mcid에 revision을 붙여 정정본(리비전 증가)은 별 행으로 남긴다(전송 이력 보존).
       */
      await this.prisma.interfaceLog
        .upsert({
          where: { direction_messageControlId: { direction: 'OUTBOUND', messageControlId: `${msg.lisBillingId}#r${msg.revision}` } },
          update: { status: outcome.sent ? 'PROCESSED' : outcome.status === 'REJECTED' ? 'FAILED' : 'STAGED', errorText: outcome.rejectReason ?? null },
          create: {
            ifId: 'IF-ERP', direction: 'OUTBOUND', messageType: 'BillingClaim',
            messageControlId: `${msg.lisBillingId}#r${msg.revision}`,
            status: outcome.sent ? 'PROCESSED' : outcome.status === 'REJECTED' ? 'FAILED' : 'STAGED',
            errorText: outcome.rejectReason ?? null,
          },
        })
        .catch((e) => this.logger.warn(`청구 연계로그 기록 실패 ${msg.lisBillingId}: ${e instanceof Error ? e.message : e}`));
      const itemCount = msg.items.length; // 청구 메시지의 실제 항목 수(전량 재기술) — CAPTURED 델타가 아니라
      await this.prisma.billingClaim.upsert({
        where: { claimId: msg.lisBillingId },
        update: { revision: msg.revision, patientId: msg.patientId, visitId: msg.visitId ?? null, performedOn: msg.performedOn, itemCount, status: outcome.status, attempts: { increment: 1 }, rejectReason: outcome.rejectReason ?? null, ...(outcome.sent ? { sentDt: new Date() } : {}), ...(outcome.status === 'ACCEPTED' ? { ackDt: new Date() } : {}) },
        create: { claimId: msg.lisBillingId, orderId: oid, revision: msg.revision, patientId: msg.patientId, visitId: msg.visitId ?? null, performedOn: msg.performedOn, itemCount, status: outcome.status, attempts: 1, rejectReason: outcome.rejectReason ?? null, sentDt: outcome.sent ? new Date() : null },
      });
      if (outcome.sent) {
        await this.prisma.billingItem.updateMany({ where: { orderId: oid, status: 'CAPTURED' }, data: { status: 'CLAIMED', claimBatchId: msg.lisBillingId } });
      }
      claims.push({ claimId: msg.lisBillingId, status: outcome.status, items: items.length, rejectReason: outcome.rejectReason });
    }
    return { transmitted: claims.filter((c) => c.status === 'SENT' || c.status === 'ACCEPTED').length, total: claims.length, claims };
  }

  /** 청구 전송 상태 목록(반송 워크리스트 포함). status로 필터. */
  async listClaims(status?: string) {
    return this.prisma.billingClaim.findMany({ where: status ? { status } : {}, orderBy: { createdDt: 'desc' }, take: 500 });
  }

  /** ERP 상태 폴링(GET .../lis/billing/{id}) — ACCEPTED/REJECTED 반영. 미구성이면 현재값 반환. */
  async pollClaim(claimId: string) {
    const claim = await this.prisma.billingClaim.findUnique({ where: { claimId } });
    if (!claim) throw new NotFoundException(`청구 전송 없음: ${claimId}`);
    const url = process.env.ERP_BILLING_URL;
    if (!url) return claim;
    const ts = Math.floor(Date.now() / 1000).toString();
    const secret = process.env.ERP_BILLING_SECRET;
    const headers: Record<string, string> = {};
    if (secret) {
      headers['X-Integration-Ts'] = ts;
      headers['X-Integration-Signature'] = `sha256=${createHmac('sha256', secret).update(`${ts}.${claimId}`).digest('hex')}`;
    }
    try {
      const res = await fetch(`${url.replace(/\/$/, '')}/${encodeURIComponent(claimId)}`, { headers });
      if (res.ok) {
        const j = (await res.json()) as { status?: string; rejectReason?: string; error?: string; reason?: string; message?: string };
        const st = j.status && ['ACCEPTED', 'REJECTED', 'SENT', 'PENDING'].includes(j.status) ? j.status : claim.status;
        // ERP는 반송 사유를 rejectReason/error/reason/message 중 하나로 줄 수 있다 — 폭넓게 수용해 워크리스트에 표시
        const reason = j.rejectReason ?? j.error ?? j.reason ?? j.message ?? null;
        return this.prisma.billingClaim.update({ where: { claimId }, data: { status: st, rejectReason: st === 'REJECTED' ? reason : null, ...(st === 'ACCEPTED' ? { ackDt: new Date() } : {}) } });
      }
    } catch { /* 폴링 실패는 현재값 유지 */ }
    return claim;
  }

  /**
   * 청구 전송 자율화 — ① PENDING(미구성·일시장애·시크릿 대기분) 재전송 ② SENT 상태 폴링(ACCEPTED/REJECTED 표면화).
   * ERP 미구성이면 skip(재시도해도 PENDING 유지라 무의미). 크론·수동 모두 이 메서드 사용.
   */
  async sweep() {
    if (!process.env.ERP_BILLING_URL) return { skipped: true, retried: 0, polled: 0, accepted: 0, rejected: 0 };
    // ① PENDING 재전송 — 시크릿 주입 순간 backlog 자동 전송.
    //   orderBy: 정렬 없는 LIMIT은 대상이 매 주기 비결정적 — 적체가 200을 넘으면
    //   같은 건만 반복 처리되고 뒤쪽은 영원히 확인되지 않는 기아가 생긴다. 오래된 것부터.
    const pending = await this.prisma.billingClaim.findMany({ where: { status: 'PENDING' }, select: { orderId: true }, orderBy: { updatedDt: 'asc' }, take: 200 });
    let retried = 0;
    for (const oid of [...new Set(pending.map((p) => p.orderId))]) {
      try { const r = await this.transmit({ orderId: oid }); retried += r.claims.length; } catch (e) { this.logger.warn(`청구 재전송 실패 ${oid}: ${e instanceof Error ? e.message : e}`); }
    }
    // ② SENT·REJECTED 폴링 — 수납확정(ACCEPTED) 자동 반영. REJECTED도 재폴링하는 이유:
    //   ERP가 FAILED/DEAD 건을 자동 재큐→ACCEPTED로 완결하므로, 반송 상태에서도 회복을 감지해야 한다.
    const sent = await this.prisma.billingClaim.findMany({ where: { status: { in: ['SENT', 'REJECTED'] } }, select: { claimId: true }, orderBy: { updatedDt: 'asc' }, take: 200 });
    let polled = 0, accepted = 0, rejected = 0;
    for (const c of sent) {
      try {
        const after = await this.pollClaim(c.claimId); polled += 1;
        if (after.status === 'ACCEPTED') accepted += 1;
        else if (after.status === 'REJECTED') rejected += 1;
      } catch (e) { this.logger.warn(`청구 폴링 실패 ${c.claimId}: ${e instanceof Error ? e.message : e}`); }
    }
    return { skipped: false, retried, polled, accepted, rejected };
  }

  /** 15분마다 청구 전송 자율화(재전송·폴링). ERP 미구성이면 즉시 반환. 크론 예외는 삼키지 않고 로깅. */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async billingSweepCron(): Promise<void> {
    if (process.env.BILLING_SWEEP === 'off') return;
    if (this.sweepInFlight) return; // 이전 주기가 ERP 지연으로 아직 도는 중 — 겹치지 않는다
    this.sweepInFlight = true;
    try {
      const r = await this.sweep();
      if (!r.skipped && (r.retried || r.rejected)) this.logger.log(`청구 sweep: 재전송 ${r.retried} · 폴링 ${r.polled}(수납 ${r.accepted}·반송 ${r.rejected})`);
    } catch (e) {
      this.logger.error(`청구 sweep 실패: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.sweepInFlight = false;
    }
  }
}
