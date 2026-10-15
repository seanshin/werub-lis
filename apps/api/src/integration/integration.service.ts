/**
 * IntegrationService — integration 도메인 서비스.
 *
 * 주요 진입점: `processInbound()`, `buildOruForSpecimen()`, `sendResultViaMllp()`, `buildFhirBundle()`, `onResultFinalized()`, `retryFailedResultSends()`, `onReflexOrdered()`, `sendReflexOrderToHis()`…
 * 스케줄 작업 3건 — env 스위치로 켜고 끈다(운영단계 정의서 §4 참조).
 * 이벤트 구독: `result.finalized`, `reflex.ordered`.
 * 일부 경로는 트랜잭션으로 묶인다 — 부분 반영 시 임상 상태가 깨지는 구간.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, Logger, BadRequestException, NotFoundException, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { parseHl7, mapOml, buildOru, buildAck, buildOrm, buildLabOrm, OruResultLine, ParsedOrder, seg, field, comp } from './hl7';
import { sendMllp } from './mllp';
import { mllpFailureReason, fhirFailureReason, thrownFailureReason, outboundErrorText } from './outbound-failure';
import { buildDiagnosticReport } from './fhir-mapper';
import { resolveViewerLink, buildLauncherUrl, pacsLogin } from './pacs-client';
import { getAccessToken, postDiagnosticReport, httpTimeout, HisFhirConfig } from './his-fhir-client';
import { buildAccession, accessionOverflow, DICOM_ACCESSION_MAX } from '../common/accession.util';
import { timingSafeEqual } from 'crypto';
import { genId } from '../common/id.util';
import { isUniqueViolation } from '../common/prisma-error.util';
import { nextSuffixSeq, formatSeq } from '../domain/numbering';
import { extractHisOrderNo } from '../domain/reflex';
import { InterfaceLogStatus } from '../domain/enums';
import { isFinalized } from '../domain/result-evaluation';
import { nextWatermark } from '../domain/poll-watermark';
import type { PolledOrder } from './his-fhir-client';
import { LabCodeCatalogService } from './lab-code-catalog.service';
import { AuditChainService } from '../modules/audit/audit-chain.service';

/** Reflex 양방향 오더 발신 재시도 임계 — 초과 시 DLQ 격리(무한 재시도 방지). */
const MAX_REFLEX_RETRY = 5;

interface ResolveMaps {
  panels: Map<string, string[]>; // panelCode → testCode[]
  byHis: Map<string, string[]>; // hisCode → lisCode[]
  byEdi: Map<string, string[]>; // ediCode → lisCode[] (1:N 패널)
  tests: Set<string>; // testCode 존재
}

@Injectable()
export class IntegrationService {
  private readonly logger = new Logger(IntegrationService.name);
  private pollInFlight = false; // 크론 중첩 실행 가드(첫 폴링 5분 초과 시 다음 틱과 중첩 방지)
  private reflexPollInFlight = false; // Reflex PreOrder 폴링 중첩 가드(건당 HIS GET — 지연 누적 대비)

  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: LabCodeCatalogService,
    private readonly auditChain: AuditChainService,
  ) {}

  /**
   * 폴링(크론) 경로의 환자 재귀속·취소 전파를 감사 체인에 남긴다.
   * HTTP가 아니라 전역 AuditInterceptor가 못 보는 변경인데, "누가 이 환자의 오더를
   * 옮겼는가"는 수기 병합과 똑같이 1095일 해시체인으로 소명돼야 한다(2026-07-30 보안 검토).
   * fire-and-forget(체인 서비스가 자체 직렬화·실패 로깅) — 폴링 흐름을 막지 않는다.
   */
  private auditSystemChange(target: string, detail: string): void {
    void this.auditChain.append({
      userId: null, // 시스템(크론) 주체 — 사용자 없음
      action: 'SYSTEM',
      target,
      detail: detail.slice(0, 500),
      status: null,
      sensitive: false,
    });
  }

  /**
   * HL7 처방 수신 (IF-03, OML^O21) → 환자/오더/항목 생성.
   * 멱등 처리(MSH-10 중복 무시), 미매핑 코드 보류, ACK 반환.
   * 근거: 07 §1, 09 §2.1
   */
  async processInbound(raw: string): Promise<{ ack: string; result: string; orderId?: string }> {
    const msg = parseHl7(raw);
    const parsed = mapOml(msg);
    const mcid = parsed.messageControlId;

    // 멱등: upfront-claim — 유니크 키(direction+mcid)로 PROCESSING 행을 먼저 원자적 생성.
    // 동시 도착한 동일 메시지의 두번째는 여기서 유니크 위반 → DUPLICATE(중복 오더 생성 방지).
    try {
      await this.prisma.interfaceLog.create({
        data: { ifId: 'IF-03', direction: 'INBOUND', messageType: parsed.messageType, messageControlId: mcid, status: 'PROCESSING', payload: raw },
      });
    } catch (e) {
      if (isUniqueViolation(e)) {
        return { ack: buildAck(mcid, 'AA', 'duplicate ignored'), result: 'DUPLICATE' };
      }
      throw e;
    }

    return this.ingestOml(raw, parsed, mcid);
  }

  /**
   * OML 적재 본체 — 로그행을 PROCESSING으로 **클레임한 뒤** 실행되는 단계.
   * 최초 수신(`processInbound`)과 실패분 재적재(`retryFailedHl7Orders`)가 이 경로를 공유한다.
   * 분리 이유: 재적재는 이미 존재하는 FAILED 행을 원자 전이로 클레임하므로 upfront-create를 다시 할 수 없다.
   * 종료 시 `log()`가 같은 (direction, mcid) 행을 PROCESSED/FAILED로 갱신한다.
   */
  private async ingestOml(raw: string, parsed: ParsedOrder, mcid: string): Promise<{ ack: string; result: string; orderId?: string }> {
    try {
      // 오더 취소(ORC-1=CA) — 기존 오더를 hisOrderNo로 찾아 취소
      if (parsed.orderControl === 'CA') {
        const existing = await this.prisma.labOrder.findFirst({ where: { hisOrderNo: parsed.hisOrderNo } });
        if (!existing) {
          await this.log('INBOUND', parsed, raw, 'FAILED', '취소 대상 오더 없음');
          return { ack: buildAck(mcid, 'AE', 'no order to cancel'), result: 'NO_ORDER' };
        }
        // ★이미 보고(REPORTED)·취소된 항목은 되돌리지 않는다. FHIR 취소 폴링 경로와 동일 규칙.
        //   무조건 CANCELLED로 덮으면 수행·보고·청구까지 끝난 검사가 취소로 뒤집히고,
        //   completeness()가 취소 항목을 제외하므로 **검사를 했다는 사실 자체가 화면에서 사라진다.**
        await this.prisma.$transaction([
          this.prisma.labOrder.update({ where: { orderId: existing.orderId }, data: { status: 'CANCELLED' } }),
          this.prisma.orderItem.updateMany({
            where: { orderId: existing.orderId, status: { notIn: ['REPORTED', 'CANCELLED'] as never } },
            data: { status: 'CANCELLED' },
          }),
        ]);
        await this.log('INBOUND', parsed, raw, 'PROCESSED', 'CANCELLED');
        return { ack: buildAck(mcid, 'AA'), result: 'CANCELLED', orderId: existing.orderId };
      }

      // 오더 변경(ORC-1=XO/RP) — 기존 오더 취소 후 신규 생성(replace)
      if (parsed.orderControl === 'XO' || parsed.orderControl === 'RP') {
        const existing = await this.prisma.labOrder.findFirst({ where: { hisOrderNo: parsed.hisOrderNo } });
        if (existing) {
          await this.prisma.$transaction([
            this.prisma.labOrder.update({ where: { orderId: existing.orderId }, data: { status: 'CANCELLED' } }),
            this.prisma.orderItem.updateMany({ where: { orderId: existing.orderId }, data: { status: 'CANCELLED' } }),
          ]);
        }
        // 이후 생성 로직으로 진행(신규 오더)
      }

      // 병합 재라우팅 — 인바운드가 병합된 구 MRN으로 오면 정본(target)으로 귀속(숨은 레코드에 신규 축적 방지)
      const inboundPt = await this.prisma.patient.findUnique({ where: { patientId: parsed.patient.patientId } });
      if (inboundPt?.status === 'MERGED' && inboundPt.mergedInto) {
        this.logger?.warn?.(`인바운드 환자 ${parsed.patient.patientId} 병합됨 → 정본 ${inboundPt.mergedInto}로 재라우팅`);
        parsed.patient.patientId = inboundPt.mergedInto;
      }

      // 환자 upsert (ADT 미수신 대비)
      await this.prisma.patient.upsert({
        where: { patientId: parsed.patient.patientId },
        update: {},
        create: {
          patientId: parsed.patient.patientId,
          name: `${parsed.patient.familyName}${parsed.patient.givenName}`,
          sex: this.mapSex(parsed.patient.sex),
          birthDate: parsed.patient.birthDate || null,
        },
      });

      // 검사코드 매핑(HIS→LIS). 미매핑 시 보류(에러)
      const lisCodes = await this.resolveTestCodes(parsed.testCodes);
      if (lisCodes.unmapped.length > 0) {
        await this.log('INBOUND', parsed, raw, 'FAILED', `미매핑 코드: ${lisCodes.unmapped.join(',')}`);
        return {
          ack: buildAck(mcid, 'AE', `unmapped: ${lisCodes.unmapped.join(',')}`),
          result: 'UNMAPPED_HOLD',
        };
      }

      // 처방의(ordering provider) — HL7 ORC-12/OBR-16/PV1-7에서 포착. Provider 마스터 upsert 후 FK 결속.
      let orderingProvider: string | null = null;
      const op = parsed.orderingProvider;
      if (op?.id) {
        await this.prisma.provider.upsert({
          where: { providerId: op.id },
          update: {}, // 기존 Provider(큐레이션된 이름·부서)를 매 오더마다 덮어쓰지 않음
          create: { providerId: op.id, name: op.name || op.id, dept: parsed.visit.dept || null, roleType: '처방의' },
        });
        orderingProvider = op.id;
      }

      // 교차 경로 멱등 — 같은 HIS 오더가 FHIR 폴링으로 이미 적재됐으면 재생성하지 않는다.
      // (MSH-10 멱등은 HL7 재전송만 잡는다. 운영에서 HL7+폴링 이중 유입으로 오더 2건이 실제 발생)
      // 신규(NW)만 해당 — XO/RP는 위에서 기존 오더를 취소했으므로 새로 만드는 게 맞다.
      if (parsed.orderControl !== 'XO' && parsed.orderControl !== 'RP' && parsed.hisOrderNo) {
        const dup = await this.prisma.labOrder.findFirst({
          where: { hisOrderNo: parsed.hisOrderNo, status: { notIn: ['CANCELLED'] } },
          select: { orderId: true },
        });
        if (dup) {
          await this.log('INBOUND', parsed, raw, 'PROCESSED', `이미 적재됨(폴링 등): ${dup.orderId}`);
          return { ack: buildAck(mcid, 'AA', 'already ingested'), result: 'EXISTS', orderId: dup.orderId };
        }
      }

      // 오더/항목 생성 — 동일 코드 중복 OBR은 1항목으로(오더당 검사 유일 제약)
      const uniqueCodes = [...new Set(lisCodes.mapped)];
      const orderId = await this.generateOrderId();
      await this.prisma.labOrder.create({
        data: {
          orderId,
          hisOrderNo: parsed.hisOrderNo,
          patientId: parsed.patient.patientId,
          orderingProvider,
          orderDt: new Date(),
          priority: parsed.priority === 'S' ? 'S' : 'R',
          status: 'RECEIVED',
          items: {
            create: uniqueCodes.map((code, i) => ({
              orderItemId: `${orderId}-I${i + 1}`,
              testCode: code,
              status: 'RECEIVED',
            })),
          },
        },
      });

      const isChange = parsed.orderControl === 'XO' || parsed.orderControl === 'RP';
      await this.log('INBOUND', parsed, raw, 'PROCESSED', isChange ? 'CHANGED' : undefined);
      return { ack: buildAck(mcid, 'AA'), result: isChange ? 'CHANGED' : 'CREATED', orderId };
    } catch (e) {
      const errText = e instanceof Error ? e.message : String(e);
      this.logger.error(`처방 수신 실패: ${errText}`);
      await this.log('INBOUND', parsed, raw, 'FAILED', errText);
      return { ack: buildAck(mcid, 'AR', errText), result: 'ERROR' };
    }
  }

  /**
   * 결과 발신용 ORU^R01 생성 (IF-05, 09 §2.2).
   * 확정(F) 결과들을 검체 단위로 묶어 메시지 생성.
   */
  /** HIS 발신 대상 결과만 선별 — 검사코드별 최신 버전 · 확정(F/C) · 검증완료(AUTO/VERIFIED). 미확정·구버전 발신 방지. */
  private latestReportable<T extends { testCode: string; version: number; status: string; verifyState: string }>(results: T[]): T[] {
    const byTest = new Map<string, T>();
    for (const r of results) {
      if (!['F', 'C'].includes(r.status)) continue;
      if (!isFinalized(r.verifyState)) continue;
      const cur = byTest.get(r.testCode);
      if (!cur || r.version > cur.version) byTest.set(r.testCode, r);
    }
    return [...byTest.values()];
  }

  async buildOruForSpecimen(specimenNo: string): Promise<string> {
    const specimen = await this.prisma.specimen.findUnique({
      where: { specimenNo },
      include: {
        order: { include: { patient: true } },
        results: { include: { test: true } },
      },
    });
    if (!specimen) throw new NotFoundException(`검체 없음: ${specimenNo}`); // 라우트 도달 경로 — 500이 아니라 404(Q8)

    const patient = specimen.order.patient;
    const results: OruResultLine[] = [];
    const reportable = this.latestReportable(specimen.results);
    // 참고치 일괄 조회(N+1 제거) — 결과 확정 이벤트마다 타는 경로라 검사 수만큼 왕복하지 않는다.
    const rrRows = reportable.length
      ? await this.prisma.referenceRange.findMany({ where: { testCode: { in: [...new Set(reportable.map((r) => r.testCode))] } } })
      : [];
    const rrByCode = new Map<string, (typeof rrRows)[number]>();
    for (const row of rrRows) if (!rrByCode.has(row.testCode)) rrByCode.set(row.testCode, row);
    for (const r of reportable) {
      const rr = rrByCode.get(r.testCode);
      results.push({
        loinc: r.test.loinc ?? r.testCode,
        testName: r.test.name,
        value: r.value ?? '',
        unit: r.unit ?? '',
        refRange: rr?.low != null && rr?.high != null ? `${rr.low}-${rr.high}` : '',
        flag: r.flag ?? '',
        status: r.status,
      });
    }

    const oru = buildOru({
      sendingApp: 'LIS', receivingApp: 'HIS', facility: 'HOSP',
      messageControlId: `ORU${Date.now()}`,
      nowStamp: this.stamp(),
      patientId: patient.patientId,
      patientName: patient.name,
      hisOrderNo: specimen.order.hisOrderNo ?? specimen.order.orderId,
      specimenNo,
      orderCode: specimen.results[0]?.testCode ?? 'PANEL',
      orderName: '검사결과',
      results,
    });

    await this.prisma.interfaceLog.create({
      data: {
        ifId: 'IF-05', direction: 'OUTBOUND', messageType: 'ORU^R01',
        status: 'PROCESSED', payload: oru,
      },
    });
    return oru;
  }

  /**
   * 결과 발신을 실제 HL7 MLLP로 전송 (IF-05, 실 병원 프로토콜).
   * 대상: 인자 또는 env(HIS_MLLP_HOST/PORT). ACK 코드에 따라 로그 기록.
   */
  async sendResultViaMllp(specimenNo: string, host?: string, port?: number) {
    const oru = await this.buildOruForSpecimen(specimenNo);
    const h = host || process.env.HIS_MLLP_HOST;
    const p = port || Number(process.env.HIS_MLLP_PORT || 0);
    if (!h || !p) {
      throw new BadRequestException('MLLP 대상 미설정(HIS_MLLP_HOST/PORT 또는 인자 필요)');
    }
    const res = await sendMllp(h, p, oru);
    await this.prisma.interfaceLog.create({
      data: {
        ifId: 'IF-05',
        direction: 'OUTBOUND',
        messageType: 'ORU^R01(MLLP)',
        status: res.ackCode === 'AA' ? 'PROCESSED' : 'FAILED',
        errorText: res.ackCode === 'AA' ? null : res.ack,
        payload: oru,
      },
    });
    return { sentTo: `${h}:${p}`, ackCode: res.ackCode, ack: res.ack };
  }

  /**
   * 결과 → FHIR R4 transaction Bundle 생성 (HIS FHIR 연계용).
   * HIS FHIR는 SMART-on-FHIR 인증 필요 → 실 POST는 토큰 확보 후.
   */
  async buildFhirBundle(specimenNo: string) {
    const specimen = await this.prisma.specimen.findUnique({
      where: { specimenNo },
      include: { order: { include: { patient: true } }, results: { include: { test: true } } },
    });
    if (!specimen) throw new BadRequestException(`검체 없음: ${specimenNo}`);
    // 승인된 Reflex add-on의 HIS 정식 오더번호(urn:his:order) 수집 → basedOn 결속(add-on 청구 귀속)
    const reflexOrders = await this.prisma.reflexExecution.findMany({
      where: { orderId: specimen.order.orderId, hisOrderNo: { not: null } },
      select: { hisOrderNo: true },
    });
    const reflexOrderIds = reflexOrders.map((e) => e.hisOrderNo).filter((v): v is string => !!v);
    return buildDiagnosticReport({
      patientId: specimen.order.patient.patientId,
      specimenNo,
      orderId: specimen.order.hisOrderNo, // HIS ServiceRequest 결속(있으면)
      reflexOrderIds,
      results: this.latestReportable(specimen.results).map((r) => ({
        loinc: r.test.loinc ?? r.testCode,
        testName: r.test.name,
        value: r.value ?? '',
        unit: r.unit ?? '',
        flag: r.flag ?? null,
        status: r.status,
      })),
    });
  }

  /**
   * 결과 확정 이벤트 → HIS FHIR 자동 발신 (턴키).
   * 자격증명 미설정 시 no-op(configured:false). 실패는 로그만(본 흐름 비차단).
   */
  @OnEvent('result.finalized')
  async onResultFinalized(payload: { specimenNo: string }): Promise<void> {
    await this.trySendResult(payload.specimenNo);
  }

  /**
   * 결과 HIS 발신 시도 + 실패 시 재시도 큐 적재(§9-6 복원력).
   * 과거엔 실패 시 WARN 로그만 → HIS 다운 시 결과 유실. 이제 검체별 FAILED 레코드로 적재해 재시도/DLQ.
   */
  private async trySendResult(specimenNo: string): Promise<boolean> {
    const mcid = `RES-${specimenNo}`; // 검체별 멱등 큐 키
    try {
      const r = await this.sendResultToHis(specimenNo);
      if (r.configured && r.sent) {
        this.logger.log(`HIS 자동발신: ${specimenNo}`);
        // 재발신 성공 시 이전 실패 큐 해소
        await this.prisma.interfaceLog
          .updateMany({ where: { ifId: 'IF-G08', direction: 'OUTBOUND', messageControlId: mcid, status: { in: ['FAILED', 'DLQ'] } }, data: { status: 'PROCESSED' } })
          .catch(() => undefined);
      }
      return !!r.sent;
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 500);
      this.logger.warn(`HIS 자동발신 실패(${specimenNo}): ${msg} — 재시도 큐 적재`);
      await this.prisma.interfaceLog
        .upsert({
          where: { direction_messageControlId: { direction: 'OUTBOUND', messageControlId: mcid } },
          update: { status: 'FAILED', errorText: msg },
          create: { ifId: 'IF-G08', direction: 'OUTBOUND', messageType: 'FHIR DiagnosticReport', messageControlId: mcid, status: 'FAILED', errorText: msg },
        })
        .catch((err) => this.logger.warn(`결과 재시도 큐 적재 실패: ${err instanceof Error ? err.message : err}`));
      return false;
    }
  }

  /**
   * 결과 발신 실패분 재시도 — FAILED(retryCount<MAX)를 재발신, 성공 시 PROCESSED, 임계 초과 시 DLQ.
   * Reflex 재시도와 동일 패턴. HIS 복구 후 유실 없이 재발신.
   */
  async retryFailedResultSends() {
    const cfg = this.hisFhirConfig();
    if (!cfg) return { configured: false, attempted: 0, sent: 0, failed: 0, dlq: 0 };
    const failed = await this.prisma.interfaceLog.findMany({
      where: { ifId: 'IF-G08', direction: 'OUTBOUND', status: 'FAILED', retryCount: { lt: MAX_REFLEX_RETRY } },
      take: 50,
      orderBy: { createdDt: 'asc' },
    });
    let sent = 0, still = 0, dlq = 0, skipped = 0;
    for (const row of failed) {
      const specimenNo = (row.messageControlId ?? '').replace(/^RES-/, '');
      if (!specimenNo) continue;
      // ★원자적 클레임(발신 경로 dispatchOutbound와 동일 패턴).
      //   이 경로에만 클레임이 없어서, 처리시간이 크론 주기(5분)를 넘기거나 콘솔에서 수동
      //   재시도를 겹쳐 누르면 **같은 보고서를 HIS에 두 번 POST**했다. 결과 보고서 중복은
      //   임상의 화면에 같은 결과가 두 건 뜨고 청구까지 이어질 수 있다.
      //   SENDING으로 선점하지 못하면(다른 실행이 이미 잡음) 건너뛴다.
      //   크래시로 SENDING에 멈춘 건은 기존 DLQ 재큐 경로가 FAILED로 되돌린다.
      const claim = await this.prisma.interfaceLog.updateMany({
        where: { logId: row.logId, status: row.status },
        data: { status: 'SENDING' },
      });
      if (claim.count === 0) { skipped++; continue; }

      try {
        const r = await this.sendResultToHis(specimenNo);
        if (r.sent) { await this.prisma.interfaceLog.update({ where: { logId: row.logId }, data: { status: 'PROCESSED' } }); sent++; }
        else {
          // 미발신(HIS 미설정·조건 미충족) — 클레임을 원복해 다음 주기에 다시 잡히게 한다.
          await this.prisma.interfaceLog.update({ where: { logId: row.logId }, data: { status: row.status } });
          still++;
        }
      } catch (e) {
        const next = (row.retryCount ?? 0) + 1;
        const nextStatus = next >= MAX_REFLEX_RETRY ? 'DLQ' : 'FAILED';
        await this.prisma.interfaceLog.update({ where: { logId: row.logId }, data: { status: nextStatus, retryCount: next, errorText: (e instanceof Error ? e.message : String(e)).slice(0, 500) } });
        if (nextStatus === 'DLQ') dlq++; else still++;
      }
    }
    this.logger.log(`결과 발신 재시도: 시도 ${failed.length} · 발신 ${sent} · 실패 ${still} · DLQ ${dlq}${skipped ? ` · 선점됨 ${skipped}` : ''}`);
    return { configured: true, attempted: failed.length, sent, failed: still, dlq, skipped };
  }

  /**
   * 양방향 오더 — Reflex 추가검사를 HIS 신규 오더로 발신(기획 27 §8).
   * FHIR ServiceRequest(신규 처방, standing order 근거) 구성 → HIS 설정 시 발신, 미설정 시 스테이징(interface_log).
   */
  @OnEvent('reflex.ordered')
  async onReflexOrdered(p: { orderId: string; patientId: string; testCode: string; protocolId: string; protocolName: string }): Promise<void> {
    try {
      await this.sendReflexOrderToHis(p);
    } catch (e) {
      this.logger.warn(`Reflex 양방향 오더 발신 실패(${p.testCode}): ${e instanceof Error ? e.message : e}`);
    }
  }

  /** HIS 양방향 오더 전송 방식 — env HIS_ORDER_TRANSPORT('ORM'|'FHIR', 기본 FHIR). */
  private hisOrderTransport(): 'ORM' | 'FHIR' {
    return (process.env.HIS_ORDER_TRANSPORT || '').toUpperCase() === 'ORM' ? 'ORM' : 'FHIR';
  }

  /**
   * Reflex add-on을 HIS 신규 오더로 구성·발신/스테이징.
   * 전송 방식(HIS 선택): FHIR ServiceRequest(POST) 또는 HL7 ORM^O01(MLLP). 미설정/실패 시 STAGED/FAILED로 기록(멱등, 재발신 가능).
   */
  async sendReflexOrderToHis(p: { orderId: string; patientId: string; testCode: string; protocolId: string; protocolName: string }) {
    const map = await this.prisma.codeMapping.findUnique({ where: { lisCode: p.testCode } });
    const test = await this.prisma.testMaster.findUnique({ where: { testCode: p.testCode } });
    const order = await this.prisma.labOrder.findUnique({ where: { orderId: p.orderId }, select: { hisOrderNo: true } });
    const testName = test?.name ?? p.testCode;
    const reason = `Reflex: ${p.protocolName} (${p.protocolId})`;
    const mcid = `RX-${p.orderId}-${p.testCode}`;
    const transport = this.hisOrderTransport();
    // HIS 계약(2026-07-15): basedOn=HIS 원오더 참조(hisOrderNo), code.coding LOINC 필수(미매핑 명시 거절)
    const parentRef = order?.hisOrderNo ? order.hisOrderNo : p.orderId;

    let messageType: string;
    let payload: string;
    let status = 'STAGED';
    let sent = false;
    let hisRef: string | null = null; // HIS 반환 PreOrder id(승인상태 폴링 키)

    if (transport === 'ORM') {
      // ── 방식 B: HL7 ORM^O01 (MLLP) ──
      const nowStamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
      const orm = buildLabOrm({ messageControlId: mcid, nowStamp, patientId: p.patientId, placerOrderNo: mcid, parentOrderId: p.orderId, testCode: p.testCode, testName, loinc: map?.loinc ?? undefined, reason });
      messageType = 'HL7 ORM^O01 (Reflex)';
      payload = orm;
      const host = process.env.HIS_MLLP_HOST;
      const port = Number(process.env.HIS_MLLP_PORT || 0);
      if (host && port) {
        try {
          const res = await sendMllp(host, port, orm);
          sent = res.ackCode === 'AA';
          status = res.ackCode === 'AA' ? 'PROCESSED' : 'FAILED';
        } catch { status = 'FAILED'; }
      }
    } else {
      // ── 방식 A: FHIR ServiceRequest (POST) ──
      // HIS 계약(2026-07-15): status=draft만 수용(active→422), basedOn=HIS 원오더 필수,
      // code.coding LOINC 필수(미매핑 명시 거절), identifier[0]=멱등키(재발신 시 동일 채번 ACK).
      const serviceRequest = {
        resourceType: 'ServiceRequest', status: 'draft', intent: 'reflex-order',
        identifier: [{ system: 'urn:lis:weve:reflex-order', value: mcid }], // 멱등키
        category: [{ coding: [{ code: 'laboratory' }] }],
        code: { coding: [{ system: 'http://loinc.org', code: map?.loinc ?? undefined, display: p.testCode }] },
        subject: { reference: `Patient/${p.patientId}` }, // HIS orgId(UUID)
        basedOn: [{ reference: `ServiceRequest/${parentRef}` }], // HIS 원오더 참조(책임 처방의 해소)
        reasonCode: [{ text: `Reflex standing order: ${p.protocolName} (${p.protocolId}) — HIS PreOrder(의사 승인 필요)` }],
        supportingInfo: [{ display: `LIS reflex protocol ${p.protocolId} · 전문의·위원회 승인 standing order` }],
      };
      messageType = 'FHIR ServiceRequest (Reflex)';
      payload = JSON.stringify(serviceRequest);
      // LOINC 미매핑이면 HIS가 명시 거절 → 발신 전 사전 가드(발신 대기·사유 기록)
      if (!map?.loinc) {
        status = 'FAILED';
        await this.prisma.interfaceLog.upsert({
          where: { direction_messageControlId: { direction: 'OUTBOUND', messageControlId: mcid } },
          update: { status, retryCount: 0, hisRef: null, errorText: `LOINC 미매핑(R-4) — ${p.testCode}` },
          create: { ifId: 'IF-RX', direction: 'OUTBOUND', messageType, messageControlId: mcid, status, payload, errorText: `LOINC 미매핑(R-4) — ${p.testCode}` },
        });
        this.logger.warn(`Reflex 양방향 오더 발신 보류(LOINC 미매핑): ${p.testCode}`);
        return { transport, sent: false, status };
      }
      const cfg = this.hisFhirConfig();
      if (cfg) {
        try {
          const { getAccessToken: getTok, postFhirResourceViaBundle } = await import('./his-fhir-client');
          const token = await getTok(cfg);
          // transaction Bundle로 발신, hisRef는 응답 response.location에서 해소.
          const r = await postFhirResourceViaBundle(cfg, token, serviceRequest as Record<string, unknown>);
          sent = r.ok;
          status = r.ok ? 'PROCESSED' : 'FAILED';
          if (r.ok && r.id) hisRef = r.id; // PreOrder id(폴링·웹훅 매칭 키)
        } catch { status = 'FAILED'; }
      }
    }

    await this.prisma.interfaceLog.upsert({
      where: { direction_messageControlId: { direction: 'OUTBOUND', messageControlId: mcid } },
      update: { status, retryCount: 0, ...(hisRef ? { hisRef } : {}) }, // 재발신(이벤트 재발생) 시 retryCount 리셋(#7)
      create: { ifId: 'IF-RX', direction: 'OUTBOUND', messageType, messageControlId: mcid, status, payload, hisRef },
    });
    this.logger.log(`Reflex 양방향 오더 ${status}(${transport}): ${p.testCode} (${p.protocolName})`);
    return { transport, sent, status };
  }

  /** 최근 연계 로그(interface_log) — 연계 운영 콘솔 디버깅용. */
  async recentLogs(direction?: string, take = 50) {
    const rows = await this.prisma.interfaceLog.findMany({
      where: { ...(direction === 'INBOUND' || direction === 'OUTBOUND' ? { direction } : {}) },
      orderBy: { createdDt: 'desc' },
      take: Math.min(Math.max(take, 1), 200),
      select: { logId: true, ifId: true, direction: true, messageType: true, messageControlId: true, status: true, errorText: true, createdDt: true },
    });
    return { rows };
  }

  /** Reflex 양방향 오더 아웃바운드 현황(스테이징/발신/실패). */
  async listReflexOutbound() {
    const rows = await this.prisma.interfaceLog.findMany({
      where: { ifId: 'IF-RX', direction: 'OUTBOUND' },
      orderBy: { createdDt: 'desc' },
      take: 200,
      select: { logId: true, messageControlId: true, status: true, errorText: true, retryCount: true, hisRef: true, createdDt: true },
    });
    const counts = rows.reduce((a, r) => { a[r.status] = (a[r.status] ?? 0) + 1; return a; }, {} as Record<string, number>);
    return { configured: !!this.hisFhirConfig(), maxRetry: MAX_REFLEX_RETRY, counts, rows };
  }

  /**
   * Reflex 양방향 오더 재발신(flush) — STAGED/FAILED 건을 HIS로 재전송(수동 운영).
   * HIS 자격증명 수령 후 STAGED 일괄 실발신 전환용(턴키). 미설정 시 no-op.
   * 실패 시 retryCount 증가·임계(MAX_REFLEX_RETRY) 초과 시 DLQ 격리.
   */
  async flushReflexOrders() {
    return this.dispatchOutbound(['STAGED', 'FAILED'], 'flush');
  }

  /**
   * 발신 실패분 자동 재시도 — FAILED만 대상(STAGED는 사람/운영 게이트라 자동 발신 제외).
   * retryCount < MAX만 시도, 임계 초과분은 DLQ로 격리(무한 재시도 방지). HIS_REFLEX_RETRY=on일 때만.
   */
  async retryFailedOutbound() {
    return this.dispatchOutbound(['FAILED'], 'retry');
  }

  /** DLQ 재큐 — 격리(DLQ) + 발신 중 크래시로 멈춘(SENDING) 건을 FAILED·retryCount 0으로 복귀(사람 개입 후).
   *  Reflex(IF-RX) + 결과 발신(IF-G08) 모두 대상. */
  async requeueReflexDlq(mcid?: string) {
    const where = { ifId: { in: ['IF-RX', 'IF-G08'] }, direction: 'OUTBOUND', status: { in: ['DLQ', 'SENDING'] }, ...(mcid ? { messageControlId: mcid } : {}) };
    // updateMany 한 문장 — 종전 findMany(payload 포함 전 컬럼)+행별 update는 HL7/FHIR
    // 원문 수백 건을 불필요하게 메모리로 올리고 왕복을 500회 반복했다.
    const upd = await this.prisma.interfaceLog.updateMany({ where, data: { status: 'FAILED', retryCount: 0 } });
    this.logger.log(`DLQ 재큐(Reflex+결과, DLQ/SENDING): ${upd.count}건 → FAILED`);
    return { requeued: upd.count };
  }

  /** flush/retry 공용 발신 실행 — 대상 status 집합을 HIS로 전송하고 실패 시 재시도/DLQ 처리. */
  private async dispatchOutbound(statuses: string[], mode: 'flush' | 'retry') {
    const transport = this.hisOrderTransport();
    const cfg = this.hisFhirConfig();
    const mllpHost = process.env.HIS_MLLP_HOST;
    const mllpPort = Number(process.env.HIS_MLLP_PORT || 0);
    const configured = transport === 'ORM' ? !!(mllpHost && mllpPort) : !!cfg;
    if (!configured) return { configured: false, transport, attempted: 0, sent: 0, failed: 0, dlq: 0 };
    const pending = await this.prisma.interfaceLog.findMany({
      where: { ifId: 'IF-RX', direction: 'OUTBOUND', status: { in: statuses }, retryCount: { lt: MAX_REFLEX_RETRY } },
      orderBy: { createdDt: 'asc' },
      take: 200, // 배치 상한 — 대량 STAGED 적체 시 단일 호출이 이벤트루프 장시간 점유·타임아웃 방지(반복 호출로 소진)
    });
    if (pending.length === 0) return { configured: true, transport, attempted: 0, sent: 0, failed: 0, dlq: 0 };

    let token: string | null = null;
    if (transport === 'FHIR' && cfg) {
      const { getAccessToken: getTok } = await import('./his-fhir-client');
      try { token = await getTok(cfg); }
      catch { return { configured: true, transport, attempted: 0, sent: 0, failed: 0, dlq: 0, error: 'HIS 토큰 발급 실패' }; }
    }

    let sent = 0;
    let failed = 0;
    let dlq = 0;
    for (const row of pending) {
      // #4 원자적 클레임: 현재 status에서 SENDING으로 전이(updateMany 가드). 다른 실행/크론이 선점했으면 count 0 → skip(이중 발신 방지).
      const claim = await this.prisma.interfaceLog.updateMany({
        where: { logId: row.logId, status: row.status },
        data: { status: 'SENDING' },
      });
      if (claim.count === 0) continue; // 경쟁 실행이 이미 처리 중

      let ok = false;
      let newHisRef: string | null = null;
      // ★실패 사유를 반드시 남긴다(2026-07-30). 이전에는 `catch { ok = false }`로 예외를 통째로
      //   삼키고 DLQ 행에 errorText 없이 상태만 적었다. 실제로 파일럿 DLQ 4건이 전부 공란이라
      //   16일 지난 시점에 원인을 되짚을 수 없었다. 결과 발신 경로는 이미 남기고 있었다(대칭).
      //   Reflex 오더가 조용히 사라지면 **처방돼야 할 추가검사가 시행되지 않는다**.
      //   문구 생성은 outbound-failure.ts에 모았다(사유 없는 기록 재발 방지).
      let reason = '';
      const isOrm = (row.messageType ?? '').startsWith('HL7 ORM');
      try {
        if (isOrm && mllpHost && mllpPort) {
          const res = await sendMllp(mllpHost, mllpPort, row.payload ?? '');
          ok = res.ackCode === 'AA';
          if (!ok) reason = mllpFailureReason(res.ackCode);
        } else if (!isOrm && cfg && token) {
          const { postFhirResourceViaBundle } = await import('./his-fhir-client');
          let resource: Record<string, unknown> = {};
          try { resource = JSON.parse(row.payload ?? '{}') as Record<string, unknown>; } catch { /* noop */ }
          // transaction Bundle 발신, hisRef는 응답 response.location에서 해소.
          const r = await postFhirResourceViaBundle(cfg, token, resource);
          ok = r.ok;
          if (!ok) reason = fhirFailureReason(r.status);
          // #1 발신 성공 시 HIS PreOrder id 포착(identifier 재조회) → hisRef 저장(폴링·웹훅 매칭).
          if (r.ok && !row.hisRef && r.id) newHisRef = r.id;
        } else {
          // 방식-대상 불일치분은 클레임 원복 후 건너뜀
          await this.prisma.interfaceLog.update({ where: { logId: row.logId }, data: { status: row.status } });
          continue;
        }
      } catch (e) {
        ok = false;
        reason = thrownFailureReason(e);
      }

      if (ok) {
        await this.prisma.interfaceLog.update({
          where: { logId: row.logId },
          data: { status: 'PROCESSED', ...(newHisRef ? { hisRef: newHisRef } : {}) },
        });
        sent++;
      } else {
        const nextRetry = (row.retryCount ?? 0) + 1;
        const nextStatus = nextRetry >= MAX_REFLEX_RETRY ? 'DLQ' : 'FAILED';
        await this.prisma.interfaceLog.update({
          where: { logId: row.logId },
          data: {
            status: nextStatus,
            retryCount: nextRetry,
            errorText: outboundErrorText(reason, nextRetry, MAX_REFLEX_RETRY),
          },
        });
        if (nextStatus === 'DLQ') dlq++; else failed++;
      }
    }
    this.logger.log(`Reflex 양방향 오더 ${mode}(${transport}): 시도 ${pending.length} · 발신 ${sent} · 실패 ${failed} · DLQ ${dlq}`);
    return { configured: true, transport, attempted: pending.length, sent, failed, dlq };
  }

  /**
   * 발신 실패분 자동 재시도 스케줄(HIS_REFLEX_RETRY=on일 때만, 5분). DLQ 임계로 무한 재시도 차단.
   *
   * in-flight 가드: 한 주기 처리가 5분을 넘기면 다음 주기가 겹쳐 들어온다. 행 단위 클레임이
   * 이중 발신은 막지만, 겹친 실행이 계속 쌓이면 HIS 커넥션·이벤트루프를 잠식한다.
   */
  private reflexRetryInFlight = false;

  @Cron(CronExpression.EVERY_5_MINUTES)
  async scheduledReflexRetry(): Promise<void> {
    if (process.env.HIS_REFLEX_RETRY !== 'on') return;
    if (this.reflexRetryInFlight) {
      this.logger.warn('발신 재시도 이전 주기가 아직 진행 중 — 이번 주기 건너뜀(적체 시 배치 상한·HIS 응답 확인 필요)');
      return;
    }
    this.reflexRetryInFlight = true;
    try {
      try { await this.retryFailedOutbound(); } catch (e) { this.logger.warn(`Reflex 재시도 실패: ${e instanceof Error ? e.message : e}`); }
      try { await this.retryFailedResultSends(); } catch (e) { this.logger.warn(`결과 발신 재시도 실패: ${e instanceof Error ? e.message : e}`); }
    } finally {
      this.reflexRetryInFlight = false;
    }
  }

  /**
   * [초안] Reflex PreOrder 승인상태 폴링 — HIS 의사 승인 게이트 결과를 LIS에 반영.
   * 발신 성공(PROCESSED)한 add-on의 HIS ServiceRequest 상태를 조회해 매핑:
   *   HIS active/completed → APPROVED, revoked/entered-in-error → REJECTED, draft/on-hold → 대기(변경 없음).
   * REJECTED 시 알림 생성(검사 취소 여부는 정책 — 사람 판단). HIS 폴링 계약 미확정이라 env-gated·no-op 안전.
   */
  async pollReflexPreOrders() {
    const cfg = this.hisFhirConfig();
    if (!cfg) return { configured: false, checked: 0, approved: 0, rejected: 0, pending: 0 };
    // PROCESSED + HIS PreOrder id(hisRef 컬럼) 보유분만 대상 (flush/재시도 발신분 포함 — #1)
    const rows = await this.prisma.interfaceLog.findMany({
      where: { ifId: 'IF-RX', direction: 'OUTBOUND', status: 'PROCESSED', hisRef: { not: null } },
      take: 200,
      select: { logId: true, hisRef: true, messageControlId: true }, // payload(FHIR 원문) 제외 — 폴링에 불필요
    });
    if (rows.length === 0) return { configured: true, checked: 0, approved: 0, rejected: 0, pending: 0 };
    const { getAccessToken: getTok } = await import('./his-fhir-client');
    let token: string;
    try { token = await getTok(cfg); } catch { return { configured: true, checked: 0, approved: 0, rejected: 0, pending: 0, error: 'HIS 토큰 실패' }; }
    let approved = 0;
    let rejected = 0;
    let pending = 0;
    // 동시성 8 제한 병렬(2026-07-30 성능 검토): 200건 순차 GET은 HIS가 건당 500ms만 걸려도
    // 100초 — 타임아웃 구간이면 주기를 넘긴다. 오더 폴링의 환자명 조회와 같은 패턴.
    await this.mapLimit(rows, 8, async (row) => {
      const hisId = row.hisRef;
      if (!hisId) return;
      try {
        const res = await fetch(`${cfg.fhirBase.replace(/\/+$/, '')}/ServiceRequest/${encodeURIComponent(hisId)}`, {
          headers: { Accept: 'application/fhir+json', Authorization: `Bearer ${token}` },
          signal: httpTimeout(),
        });
        if (!res.ok) { pending++; return; }
        const sr = (await res.json()) as { status?: string; identifier?: { system?: string; value?: string }[] };
        const mapped = this.mapHisReflexStatus(sr.status);
        // 조건부 전이(현재 PROCESSED일 때만) — 동시 폴링·웹훅 이중반영/중복알림 방지(#2). hisRef는 유지(사후 revoke 매칭용 #3).
        if (mapped === 'APPROVED') {
          const hisOrderNo = extractHisOrderNo(sr.identifier); // urn:his:order 정식 오더번호
          const upd = await this.prisma.interfaceLog.updateMany({
            where: { logId: row.logId, status: 'PROCESSED' },
            data: { status: 'APPROVED', ...(hisOrderNo ? { errorText: `HISORDER=${hisOrderNo}` } : {}) },
          });
          if (upd.count > 0) {
            approved++;
            if (hisOrderNo && row.messageControlId) {
              await this.prisma.reflexExecution.updateMany({ where: { outboundMcid: row.messageControlId }, data: { hisOrderNo } }).catch(() => undefined);
            }
          }
        } else if (mapped === 'REJECTED') {
          const upd = await this.prisma.interfaceLog.updateMany({ where: { logId: row.logId, status: 'PROCESSED' }, data: { status: 'REJECTED' } });
          if (upd.count > 0) { await this.notifyReflexReject(row.messageControlId); rejected++; }
        } else {
          pending++; // draft/on-hold — 승인 대기
        }
      } catch { pending++; }
    });
    this.logger.log(`Reflex PreOrder 폴링: 확인 ${rows.length} · 승인 ${approved} · 반려 ${rejected} · 대기 ${pending}`);
    return { configured: true, checked: rows.length, approved, rejected, pending };
  }

  /** HIS ServiceRequest.status → LIS 승인상태 매핑(폴링·웹훅 공용). */
  private mapHisReflexStatus(s?: string): 'APPROVED' | 'REJECTED' | 'PENDING' {
    if (s === 'active' || s === 'completed') return 'APPROVED';
    if (s === 'revoked' || s === 'entered-in-error') return 'REJECTED';
    return 'PENDING'; // draft/on-hold 등 — 승인 대기
  }

  /** 의사 반려 알림 생성(검사 취소 여부는 정책·사람 판단 — 자동 취소 아님). */
  /**
   * Reflex 반려 처리 — 병원 정책(2026-07-18): HIS 반려 시 LIS 후속검사 **자동취소**.
   * 결과 미보고(RECEIVED/IN_PROCESS/HOLD) 항목만 취소(이미 결과 나온 검사는 보존). 폴링·웹훅 공용.
   */
  private async notifyReflexReject(mcid: string | null): Promise<void> {
    let cancelledTest: string | null = null;
    if (mcid) {
      const rxe = await this.prisma.reflexExecution.findFirst({ where: { outboundMcid: mcid } });
      if (rxe) {
        const upd = await this.prisma.orderItem.updateMany({
          where: { orderId: rxe.orderId, testCode: rxe.addTestCode, status: { notIn: ['REPORTED', 'CANCELLED'] as never } },
          data: { status: 'CANCELLED' as never },
        }).catch(() => ({ count: 0 }));
        if (upd.count > 0) { cancelledTest = rxe.addTestCode; this.logger.log(`Reflex 반려 자동취소: ${rxe.orderId}/${rxe.addTestCode}`); }
      }
    }
    await this.prisma.notification
      .create({
        data: {
          notifyId: genId('NTF'), ntype: 'Reflex반려', target: mcid,
          message: cancelledTest
            ? `HIS 의사 반려: ${mcid} — 후속검사 ${cancelledTest} 자동취소됨`
            : `HIS 의사 반려: ${mcid} — 자동취소 대상 없음(이미 결과보고/취소)`,
          createdDt: new Date(),
        },
      })
      .catch(() => undefined);
  }

  /**
   * [R-5 대안] Reflex PreOrder 승인/거절 웹훅 수신 (HIS→LIS push).
   * 폴링과 동일 매핑을 단건에 적용. HIS_REFLEX_WEBHOOK_TOKEN 미설정 시 비활성(503) — 켜기 전까지 무해.
   * body = FHIR ServiceRequest({id, identifier[].value=멱등키, status}) 또는 최소 {id, mcid, status}.
   */
  async applyReflexCallback(
    token: string | undefined,
    body: { id?: string; mcid?: string; identifier?: { system?: string; value?: string }[]; status?: string },
  ): Promise<{ matched: boolean; status?: string }> {
    const expected = process.env.HIS_REFLEX_WEBHOOK_TOKEN;
    if (!expected) throw new ServiceUnavailableException('Reflex 웹훅 미구성(HIS_REFLEX_WEBHOOK_TOKEN)');
    if (!token || !this.tokenMatches(token, expected)) throw new UnauthorizedException('웹훅 토큰 불일치'); // #6 상수시간 비교
    if (!body?.status) throw new BadRequestException('status 필수');

    // #5 멱등키 식별자는 system=urn:lis:weve:reflex-order 를 선택(첫 value 아무거나 X). extractHisOrderNo와 대칭.
    const mcid = body.mcid
      ?? body.identifier?.find((i) => i?.value && (i.system ?? '').toLowerCase().includes('lis:weve:reflex-order'))?.value
      ?? null;
    const hisId = body.id ?? null;
    // 대상 IF-RX 레코드: 멱등키(mcid) 우선, 없으면 hisRef 컬럼(승인 후에도 유지 → 사후 revoke 매칭 #3)
    let row = mcid
      ? await this.prisma.interfaceLog.findFirst({ where: { ifId: 'IF-RX', direction: 'OUTBOUND', messageControlId: mcid } })
      : null;
    if (!row && hisId) {
      row = await this.prisma.interfaceLog.findFirst({ where: { ifId: 'IF-RX', direction: 'OUTBOUND', hisRef: hisId } });
    }
    if (!row) {
      this.logger.warn(`Reflex 웹훅: 대상 없음(mcid=${mcid} id=${hisId})`);
      return { matched: false };
    }

    const mapped = this.mapHisReflexStatus(body.status);
    if (mapped === 'PENDING') return { matched: true, status: 'PENDING' };
    const hisOrderNo = mapped === 'APPROVED' ? extractHisOrderNo(body.identifier) : null;
    // #2 조건부 전이(현 status ≠ 목표일 때만) — 재전송(at-least-once) 시 중복 알림·이중 반영 방지
    const upd = await this.prisma.interfaceLog.updateMany({
      where: { logId: row.logId, status: { not: mapped } },
      data: { status: mapped, ...(hisOrderNo ? { errorText: `HISORDER=${hisOrderNo}` } : {}) },
    });
    if (upd.count === 0) return { matched: true, status: mapped }; // 이미 동일 상태(멱등 replay)
    if (hisOrderNo && row.messageControlId) {
      await this.prisma.reflexExecution.updateMany({ where: { outboundMcid: row.messageControlId }, data: { hisOrderNo } }).catch(() => undefined);
    }
    if (mapped === 'REJECTED') await this.notifyReflexReject(row.messageControlId);
    this.logger.log(`Reflex 웹훅 콜백: ${row.messageControlId} → ${mapped}`);
    return { matched: true, status: mapped };
  }

  /** 상수시간 토큰 비교(길이 노출 방지 위해 길이 선검사 후 timingSafeEqual). */
  private tokenMatches(a: string, b: string): boolean {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  }

  /** [초안] Reflex PreOrder 승인상태 스케줄 폴링(HIS_REFLEX_POLL=on일 때만, 10분). */
  @Cron(CronExpression.EVERY_10_MINUTES)
  async scheduledReflexPoll(): Promise<void> {
    if (process.env.HIS_REFLEX_POLL !== 'on') return;
    if (this.reflexPollInFlight) return; // HIS 지연 시 한 주기가 10분을 넘을 수 있다 — 중첩 방지
    this.reflexPollInFlight = true;
    try { await this.pollReflexPreOrders(); } catch (e) { this.logger.warn(`Reflex 폴링 실패: ${e instanceof Error ? e.message : e}`); }
    finally { this.reflexPollInFlight = false; }
  }

  /**
   * HIS 검사 오더 폴링 스케줄러 (HIS→LIS, 5분 주기).
   * 자격증명 미설정 시 skip. ServiceRequest(LAB) → LIS 오더 자동 생성(멱등).
   */
  /** 스케줄 폴링(HIS_ORDER_POLL=on일 때만) */
  @Cron(CronExpression.EVERY_5_MINUTES)
  async scheduledOrderPoll(): Promise<void> {
    if (process.env.HIS_ORDER_POLL !== 'on') return;
    // 중첩 가드 — 첫 폴링(개시 대량)이 5분 초과 시 다음 틱과 중첩(채번 경합·중복 처리) 방지
    if (this.pollInFlight) { this.logger.warn('HIS 오더 폴링 스킵 — 이전 폴링 진행 중'); return; }
    this.pollInFlight = true;
    try {
      const r = await this.pollHisOrders();
      if (r.created) this.logger.log(`HIS 오더 폴링(스케줄): ${r.created}건 생성`);
    } catch (e) {
      this.logger.warn(`HIS 오더 폴링 실패: ${e instanceof Error ? e.message : e}`);
    } finally {
      this.pollInFlight = false;
    }
  }

  /**
   * HIS 검사 오더 폴링 (수동/스케줄 공용). ServiceRequest(LAB) → LIS 오더 생성(멱등, 코드매핑 전개).
   * 자격증명 미설정 시 configured:false.
   */
  async pollHisOrders(): Promise<{
    configured: boolean;
    seen: number;
    created: number;
    dropped?: number; // 미매핑·환자불명으로 대기열에 보류된 오더 수(사람이 매핑 보정 후 재적재)
    cancelled?: number;
    cancelFailed?: number; // 취소 적용 실패 건수(>0이면 워터마크가 그 앞에서 멈춰 재시도된다)
    orders: { hisOrderId: string; code: string | null; lisOrderId?: string; items?: string[]; skipped?: string }[];
  }> {
    const cfg = this.hisFhirConfig();
    if (!cfg) return { configured: false, seen: 0, created: 0, orders: [] };

    const { getAccessToken: getTok, pollLabOrders, fetchPatientName } = await import('./his-fhir-client');
    const token = await getTok(cfg);
    // ⑧ 증분 폴링 — 이전 워터마크(_lastUpdated) 이후만 조회. 최초는 전체.
    const since = await this.getState('orders_watermark');
    const orders = await pollLabOrders(cfg, token, fetch, 'active', since);
    // maxSeen은 **처리에 성공한 항목만** 올린다(선전진하면 실패분이 워터마크에 묻힌다).
    let maxSeen = since ?? '';
    const detail: { hisOrderId: string; code: string | null; lisOrderId?: string; items?: string[]; skipped?: string }[] = [];
    let created = 0;
    let dropped = 0; // 미매핑·환자불명으로 적재 못 한 오더(대기열로 보냄)

    // ★워터마크는 **성공적으로 적용된 지점까지만** 전진해야 한다.
    //   이전에는 maxSeen을 적용 루프 전에 전부 올려놓고 루프 전체를 catch로 삼켰다.
    //   그래서 취소 적용이 하나라도 실패하면 나머지도 통째로 건너뛰는데 워터마크는 이미
    //   그 시점을 지나 있어, **임상의가 취소한 오더를 LIS가 계속 수행·보고**했다.
    //   실패분보다 앞에서 멈춰 다음 주기에 반드시 다시 보게 한다.
    const fail: { earliest: string | null; hold: boolean } = { earliest: null, hold: false };
    const noteFailure = (lastUpdated?: string | null) => {
      if (!lastUpdated) { fail.hold = true; return; } // 시각을 모르면 어디서 멈출지 알 수 없다 → 전진 보류
      if (!fail.earliest || lastUpdated < fail.earliest) fail.earliest = lastUpdated;
    };

    // ── 배치 선로드(오더 루프의 오더당 순차 쿼리 폭증 제거) ──
    const hisIds = orders.map((o) => o.orderId);
    const [existLabRows, existPathRows] = await Promise.all([
      // patientId도 같이 — HIS 병합·환자 정정으로 **같은 오더가 다른 MRN으로 재유입**될 수 있다(§C).
      this.prisma.labOrder.findMany({ where: { hisOrderNo: { in: hisIds } }, select: { hisOrderNo: true, orderId: true, patientId: true } }),
      this.prisma.pathologyCase.findMany({ where: { hisOrderNo: { in: hisIds } }, select: { hisOrderNo: true, spNo: true, patientId: true } }),
    ]);
    const existLab = new Map(existLabRows.map((x) => [x.hisOrderNo, { id: x.orderId, patientId: x.patientId }]));
    const existPath = new Map(existPathRows.map((x) => [x.hisOrderNo, { id: x.spNo, patientId: x.patientId }]));
    const maps = await this.loadResolveMaps(); // C2: 코드 해소용 마스터 1회 선로드(오더당 풀스캔 제거)
    // C1: 환자명은 고유 patientRef만 병렬(상한 8) 조회 — 오더당 순차 HTTP 폭증 제거
    const uniqueRefs = [...new Set(orders.map((o) => o.patientRef).filter((r): r is string => !!r))];
    const nameMap = new Map<string, string | null>();
    await this.mapLimit(uniqueRefs, 8, async (ref) => { nameMap.set(ref, await fetchPatientName(cfg, token, ref).catch(() => null)); });

    for (const o of orders) {
      // 항목별 격리 — 한 오더의 실패가 나머지를 날리지 않게 한다.
      let itemFailed = false;
      try {
        const r = await this.ingestPolledOrder(o, { existLab, existPath, maps, nameMap });
        if (r.status === 'created') {
          detail.push({ hisOrderId: o.orderId, code: o.code, lisOrderId: r.lisOrderId, items: r.items });
          created++;
        } else if (r.status === 'exists') {
          detail.push({ hisOrderId: o.orderId, code: o.code, skipped: 'already-exists' });
        } else {
          // ★드롭(미매핑·환자 식별 불가)은 워터마크가 그 위를 지나가므로 다시 오지 않는다.
          //   HTTP 응답 필드에만 남기면 그 오더는 LIS에 존재한 적이 없게 된다 —
          //   대기열에 적재해 코드매핑을 고친 뒤 재적재할 수 있게 한다.
          detail.push({ hisOrderId: o.orderId, code: o.code, skipped: r.dropReason });
          dropped++;
          await this.queueDroppedOrder(o, r.dropReason ?? 'unknown');
        }
      } catch (e) {
        // 워터마크를 붙잡아 다음 주기에 다시 받는다(생성은 hisOrderNo 중복검사로 멱등).
        itemFailed = true;
        noteFailure(o.lastUpdated);
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error(`오더 생성 실패 HIS=${o.orderId} — 재폴링 대상으로 남김: ${msg}`);
        detail.push({ hisOrderId: o.orderId, code: o.code, skipped: `create-failed: ${msg}` });
      }
      // 스킵·드롭도 '처리됨'이다 — 여기서 멈추면 그 오더가 영구 재폴링된다.
      // 드롭분은 워터마크가 아니라 **대기열**이 책임진다.
      if (!itemFailed && o.lastUpdated && o.lastUpdated > maxSeen) maxSeen = o.lastUpdated;
    }

    // 취소 신호 전파 — HIS revoked 오더 → 매칭 LIS 레코드 취소(병리 케이스·검사 오더). HIS Q3 계약.
    // 취소 누락은 "취소된 검사를 계속 수행·보고"로 이어지므로 조용히 넘어가면 안 된다.
    let cancelled = 0;
    let cancelFailed = 0;
    let revoked: Awaited<ReturnType<typeof pollLabOrders>> = [];
    try {
      revoked = await pollLabOrders(cfg, token, fetch, 'revoked', since);
    } catch (e) {
      // 취소 목록 자체를 못 받았다 — 이 구간에 취소가 있었는지조차 모른다. 워터마크를 붙잡는다.
      fail.hold = true;
      this.logger.error(`취소 폴링 실패 — 워터마크 전진 보류(다음 주기 재조회): ${e instanceof Error ? e.message : e}`);
    }
    for (const r of revoked) {
      // ★항목별로 격리한다. 이전에는 하나가 던지면 남은 취소가 전부 적용되지 않았다.
      try {
        const pc = await this.prisma.pathologyCase.findFirst({ where: { hisOrderNo: r.orderId, status: { notIn: ['취소', '완료'] } } });
        if (pc) {
          await this.prisma.pathologyCase.update({ where: { spNo: pc.spNo }, data: { status: '취소' } });
          this.auditSystemChange(`/system/polling/cancel/pathology/${pc.spNo}`, `HIS 취소 전파: 병리 케이스 취소 (HIS=${r.orderId})`);
          // 오더 취소 시 PACS 워크리스트도 자동 취소 — 케이스 취소 ORM(ORC-1=CA) 전파.
          // best-effort: 전송 실패해도 케이스 취소는 유지(PACS 미도달은 재폴링/수동 보정).
          try { await this.cancelPathologyWorklist(pc.spNo); } catch (e) { this.logger.warn(`PACS 취소 ORM 실패 ${pc.spNo}: ${e instanceof Error ? e.message : e}`); }
          cancelled++; detail.push({ hisOrderId: r.orderId, code: r.code, skipped: `cancelled→${pc.spNo}` });
          if (r.lastUpdated && r.lastUpdated > maxSeen) maxSeen = r.lastUpdated;
          continue;
        }
        const lo = await this.prisma.labOrder.findFirst({ where: { hisOrderNo: r.orderId, status: { notIn: ['CANCELLED', 'REPORTED'] as never } } });
        if (lo) {
          await this.prisma.labOrder.update({ where: { orderId: lo.orderId }, data: { status: 'CANCELLED' as never } });
          await this.prisma.orderItem.updateMany({ where: { orderId: lo.orderId, status: { notIn: ['REPORTED', 'CANCELLED'] as never } }, data: { status: 'CANCELLED' as never } });
          this.auditSystemChange(`/system/polling/cancel/order/${lo.orderId}`, `HIS 취소 전파: 오더 CANCELLED (HIS=${r.orderId})`);
          cancelled++; detail.push({ hisOrderId: r.orderId, code: r.code, skipped: `cancelled→${lo.orderId}` });
        }
        // 매칭 레코드가 없으면 적용할 것이 없다(미수신·이미 완료·이미 취소) — 성공으로 본다.
        if (r.lastUpdated && r.lastUpdated > maxSeen) maxSeen = r.lastUpdated;
      } catch (e) {
        cancelFailed++;
        noteFailure(r.lastUpdated);
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error(`취소 적용 실패 HIS=${r.orderId} — 재폴링 대상으로 남김: ${msg}`);
        detail.push({ hisOrderId: r.orderId, code: r.code, skipped: `cancel-failed: ${msg}` });
        // 감시에 잡히도록 인터페이스 로그로 남긴다(로그만으로는 아무도 모른다).
        await this.prisma.interfaceLog
          .create({
            data: {
              ifId: 'IF-HISORD', direction: 'INBOUND', messageType: 'ServiceRequest(revoked)',
              messageControlId: `revoke-${r.orderId}-${r.lastUpdated ?? 'na'}`,
              status: 'FAILED', errorText: `취소 적용 실패: ${msg}`, payload: JSON.stringify(r),
            },
          })
          .catch(() => undefined); // 로그 실패가 폴링을 막지 않게
      }
    }

    // 워터마크 전진 — 판단은 도메인 순수함수(nextWatermark)가 한다. 실패분 앞에서 멈추는 규칙이
    // 이 메서드 안에 묻혀 있으면 검증할 수 없어서 분리했다(poll-watermark.spec.ts가 회귀를 막는다).
    if (fail.hold) {
      this.logger.error('오더 폴링: 적용 실패분이 있어 워터마크 전진 보류 — 다음 주기에 재조회합니다');
    }
    const nextWm = nextWatermark({ since, maxProcessed: maxSeen, earliestFailure: fail.earliest, hold: fail.hold });
    if (nextWm) {
      await this.setState('orders_watermark', nextWm).catch((e) => this.logger.warn(`워터마크 저장 실패: ${e instanceof Error ? e.message : e}`));
    }
    if (cancelFailed > 0) {
      this.logger.error(`오더 취소 적용 실패 ${cancelFailed}건 — 워터마크를 붙잡아 재시도합니다(취소된 검사가 계속 수행될 수 있음)`);
    }
    return { configured: true, seen: orders.length, created, dropped, cancelled, cancelFailed, orders: detail };
  }

  /**
   * 폴링된 HIS 오더 1건 적재 — 폴링 루프와 대기열 재적재가 **같은 코드**를 쓰도록 분리.
   * 재적재 경로가 별도 구현이면 둘이 어긋나 "재적재했는데 결과가 다르다"가 된다.
   *
   * 던지면 호출자가 워터마크를 붙잡는다(일시적 실패 → 재폴링).
   * 'dropped'는 데이터 자체의 문제라 재폴링해도 그대로다 — 대기열이 책임진다.
   */
  private async ingestPolledOrder(
    o: PolledOrder,
    ctx: {
      existLab: Map<string | null, { id: string; patientId: string }>;
      existPath: Map<string | null, { id: string; patientId: string }>;
      maps: ResolveMaps;
      nameMap: Map<string, string | null>;
    },
  ): Promise<{ status: 'created' | 'exists' | 'dropped'; lisOrderId?: string; items?: string[]; dropReason?: string }> {
    // patientId = 실 MRN 우선(HIS subject.identifier), 없으면 Patient/{UUID} 폴백
    const patientId = o.mrn || (o.patientRef ?? '').replace('Patient/', '') || '';
    // 환자 식별 불가 오더는 단일 UNKNOWN 차트로 병합하지 않는다(교차 오염 방지)
    if (!patientId) {
      this.logger.warn(`오더 폴링: 환자 식별 불가 — HIS=${o.orderId}(대기열 보류)`);
      return { status: 'dropped', dropReason: 'no-patient-id' };
    }
    const realName = o.patientRef ? ctx.nameMap.get(o.patientRef) ?? null : null;
    const fallbackName = `HIS환자·${patientId.slice(-6)}`;

    /**
     * 폴백명 백필 — 이름 없이 만들어진 환자를 나중에 실명으로 채운다.
     *
     * 기존엔 upsert의 update에서 name을 아예 건드리지 않았다("큐레이션된 이름을 덮지 않는다"는
     * 의도). 그런데 그 결과 **최초 유입 때 이름을 못 받으면 폴백명이 영구 고착**됐다 —
     * HIS Patient.read가 정상 응답하는데도(실측 200·`한지영`) 화면엔 `HIS환자·d00006`으로 남는다.
     * 그래서 조건을 좁힌다: **현재 이름이 폴백 형식일 때만** 실명으로 교체한다.
     * 사람이 고쳐 넣은 이름은 폴백 형식이 아니므로 그대로 보존된다.
     */
    const backfillName = async () => {
      if (!realName) return;
      await this.prisma.patient
        .updateMany({ where: { patientId, name: { startsWith: 'HIS환자·' } }, data: { name: realName } })
        .catch(() => undefined); // 이름 백필 실패가 오더 적재를 막지는 않는다
    };

    /**
     * HIS 환자 uuid 백필 — 이름과 같은 이유로 분리한다.
     *
     * uuid는 아래 upsert의 update 절에도 있지만 그 지점은 **`exists` 조기반환 뒤**라,
     * 이미 적재된 오더로 재유입되면 실행되지 않는다. 그런데 uuid가 비어 있으면
     * **수혈 동의 조회(H4)가 통째로 막힌다** — 동의 참조가 uuid만 수용하기 때문이다.
     * (실제로 병합한 환자가 `uuid 미보유`로 동의 수기 폴백에 걸려 있었다.)
     * 이미 값이 있으면 덮지 않는다(HIS가 재발급하는 경우가 아니라면 바뀔 이유가 없다).
     */
    const backfillUuid = async () => {
      if (!hisUuid) return;
      await this.prisma.patient
        .updateMany({ where: { patientId, hisPatientUuid: null }, data: { hisPatientUuid: hisUuid } })
        .catch(() => undefined);
    };

    // HIS FHIR Patient uuid — 동의 참조(H4)가 uuid만 수용하므로 폴링 유입 시 저장(기존 환자도 채움)
    const hisUuid = o.patientRef?.startsWith('Patient/') ? o.patientRef.slice('Patient/'.length) : null;

    // ★백필은 분기·조기반환보다 먼저 — 이미 적재된 오더는 아래에서 `exists`로 즉시 반환되므로
    //   그 뒤에 두면 **가장 고쳐야 할 대상(이미 있는 폴백명 환자)에서 영영 실행되지 않는다.**
    //   (첫 수정에서 실제로 이 함정을 밟았다 — 폴링을 돌려도 이름이 그대로였다.)

    /**
     * 환자 재귀속(§C) — 같은 HIS 오더가 **다른 환자ID로** 재유입될 때.
     *
     * 언제 생기나: HIS에서 환자 병합·환자 정정이 일어나면 같은 오더의 `subject`가 바뀐다.
     * 그런데 LIS 폴링은 기적재 오더를 `exists`로 조기 반환하므로 **옛 환자에 그대로 남는다** —
     * 실제로 한 환자가 UUID/MRN 두 레코드로 갈려 오더 3건이 분절돼 있었다(2026-07-29 병합 처리).
     *
     * ★자동으로 옮기는 범위를 좁힌다. 오더를 다른 환자에게 옮기는 것은 위험한 작업이고,
     *   "다른 MRN으로 왔다"의 원인이 병합·정정이 아니라 **HIS측 데이터 오류**일 수도 있다.
     *   - 결과가 아직 없는 오더 → 자동 재귀속(잘못돼도 임상 영향이 작고 되돌리기 쉽다)
     *   - **결과가 이미 있는 오더 → 옮기지 않고 알림**. 결과가 붙은 오더를 자동으로 옮기면
     *     그 결과가 다른 환자 차트에 나타난다. 사람이 병합 기능으로 판단해 처리한다.
     */
    const reassignIfPatientChanged = async (
      kind: 'lab' | 'path',
      hit: { id: string; patientId: string },
    ): Promise<void> => {
      if (hit.patientId === patientId) return;
      /**
       * ★MRN 없이 UUID로 폴백한 유입은 재귀속하지 않는다.
       *
       * patientId는 `o.mrn || Patient/{uuid}` 순으로 정해진다. HIS가 어떤 이유로 MRN을
       * 빠뜨리면 patientId가 UUID가 되는데, 그때 재귀속을 돌리면 **정본(MRN) 환자에 있던
       * 오더를 UUID 레코드로 옮긴다** — 우리가 막으려던 분절을 코드가 직접 만드는 셈이다.
       * 반대 방향(UUID에 있던 오더 → MRN)은 정상이므로 그때는 통과한다(o.mrn 존재).
       */
      if (!o.mrn) return;
      // LIS에서 이미 병합된 환자로 들어오면 정본으로 라우팅(HL7 경로와 같은 규칙)
      const target = await this.prisma.patient.findUnique({ where: { patientId }, select: { status: true, mergedInto: true } });
      const finalId = target?.status === 'MERGED' && target.mergedInto ? target.mergedInto : patientId;
      if (hit.patientId === finalId) return;

      /**
       * ★"옮겨도 되는가"의 기준은 **최종 보고서 유무가 아니라 실물·산출물 유무**다.
       *
       * 예전엔 병리를 `pathologyReport` 하나로만 판정했다. 그래서 육안검체·블록·슬라이드·
       * IHC·세포검사·추가보고가 있어도 최종 보고서만 없으면 "결과 없음"으로 보고 **조용히
       * 다른 환자로 옮겼다**. 슬라이드와 블록에는 옛 MRN이 인쇄돼 있고 IHC 판정도 이미
       * 나와 있는데 케이스만 다른 환자로 넘어가는 것 — 검체 취종(取違) 그 자체다.
       * 검사도 같다: 채취된 검체는 옛 MRN 바코드를 달고 장비에 올라가 있을 수 있으므로
       * 결과가 아직 없어도 사람이 확인해야 한다.
       *
       * 접수만 된 케이스(실물 작업 전)는 여전히 자동 이관된다 — 폴링 직후 유입분이 여기 해당.
       */
      const hasResults = kind === 'lab'
        ? await this.prisma.specimen.count({ where: { orderId: hit.id } })
        : (
            await Promise.all([
              this.prisma.pathologyReport.count({ where: { spNo: hit.id } }),
              this.prisma.cytologyReport.count({ where: { spNo: hit.id } }),
              this.prisma.ihcResult.count({ where: { spNo: hit.id } }),
              this.prisma.pathologyAddendum.count({ where: { spNo: hit.id } }),
              this.prisma.pathologyConsult.count({ where: { spNo: hit.id } }),
              this.prisma.pathologySpecimen.count({ where: { spNo: hit.id } }),
              this.prisma.pathologyBlock.count({ where: { spNo: hit.id } }),
              this.prisma.pathologySlide.count({ where: { spNo: hit.id } }),
            ])
          ).reduce((a, b) => a + b, 0);

      if (hasResults === 0) {
        await this.prisma.patient.upsert({
          where: { patientId: finalId },
          update: {},
          create: { patientId: finalId, name: realName || fallbackName, hisPatientUuid: hisUuid },
        });
        if (kind === 'lab') await this.prisma.labOrder.update({ where: { orderId: hit.id }, data: { patientId: finalId } });
        else await this.prisma.pathologyCase.update({ where: { spNo: hit.id }, data: { patientId: finalId } });
        this.logger.warn(`환자 재귀속: ${kind} ${hit.id} — ${hit.patientId} → ${finalId}(HIS=${o.orderId})`);
        this.auditSystemChange(
          kind === 'lab' ? `/system/polling/reattribute/order/${hit.id}` : `/system/polling/reattribute/pathology/${hit.id}`,
          `환자 재귀속(자동 이관): ${hit.patientId} → ${finalId} (HIS=${o.orderId}, 검체·산출물 0건)`,
        );
      }

      /**
       * ★보류 건은 중복을 막아야 한다 — 스스로 해소되지 않기 때문이다.
       *
       * 자동 이관 건은 다음 폴링에서 `hit.patientId === patientId`가 되어 조건이 사라진다.
       * 그런데 **결과가 있어 옮기지 않은 건은 오더가 그대로 남아** 매 폴링(5분)마다 같은
       * 조건이 성립한다 → 같은 알림이 무한히 쌓여 알림함이 이것으로 덮인다(경보 피로).
       * 같은 오더에 미확인 알림이 있으면 새로 만들지 않는다. 사람이 확인·처리하면 다시 뜬다.
       */
      if (hasResults > 0) {
        const open = await this.prisma.notification.findFirst({
          where: { ntype: '환자재귀속', ackDt: null, message: { contains: hit.id } },
          select: { notifyId: true },
        });
        if (open) return;
      }
      await this.prisma.notification
        .create({
          data: {
            notifyId: genId('NTF'),
            ntype: '환자재귀속',
            target: '검사실·의무기록',
            message: hasResults === 0
              ? `HIS 환자 변경 반영 — ${kind === 'lab' ? '오더' : '병리'} ${hit.id}: ${hit.patientId} → ${finalId}(검체·산출물 없어 자동 이관)`.slice(0, 500)
              : `⚠ HIS 환자 변경 감지 — ${kind === 'lab' ? '오더' : '병리'} ${hit.id}가 ${hit.patientId}에 있으나 HIS는 ${finalId}. **${kind === 'lab' ? '검체' : '검체·블록·슬라이드·판독'} ${hasResults}건이 있어 자동 이관하지 않음**(옛 MRN 라벨이 실물에 남아 있음) — 환자 병합으로 처리 필요`.slice(0, 500),
            createdDt: new Date(),
          },
        })
        .catch(() => undefined);
    };

    await backfillName();
    await backfillUuid();

    // ── 병리 오더(category=PAT) → PathologyCase 라우팅 (HIS 2026-07-15 계약, LOINC 불요·EDI 수용) ──
    if (o.isPathology) {
      const pathHit = ctx.existPath.get(o.orderId);
      if (pathHit) { await reassignIfPatientChanged('path', pathHit); return { status: 'exists' }; }
      await this.prisma.patient.upsert({
        where: { patientId },
        update: { ...(hisUuid ? { hisPatientUuid: hisUuid } : {}) },
        create: { patientId, name: realName || fallbackName, hisPatientUuid: hisUuid },
      });
      // 채번 경합(P2002) 시 재채번 — 단, hisOrderNo 유니크 위반이면 동시 유입이 먼저 적재한 것(exists)
      let spNo = '';
      for (let attempt = 0; attempt < 3; attempt++) {
        spNo = await this.generatePathNo();
        try {
          await this.prisma.pathologyCase.create({
            data: { spNo, patientId, hisOrderNo: o.orderId, procedureCode: o.code, receivedDate: new Date().toISOString().slice(0, 10), status: '접수' },
          });
          break;
        } catch (e) {
          if (!isUniqueViolation(e)) throw e;
          const dup = await this.prisma.pathologyCase.findFirst({ where: { hisOrderNo: o.orderId }, select: { spNo: true } });
          if (dup) return { status: 'exists' };
          if (attempt === 2) throw e;
        }
      }
      // PACS 워크리스트 자동 등록(접수 즉시). best-effort(실패해도 케이스 유지·수동 재송신 가능).
      try { await this.sendPathologyWorklist(spNo); } catch (e) { this.logger.warn(`MWL 자동송신 실패 ${spNo}: ${e instanceof Error ? e.message : e}`); }
      return { status: 'created', lisOrderId: spNo, items: ['병리'] };
    }

    const labHit = ctx.existLab.get(o.orderId);
    if (labHit) { await reassignIfPatientChanged('lab', labHit); return { status: 'exists' }; }
    const codes = this.resolveWith(o.code ? [o.code] : [], ctx.maps); // in-memory 해소(DB 0회)
    if (codes.mapped.length === 0) {
      this.logger.warn(`오더 폴링: 코드 미매핑 — HIS=${o.orderId} code=${o.code}(대기열 보류)`);
      return { status: 'dropped', dropReason: 'unmapped' };
    }
    await this.prisma.patient.upsert({
      where: { patientId },
      update: { ...(hisUuid ? { hisPatientUuid: hisUuid } : {}) }, // uuid만 채움(이름은 아래 백필이 조건부 처리)
      create: { patientId, name: realName || fallbackName, hisPatientUuid: hisUuid },
    });
    const orderId = await this.generateOrderId();
    await this.prisma.labOrder.create({
      data: {
        orderId, hisOrderNo: o.orderId, patientId, orderDt: new Date(), status: 'RECEIVED',
        items: { create: codes.mapped.map((c, i) => ({ orderItemId: `${orderId}-I${i + 1}`, testCode: c, status: 'RECEIVED' })) },
      },
    });
    return { status: 'created', lisOrderId: orderId, items: codes.mapped };
  }

  /**
   * 적재 못 한 HIS 오더를 대기열에 남긴다(P1-12).
   * 워터마크는 드롭분 위를 지나가므로 여기 남기지 않으면 **그 오더는 LIS에 존재한 적이 없게 된다**.
   * 원문(payload)을 보관해 코드매핑·환자 보정 후 재적재할 수 있게 한다.
   */
  private async queueDroppedOrder(o: PolledOrder, reason: string): Promise<void> {
    await this.prisma.interfaceLog
      .upsert({
        // 같은 오더가 여러 주기에 걸쳐 드롭돼도 한 행으로 유지(멱등)
        where: { direction_messageControlId: { direction: 'INBOUND', messageControlId: `hisorder-${o.orderId}` } },
        update: { status: 'DROPPED', errorText: reason, payload: JSON.stringify(o) },
        create: {
          ifId: 'IF-HISORD', direction: 'INBOUND', messageType: 'ServiceRequest(active)',
          messageControlId: `hisorder-${o.orderId}`, status: 'DROPPED', errorText: reason, payload: JSON.stringify(o),
        },
      })
      .catch((e) => this.logger.error(`드롭 오더 대기열 적재 실패 HIS=${o.orderId}: ${e instanceof Error ? e.message : e}`));
  }

  /**
   * 대기열(미적재 HIS 오더) 목록 — 연계 콘솔용.
   * HIS 카탈로그가 반입돼 있으면 **코드명을 붙인다** — 코드만 보고는 어느 검사에 매핑할지
   * 판단할 수 없어 대기열이 사실상 방치된다.
   */
  async listDroppedOrders(take = 100) {
    const rows = await this.prisma.interfaceLog.findMany({
      where: { ifId: 'IF-HISORD', direction: 'INBOUND', status: 'DROPPED' },
      orderBy: { createdDt: 'desc' },
      take: Math.min(Math.max(take, 1), 500),
    });
    const parsed = rows.map((r) => {
      let order: PolledOrder | null = null;
      try { order = r.payload ? (JSON.parse(r.payload) as PolledOrder) : null; } catch { /* 손상 payload는 null */ }
      return { logId: r.logId, hisOrderId: order?.orderId ?? null, code: order?.code ?? null, reason: r.errorText, droppedDt: r.createdDt };
    });
    const names = await this.catalog.lookup(parsed.map((p) => p.code ?? '').filter(Boolean));
    return parsed.map((p) => ({
      ...p,
      // 카탈로그 미반입이거나 카탈로그에 없는 코드면 null — 후자는 HIS 측 범위 필터 확인 대상이다.
      codeName: p.code ? names.get(p.code)?.nameKo ?? null : null,
      loincCode: p.code ? names.get(p.code)?.loincCode ?? null : null,
    }));
  }

  /**
   * 대기열 재적재 — 코드매핑·환자정보를 보정한 뒤 호출한다.
   * 폴링과 **동일한 적재 경로**를 쓰므로 결과가 갈리지 않는다.
   * 여전히 드롭이면 대기열에 남긴다(사유만 갱신).
   */
  async retryDroppedOrders(): Promise<{ attempted: number; created: number; stillDropped: number; failed: number }> {
    const rows = await this.prisma.interfaceLog.findMany({
      where: { ifId: 'IF-HISORD', direction: 'INBOUND', status: 'DROPPED' },
      orderBy: { createdDt: 'asc' },
      take: 500,
    });
    if (rows.length === 0) return { attempted: 0, created: 0, stillDropped: 0, failed: 0 };

    const parsed: { logId: string; order: PolledOrder }[] = [];
    let failed = 0;
    for (const r of rows) {
      try {
        const order = JSON.parse(r.payload ?? '') as PolledOrder;
        if (!order?.orderId) throw new Error('orderId 없음');
        parsed.push({ logId: r.logId, order });
      } catch {
        failed++;
        await this.prisma.interfaceLog.update({ where: { logId: r.logId }, data: { status: 'FAILED', errorText: '원문 손상 — 재적재 불가' } }).catch(() => undefined);
      }
    }

    // 폴링 루프와 같은 선로드(오더당 쿼리 폭증 방지)
    const hisIds = parsed.map((p) => p.order.orderId);
    const [existLabRows, existPathRows] = await Promise.all([
      this.prisma.labOrder.findMany({ where: { hisOrderNo: { in: hisIds } }, select: { hisOrderNo: true, orderId: true, patientId: true } }),
      this.prisma.pathologyCase.findMany({ where: { hisOrderNo: { in: hisIds } }, select: { hisOrderNo: true, spNo: true, patientId: true } }),
    ]);
    const ctx = {
      existLab: new Map(existLabRows.map((x) => [x.hisOrderNo, { id: x.orderId, patientId: x.patientId }])),
      existPath: new Map(existPathRows.map((x) => [x.hisOrderNo, { id: x.spNo, patientId: x.patientId }])),
      maps: await this.loadResolveMaps(),
      // 환자명 재조회는 하지 않는다(HIS 왕복 비용). 미상이면 폴백명으로 생성되고 이후 갱신된다.
      nameMap: new Map<string, string | null>(),
    };

    let created = 0;
    let stillDropped = 0;
    for (const { logId, order } of parsed) {
      try {
        const r = await this.ingestPolledOrder(order, ctx);
        if (r.status === 'dropped') {
          stillDropped++;
          await this.prisma.interfaceLog.update({ where: { logId }, data: { errorText: r.dropReason ?? 'unknown' } });
        } else {
          if (r.status === 'created') created++;
          // 'exists'도 해소로 본다(다른 경로로 이미 적재됨)
          await this.prisma.interfaceLog.update({
            where: { logId },
            data: { status: 'PROCESSED', errorText: r.status === 'created' ? `재적재→${r.lisOrderId}` : '이미 적재됨' },
          });
        }
      } catch (e) {
        failed++;
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error(`대기열 재적재 실패 HIS=${order.orderId}: ${msg}`);
        await this.prisma.interfaceLog.update({ where: { logId }, data: { errorText: `재적재 실패: ${msg}` } }).catch(() => undefined);
      }
    }
    return { attempted: parsed.length, created, stillDropped, failed };
  }

  /**
   * HL7 푸시(IF-03) 수신 실패 목록 — 미매핑 코드·취소대상 없음·처리 예외로 FAILED에 굳은 오더.
   *
   * FHIR 폴링(IF-HISORD)의 DROPPED 대기열과 달리 **재폴링 경로가 없다** — HIS는 ACK(AE/AR)를 받고
   * 자기 몫을 끝냈다고 보므로, 코드매핑을 보정해도 그 오더는 저절로 들어오지 않는다(접수 누락 = 오더 유실).
   * 원문(payload)이 남아 있으므로 여기서 보여주고 재적재한다.
   */
  async listFailedHl7Orders(take = 100) {
    const rows = await this.prisma.interfaceLog.findMany({
      where: { ifId: 'IF-03', direction: 'INBOUND', status: 'FAILED' },
      orderBy: { createdDt: 'desc' },
      take: Math.min(Math.max(take, 1), 500),
    });
    const parsed = rows.map((r) => {
      let p: ParsedOrder | null = null;
      try { p = r.payload ? mapOml(parseHl7(r.payload)) : null; } catch { /* 손상 원문 — 재적재 불가로 표시 */ }
      return {
        logId: r.logId,
        messageControlId: r.messageControlId,
        messageType: r.messageType,
        hisOrderNo: p?.hisOrderNo || null,
        patientId: p?.patient.patientId || null,
        orderControl: p?.orderControl ?? null,
        priority: p?.priority ?? null,
        codes: p?.testCodes ?? [],
        reason: r.errorText,
        failedDt: r.createdDt,
        // 원문이 없거나 파싱 불가 / mcid 불일치면 재적재 대상이 아니다(HIS 재전송 필요)
        retryable: !!p && p.messageControlId === r.messageControlId,
      };
    });
    // 미매핑 코드가 어느 검사인지 — 카탈로그가 반입돼 있으면 코드명을 붙인다(드롭 대기열과 동일 이유:
    // 코드만 보고는 무엇에 매핑할지 판단할 수 없어 대기열이 방치된다).
    const names = await this.catalog.lookup(parsed.flatMap((p) => p.codes));
    return parsed.map((p) => ({
      ...p,
      codeNames: p.codes.map((c) => ({ code: c, nameKo: names.get(c)?.nameKo ?? null })),
    }));
  }

  /**
   * HL7 푸시 실패 오더 재적재 — 코드매핑 등록·취소대상 확인 후 호출한다.
   * 최초 수신과 **동일 경로**(`ingestOml`)를 쓰므로 결과가 갈리지 않는다.
   *
   * 멱등: FAILED 행만 `updateMany`로 PROCESSING에 원자 전이해 클레임한다 —
   * 동시 실행·같은 메시지 재수신과 경합해도 한쪽만 진행하므로 오더가 이중 생성되지 않는다.
   * (본체의 hisOrderNo 중복 가드가 폴링 경로와의 이중 유입도 함께 막는다.)
   * 여전히 실패면 FAILED로 되돌아가고 사유만 갱신된다.
   */
  async retryFailedHl7Orders(opts?: { logIds?: string[] }): Promise<{
    attempted: number; created: number; changed: number; cancelled: number; exists: number; stillFailed: number; corrupt: number;
  }> {
    const rows = await this.prisma.interfaceLog.findMany({
      where: {
        ifId: 'IF-03', direction: 'INBOUND', status: 'FAILED',
        ...(opts?.logIds?.length ? { logId: { in: opts.logIds } } : {}),
      },
      orderBy: { createdDt: 'asc' },
      take: 500,
    });
    const out = { attempted: 0, created: 0, changed: 0, cancelled: 0, exists: 0, stillFailed: 0, corrupt: 0 };

    for (const r of rows) {
      // 원자적 재클레임 — 이 시점에 FAILED인 행만 잡는다(경합 시 count=0으로 건너뜀)
      const claimed = await this.prisma.interfaceLog.updateMany({
        where: { logId: r.logId, status: 'FAILED' },
        data: { status: 'PROCESSING' },
      });
      if (claimed.count === 0) continue;

      let parsed: ParsedOrder | null = null;
      try { parsed = mapOml(parseHl7(r.payload ?? '')); } catch { /* 아래에서 손상 처리 */ }
      // mcid 불일치는 log()가 **다른 행**을 갱신하게 만들어 이 행이 PROCESSING에 방치된다 — 손상으로 취급
      if (!parsed || parsed.messageControlId !== r.messageControlId) {
        out.corrupt++;
        await this.prisma.interfaceLog.update({
          where: { logId: r.logId },
          data: { status: 'FAILED', errorText: '원문 손상·제어ID 불일치 — 재적재 불가(HIS 재전송 필요)' },
        }).catch(() => undefined);
        continue;
      }

      out.attempted++;
      try {
        const res = await this.ingestOml(r.payload as string, parsed, parsed.messageControlId);
        if (res.result === 'CREATED') out.created++;
        else if (res.result === 'CHANGED') out.changed++;
        else if (res.result === 'CANCELLED') out.cancelled++;
        else if (res.result === 'EXISTS') out.exists++; // 폴링 등 다른 경로로 이미 적재됨 = 해소
        else out.stillFailed++; // UNMAPPED_HOLD · NO_ORDER · ERROR — 사유는 ingestOml이 기록
      } catch (e) {
        // ingestOml 내부 catch가 FAILED를 기록하지만, 그 바깥에서 터진 경우 PROCESSING 방치를 막는다
        out.stillFailed++;
        const msg = e instanceof Error ? e.message : String(e);
        this.logger.error(`HL7 실패 오더 재적재 실패 mcid=${r.messageControlId}: ${msg}`);
        await this.prisma.interfaceLog.update({
          where: { logId: r.logId },
          data: { status: 'FAILED', errorText: `재적재 실패: ${msg}` },
        }).catch(() => undefined);
      }
    }
    return out;
  }

  /** 연동 상태 KV 읽기(증분 폴링 워터마크 등). */
  private async getState(key: string): Promise<string | null> {
    const row = await this.prisma.integrationState.findUnique({ where: { key } });
    return row?.value ?? null;
  }
  private async setState(key: string, value: string): Promise<void> {
    await this.prisma.integrationState.upsert({ where: { key }, update: { value }, create: { key, value } });
  }

  /** HIS FHIR 설정(env). 미설정 시 null(라이브 대기). */
  private hisFhirConfig(): HisFhirConfig | null {
    const base = process.env.HIS_FHIR_BASE;
    const clientId = process.env.HIS_CLIENT_ID;
    if (!base || !clientId) return null;
    return {
      tokenUrl: process.env.HIS_FHIR_TOKEN_URL || 'https://his.example.org/oauth2/token',
      fhirBase: base,
      clientId,
      clientSecret: process.env.HIS_CLIENT_SECRET || '',
      scopes:
        process.env.HIS_FHIR_SCOPES ||
        'system/DiagnosticReport.write system/Observation.write system/ServiceRequest.read system/Patient.read',
    };
  }

  /**
   * 결과를 HIS FHIR로 실제 전송 (DiagnosticReport POST → HIS 스테이징 큐).
   * 자격증명(HIS_CLIENT_ID/SECRET) 미설정 시 configured=false(라이브 대기).
   */
  async sendResultToHis(specimenNo: string) {
    const report = await this.buildFhirBundle(specimenNo);
    const cfg = this.hisFhirConfig();
    if (!cfg) return { configured: false, sent: false, report };

    const token = await getAccessToken(cfg);
    const r = await postDiagnosticReport(cfg, token, report as Record<string, unknown>);
    await this.prisma.interfaceLog.create({
      data: {
        ifId: 'IF-G08',
        direction: 'OUTBOUND',
        messageType: 'FHIR DiagnosticReport',
        messageControlId: r.id,
        status: 'PROCESSED',
        payload: JSON.stringify(report),
      },
    });
    return { configured: true, sent: true, ingest: r };
  }

  /**
   * 병리 오더 → PACS 모달리티 워크리스트(ORM^O01) 전송 (IF-09, PACS 정본 §3).
   * 대상: PACS_MLLP_HOST/PORT(기본 openpacs 리스너). ACK != AA면 실패 처리.
   */
  async sendPathologyWorklist(spNo: string, host?: string, port?: number) {
    return this.sendOrm(spNo, 'NW', host, port);
  }

  /**
   * 병리 워크리스트 취소(ORC-1=CA) → PACS worklist CANCELLED (PACS 결정2, 2026-07-13).
   * 케이스 철회 시 호출. PACS는 CA/OC/DC/CR 모두 취소로 처리.
   */
  async cancelPathologyWorklist(spNo: string, host?: string, port?: number) {
    return this.sendOrm(spNo, 'CA', host, port);
  }

  private async sendOrm(spNo: string, orderControl: 'NW' | 'CA', host?: string, port?: number) {
    const c = await this.prisma.pathologyCase.findUnique({
      where: { spNo },
      include: { patient: true, report: true },
    });
    if (!c) throw new BadRequestException(`병리 검사 없음: ${spNo}`);

    const accession = c.report?.accessionNo ?? buildAccession(spNo);
    // 저장된 accession이 채번 규칙과 다르면 **PACS 대조가 어긋난다**(뷰어·워크리스트가 다른 키를 본다).
    // 규칙은 2자리 연도(PACS 결정1, 헤드룸 확보)이며, 어긋난 값이 있으면 드러내 놓는다.
    if (c.report?.accessionNo && c.report.accessionNo !== buildAccession(spNo)) {
      this.logger.warn(`Accession 채번 불일치 ${spNo}: 저장 ${c.report.accessionNo} ≠ 규칙 ${buildAccession(spNo)}`);
    }
    const overflow = accessionOverflow(accession);
    if (overflow) throw new BadRequestException(overflow);

    const now = this.stamp();
    const messageControlId = `MWL${Date.now()}`; // MSH-10(멱등키) — 매 전송 고유
    const orm = buildOrm({
      messageControlId,
      nowStamp: now,
      patientId: c.patientId,
      patientFamily: c.patient.name, // LIS는 성명 단일 저장 → family에 배치
      patientGiven: '',
      birthDate: (c.patient.birthDate ?? '').replace(/-/g, ''),
      sex: c.patient.sex ?? 'U',
      accession,
      procedureId: 'PATH',
      procedureDesc: '병리 슬라이드 스캔',
      scheduledTs: now,
      modality: 'SM', // 병리 WSI
      orderControl,
    });

    const h = host || process.env.PACS_MLLP_HOST;
    const p = port || Number(process.env.PACS_MLLP_PORT || 0);
    if (!h || !p) throw new BadRequestException('PACS MLLP 대상 미설정(PACS_MLLP_HOST/PORT)');

    /**
     * ★송신 자체가 실패해도(연결 거부·타임아웃) 반드시 로그를 남긴다.
     *   예전엔 sendMllp가 throw하면 아래 interfaceLog.create에 도달하지 못해
     *   **기록이 아예 없었다.** 호출측(병리 접수)은 best-effort로 warn만 남기고 넘어가므로,
     *   PACS가 죽어 있으면 워크리스트 없는 병리 케이스가 조용히 쌓인다(스캔 누락).
     *   감시 지표(mwlFailed)도 이 로그를 세므로, 로그가 없으면 감시도 눈을 감는다.
     */
    let res: { ackCode: string; ack: string };
    try {
      res = await sendMllp(h, p, orm);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await this.prisma.interfaceLog.create({
        data: {
          ifId: 'IF-09',
          direction: 'OUTBOUND',
          messageType: orderControl === 'CA' ? 'ORM^O01(MWL-CANCEL)' : 'ORM^O01(MWL)',
          messageControlId,
          status: 'FAILED',
          errorText: `송신 실패: ${msg}`.slice(0, 500),
          payload: orm,
        },
      }).catch(() => undefined);
      throw e; // 호출측 계약은 그대로 — 기록만 보강한다
    }
    await this.prisma.interfaceLog.create({
      data: {
        ifId: 'IF-09',
        direction: 'OUTBOUND',
        messageType: orderControl === 'CA' ? 'ORM^O01(MWL-CANCEL)' : 'ORM^O01(MWL)',
        messageControlId, // MSH-10(고유) — accession은 payload에 포함, 재전송·취소 허용
        status: res.ackCode === 'AA' ? 'PROCESSED' : 'FAILED',
        errorText: res.ackCode === 'AA' ? null : res.ack,
        payload: orm,
      },
    });
    // 케이스에 MWL 송신 상태 기록(재검토 보완) — 성공 시 SENT/CANCELLED로 케이스 화면에 지속 표시.
    if (res.ackCode === 'AA') {
      await this.prisma.pathologyCase.update({
        where: { spNo },
        data: orderControl === 'CA'
          ? { mwlStatus: 'CANCELLED' }
          : { mwlStatus: 'SENT', mwlSentDt: new Date() },
      }).catch(() => undefined);
    }
    return { sentTo: `${h}:${p}`, accession, orderControl, ackCode: res.ackCode, ack: res.ack };
  }

  /**
   * PACS 컷오버 프리플라이트 — 실 병리번호·실 PID를 즉석 검증.
   *  ① accession: buildAccession 결과가 DICOM VR=SH(16자) 이내인지(loud-fail 규칙).
   *  ② PatientID: 실제 HL7 파싱 경로(parseHl7→PID-3)로 왕복해 바이트 보존 여부(선행0·하이픈·공백).
   * 저장/전송 없는 순수 검증. 운영자가 컷오버 당일 실데이터로 PASS/FAIL 확인용.
   */
  cutoverPreflight(spNos: string[] = [], patientIds: string[] = []) {
    const HL7_DELIMS = /[|^~\\&\r\n]/;

    const accession = spNos.map((spNo) => {
      const acc = buildAccession(spNo);
      const overflow = accessionOverflow(acc);
      return { spNo, accession: acc, length: acc.length, ok: !overflow, reason: overflow ?? undefined };
    });

    const patientId = patientIds.map((input) => {
      const hasDelim = HL7_DELIMS.test(input);
      // 정책: PatientID 후행공백 정규화(edge-trim). 선행0·하이픈 등 유의 문자는 보존.
      const normalized = input.replace(/\s+$/, '');
      // PID-3 뒤에 필드를 두어(마지막 필드 아님) 라인 trim 영향 배제 → 실 파이프라인(mapOml)과 동일 경로+정규화로 왕복
      const parsed = parseHl7(`PID|1||${input}||^^^`);
      const roundTrip = comp(field(seg(parsed, 'PID'), 3), 1).replace(/\s+$/, '');
      const preserved = !hasDelim && roundTrip === normalized; // 유의 바이트(선행0·하이픈 포함) 보존
      const edgeTrimmed = input !== normalized;
      const risks: string[] = [];
      if (/^0/.test(input)) risks.push('선행0');
      if (input.includes('-')) risks.push('하이픈');
      if (/^\s/.test(input)) risks.push('선행공백');
      return {
        input,
        normalized,
        roundTrip,
        preserved,
        edgeTrimmed,
        byteLength: Buffer.byteLength(normalized, 'utf8'),
        risks,
        note: hasDelim
          ? 'HL7 구분자(|^~\\&) 포함 — 실 PID로 부적합'
          : !preserved
            ? '불일치(파이프라인 변형)'
            : edgeTrimmed
              ? '후행공백 정규화(edge-trim) 후 유의바이트 보존 OK'
              : '바이트 보존 OK',
      };
    });

    const accessionFail = accession.filter((a) => !a.ok).length;
    const pidFail = patientId.filter((p) => !p.preserved).length;
    return {
      accession,
      patientId,
      summary: {
        accessionTotal: accession.length,
        accessionPass: accession.length - accessionFail,
        accessionFail,
        pidTotal: patientId.length,
        pidPass: patientId.length - pidFail,
        pidFail,
        allPass: accessionFail === 0 && pidFail === 0,
        rule: { accessionMaxLen: DICOM_ACCESSION_MAX, yearDigits: 2, pidPreservation: 'verbatim(no-trim/no-coerce)' },
      },
    };
  }

  /**
   * 병리 판독화면용 PACS 뷰어 링크 조회 (P4 흐름: QIDO→UID→딥링크).
   * 라이브 조회는 서비스계정 토큰(PACS_QIDO_BASE/PACS_TOKEN/PACS_VIEWER_BASE) 필요.
   * 미설정 시 accession만 반환(라이브 대기 상태).
   */
  async getPathologyViewerLink(spNo: string) {
    const c = await this.prisma.pathologyCase.findUnique({
      where: { spNo },
      include: { report: true },
    });
    if (!c) throw new BadRequestException(`병리 검사 없음: ${spNo}`);
    // ★MWL과 **같은 채번**이어야 한다. 예전엔 여기만 `ACC-${spNo}`(4자리 연도)라
    //   보고서 없는 케이스에서 MWL은 `ACC-SP-26-0456`, 뷰어는 `ACC-SP-2026-0456`으로 갈렸다 —
    //   판독의가 뷰어를 열면 스터디를 못 찾는다(조용한 미표시라 "아직 스캔 전"과 구분되지 않는다).
    const accession = c.report?.accessionNo ?? buildAccession(spNo);

    const pacsBase = process.env.PACS_BASE; // 예: https://his.example.org
    if (!pacsBase) {
      return { accession, configured: false, found: null, viewerUrl: null };
    }
    // 뷰어는 PACS 런처(AccessionNumber 직접, 새 창)
    const viewerUrl = buildLauncherUrl(pacsBase, accession);

    // 서비스계정(svc-lis) 있으면 QIDO로 스터디 존재 확인
    let found: boolean | null = null;
    const user = process.env.PACS_USER;
    const pass = process.env.PACS_PASS;
    if (user && pass) {
      try {
        const token = await pacsLogin(pacsBase, user, pass);
        // 표준 QIDO-RS 경로(/rs/studies) — PACS 커스텀 형식이 아닌 표준 DICOMweb
        const qidoBase = `${pacsBase.replace(/\/+$/, '')}/pacs-api/api/v1/dicomweb/rs`;
        const r = await resolveViewerLink(qidoBase, viewerUrl, token, accession);
        found = r.found;
      } catch (e) {
        this.logger.warn(`PACS QIDO 확인 실패: ${e instanceof Error ? e.message : e}`);
      }
    }
    return { accession, configured: true, viewerUrl, found };
  }

  /**
   * WSI 열람 종단 확인(③, PACS 재검토 보완) — viewer-link를 해소하고, WSI가 존재(found=true)하면
   * 케이스에 열람 확인(who/when)을 기록. PACS §4.4 마감의 LIS측 회신 아티팩트.
   * found=false면 확인 미기록(아직 WSI 미도착) — 통지 후 재시도.
   */
  async confirmWsiView(spNo: string, confirmedBy?: string) {
    const link = await this.getPathologyViewerLink(spNo);
    if (link.found === true) {
      await this.prisma.pathologyCase.update({
        where: { spNo },
        data: { wsiConfirmedDt: new Date(), wsiConfirmedBy: confirmedBy ?? null },
      }).catch(() => undefined);
      return { ...link, confirmed: true, confirmedBy: confirmedBy ?? null };
    }
    return { ...link, confirmed: false, reason: link.configured === false ? 'PACS 미연동' : 'WSI 미도착(스터디 없음)' };
  }

  /** 코드 해소용 마스터 선로드(폴링 오더 루프 밖 1회) — resolveWith가 DB 0회로 해소(N+1·풀스캔 제거). */
  private async loadResolveMaps(): Promise<ResolveMaps> {
    const [panels, cms, tests] = await Promise.all([
      this.prisma.panel.findMany({ include: { items: { select: { testCode: true } } } }),
      this.prisma.codeMapping.findMany({ select: { lisCode: true, hisCode: true, ediCode: true } }),
      this.prisma.testMaster.findMany({ select: { testCode: true } }),
    ]);
    const panelMap = new Map<string, string[]>(panels.map((p) => [p.panelCode, p.items.map((i) => i.testCode)]));
    const byHis = new Map<string, string[]>();
    const byEdi = new Map<string, string[]>();
    for (const c of cms) {
      if (c.hisCode) { const a = byHis.get(c.hisCode) ?? []; a.push(c.lisCode); byHis.set(c.hisCode, a); }
      if (c.ediCode) { const a = byEdi.get(c.ediCode) ?? []; a.push(c.lisCode); byEdi.set(c.ediCode, a); }
    }
    return { panels: panelMap, byHis, byEdi, tests: new Set(tests.map((t) => t.testCode)) };
  }

  /** in-memory 코드 해소 — 패널 전개 → 코드매핑(hisCode/edi_code 1:N) → 직접 일치. */
  private resolveWith(hisCodes: string[], maps: ResolveMaps): { mapped: string[]; unmapped: string[] } {
    const mapped: string[] = [];
    const unmapped: string[] = [];
    for (const his of hisCodes) {
      const panel = maps.panels.get(his);
      if (panel && panel.length) { mapped.push(...panel); continue; }
      const cm = [...(maps.byHis.get(his) ?? []), ...(maps.byEdi.get(his) ?? [])];
      if (cm.length) { mapped.push(...cm); continue; }
      if (maps.tests.has(his)) { mapped.push(his); continue; }
      unmapped.push(his);
    }
    return { mapped: Array.from(new Set(mapped)), unmapped };
  }

  private async resolveTestCodes(hisCodes: string[]): Promise<{ mapped: string[]; unmapped: string[] }> {
    return this.resolveWith(hisCodes, await this.loadResolveMaps());
  }

  /** 동시성 상한 병렬 실행(환자명 배치 조회 등). */
  private async mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
    let i = 0;
    const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) { const idx = i++; await fn(items[idx]); }
    });
    await Promise.all(workers);
  }

  private mapSex(s: string): 'M' | 'F' | 'O' | 'U' {
    if (s === 'M' || s === 'F' || s === 'O') return s;
    return 'U';
  }

  private stamp(): string {
    const d = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  }

  private async generateOrderId(): Promise<string> {
    return genId('O');
  }

  /**
   * 병리번호 채번(LIS) — SP-{YYYY}-{4자리 순번}. accession 파생 형식(-YYYY-)과 정합.
   * count+1이 아닌 **당해 최대값+1**(삭제·경합에도 역행 없음). 경합 잔여 창은 호출부 P2002 재시도.
   */
  private async generatePathNo(): Promise<string> {
    const year = new Date().getFullYear();
    const prefix = `SP-${year}-`;
    // _max 한 건 조회 — 종전 당해 전 케이스 로드는 연말이면 수천 행을 채번마다(그리고
    // P2002 재시도마다) 읽었다. 문자열 max는 고정폭(4자리)에서만 순번 최대와 일치하므로,
    // 4자리를 넘긴 해(연 1만 케이스 초과)에만 전체 파싱으로 폴백한다.
    const agg = await this.prisma.pathologyCase.aggregate({ _max: { spNo: true }, where: { spNo: { startsWith: prefix } } });
    const maxNo = agg._max.spNo;
    if (maxNo && maxNo.length > prefix.length + 4) {
      const rows = await this.prisma.pathologyCase.findMany({ where: { spNo: { startsWith: prefix } }, select: { spNo: true } });
      return formatSeq(prefix, nextSuffixSeq(rows.map((r) => r.spNo), prefix), 4);
    }
    return formatSeq(prefix, nextSuffixSeq(maxNo ? [maxNo] : [], prefix), 4);
  }

  private async log(
    direction: string,
    parsed: { messageControlId: string; messageType: string },
    raw: string,
    status: InterfaceLogStatus, // 상태 어휘 정본(domain/enums) — 새 상태는 거기 추가
    errorText?: string,
  ): Promise<void> {
    // upfront-claim(PROCESSING) 이후 최종 상태로 갱신 — upsert로 멱등(claim 없던 경로도 안전)
    await this.prisma.interfaceLog.upsert({
      where: { direction_messageControlId: { direction, messageControlId: parsed.messageControlId } },
      update: { status, errorText: errorText ?? null },
      create: {
        ifId: 'IF-03',
        direction,
        messageType: parsed.messageType,
        messageControlId: parsed.messageControlId,
        status,
        errorText: errorText ?? null,
        payload: raw,
      },
    });
  }

}
