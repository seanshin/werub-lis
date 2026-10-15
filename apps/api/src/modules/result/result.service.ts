/**
 * ResultService — result 도메인 서비스.
 *
 * 주요 진입점: `findBySpecimen()`, `reportableSpecimens()`, `report()`, `reportHtml()`, `recordDelivery()`, `listDeliveries()`, `cumulativeReport()`, `submitResult()`…
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, NotFoundException, BadRequestException, ConflictException, ForbiddenException, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SubmitResultDto, AckCriticalDto, CorrectResultDto, VerifyResultDto, VerifyBatchDto } from './dto/result.dto';
import { CriticalNotifierService } from './critical-notifier.service';
import { ReflexService } from '../reflex/reflex.service';
import { reflexMatches } from '../../domain/reflex';
import { computeDerived } from '../../domain/derived-tests';
import { buildResultEvidenceContext } from '../../domain/result-evidence-context';
import { hilInterference } from '../../domain/hil-interference';
import { pickLatestByKey } from '../../domain/result-latest';
import { genId } from '../../common/id.util';
import { isUniqueViolation } from '../../common/prisma-error.util';
import { attachmentDomain, canAccessAttachment } from './attachment-access';
import { pickReferenceRange, determineFlag, isAutoVerifiable, isCritical, isNumeric, checkDelta, holdReasonFor, holdPriority, HoldReason, RefRange, ResultFlag, Sex, isFinalized, FINALIZED_VERIFY_STATES, calcAge } from '../../domain/result-evaluation';
import { escapeHtml, formatRange } from '@lis/shared';

@Injectable()
export class ResultService {
  private readonly logger = new Logger(ResultService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly notifier: CriticalNotifierService,
    private readonly reflex: ReflexService,
  ) {}

  async findBySpecimen(specimenNo: string) {
    return this.prisma.result.findMany({
      where: { specimenNo },
      include: { test: true, criticals: true },
    });
  }

  /**
   * 보고 가능 검체 목록 — 보고서 화면의 진입점.
   *
   * 이전에는 검체번호를 **미리 알아야만** 보고서를 열 수 있어, 번호를 모르면 화면이
   * 무용지물이었다(무엇을 볼 수 있는지 알 방법이 없었다). 확정(AUTO/VERIFIED) 결과가
   * 하나라도 있는 검체를 최신 보고순으로 돌려준다.
   *
   * 기간은 **보고 시각(reportedDt)** 기준 — 사용자가 찾는 것은 "언제 나온 결과"다.
   */
  async reportableSpecimens(opts: { from?: string; to?: string; q?: string; take?: number }) {
    const take = Math.min(Math.max(opts.take ?? 50, 1), 200);
    const range = this.dayRange(opts.from, opts.to);
    const q = opts.q?.trim();

    const results = await this.prisma.result.findMany({
      where: {
        verifyState: { in: [...FINALIZED_VERIFY_STATES] },
        ...(range ? { reportedDt: range } : {}),
        ...(q
          ? {
              OR: [
                { specimenNo: { contains: q, mode: 'insensitive' as const } },
                { specimen: { order: { patient: { patientId: { contains: q, mode: 'insensitive' as const } } } } },
                { specimen: { order: { patient: { name: { contains: q } } } } },
              ],
            }
          : {}),
      },
      select: {
        specimenNo: true, reportedDt: true, flag: true,
        specimen: { select: { specimenType: true, order: { select: { orderId: true, patient: { select: { patientId: true, name: true } } } } } },
      },
      orderBy: { reportedDt: 'desc' },
      take: take * 8, // 검체당 여러 결과 → 그룹핑 여유분
    });

    // 검체 단위로 접기 — 목록에는 "언제·누구·몇 건·위험치 포함 여부"만 필요하다
    const byspec = new Map<string, { specimenNo: string; patientId: string; patientName: string; specimenType: string | null; orderId: string; reportedDt: Date | null; testCount: number; hasCritical: boolean }>();
    for (const r of results) {
      const cur = byspec.get(r.specimenNo);
      const critical = !!r.flag && isCritical(r.flag as ResultFlag);
      if (cur) {
        cur.testCount += 1;
        cur.hasCritical = cur.hasCritical || critical;
        if (r.reportedDt && (!cur.reportedDt || r.reportedDt > cur.reportedDt)) cur.reportedDt = r.reportedDt;
      } else {
        byspec.set(r.specimenNo, {
          specimenNo: r.specimenNo,
          patientId: r.specimen.order.patient.patientId,
          patientName: r.specimen.order.patient.name,
          specimenType: r.specimen.specimenType,
          orderId: r.specimen.order.orderId,
          reportedDt: r.reportedDt,
          testCount: 1,
          hasCritical: critical,
        });
      }
    }
    return [...byspec.values()]
      .sort((a, b) => (b.reportedDt?.getTime() ?? 0) - (a.reportedDt?.getTime() ?? 0))
      .slice(0, take);
  }

  /** 날짜(YYYY-MM-DD) 기간 → 당일 경계 보정(from 00:00, to 23:59:59.999). */
  private dayRange(from?: string, to?: string): { gte?: Date; lte?: Date } | undefined {
    const bound = (v: string, end: boolean): Date | null => {
      const d = new Date(v);
      if (isNaN(d.getTime())) return null;
      if (!v.includes('T')) { if (end) d.setHours(23, 59, 59, 999); else d.setHours(0, 0, 0, 0); }
      return d;
    };
    const r: { gte?: Date; lte?: Date } = {};
    if (from) { const d = bound(from, false); if (d) r.gte = d; }
    if (to) { const d = bound(to, true); if (d) r.lte = d; }
    return r.gte || r.lte ? r : undefined;
  }

  /** 결과보고서 — 환자·검체·결과(참고치·판정·검증자) 서식용 데이터. */
  async report(specimenNo: string) {
    const specimen = await this.prisma.specimen.findUnique({
      where: { specimenNo },
      include: { order: { include: { patient: true } }, results: { include: { test: true } } },
    });
    if (!specimen) throw new NotFoundException(`검체 없음: ${specimenNo}`);
    // 검사별 최신 버전만 — rerun·정정 tie까지 안전하게(P1-1). reportedDt 순서로 정렬해 넣어
    // 마지막 방어 규칙(완전 동률 시 나중 원소)이 시간순을 따르게 한다.
    const orderedResults = [...specimen.results].sort((a, b) => (a.reportedDt?.getTime() ?? 0) - (b.reportedDt?.getTime() ?? 0));
    const latest = pickLatestByKey(orderedResults, (r) => r.testCode);
    const patient = specimen.order.patient;
    const rptAge = this.calcAge(patient.birthDate);
    const rangeMap = await this.pickRangesBatch([...latest.keys()], patient.sex, rptAge); // 참고치 일괄 조회(N+1 제거)
    const rows = [];
    for (const r of latest.values()) {
      const rr = rangeMap.get(r.testCode) ?? null; // 성별·연령 매칭(표시=판정 일치)
      rows.push({
        testCode: r.testCode,
        testName: r.test.name,
        value: r.value,
        unit: r.unit ?? r.test.unitUcum,
        // 마스터 단위 — 화면이 결과 단위와 대조해 불일치를 표면화한다(UX §2-4).
        // 참고치에 단위 컬럼이 없어 "참고치 단위 = 결과 단위"가 시스템으로 보장되지 않으므로,
        // 장비가 SI로 올리는 등 단위가 어긋나면 값 자체를 오판할 수 있다.
        masterUnit: r.test.unitUcum,
        flag: r.flag,
        // 참고치는 **마스터 단위와 함께** 표기(shared formatRange — en-dash 통일)
        refRange: formatRange(rr?.low, rr?.high, r.test.unitUcum),
        verifyState: r.verifyState,
        verifier: r.verifier,
        version: r.version,
        reportedDt: r.reportedDt,
        comment: r.comment,
        interpretation: r.interpretation,
      });
    }
    return {
      specimenNo,
      collectedDt: specimen.collectedDt,
      receivedDt: specimen.receivedDt,
      patient: {
        patientId: specimen.order.patient.patientId,
        name: specimen.order.patient.name,
        sex: specimen.order.patient.sex,
        birthDate: specimen.order.patient.birthDate,
      },
      orderId: specimen.orderId,
      results: rows.sort((a, b) => a.testName.localeCompare(b.testName)),
    };
  }

  /** 인쇄용 결과보고서 HTML(C1) — 자체완결 서식. 브라우저 인쇄→PDF 경로. 값은 HTML 이스케이프. */
  async reportHtml(specimenNo: string): Promise<string> {
    const r = await this.report(specimenNo);
    const esc = escapeHtml; // 정본은 @lis/shared — 클로저로 복제하지 않는다
    const rowsHtml = r.results.map((row) => {
      const crit = row.flag && row.flag !== 'N';
      const notes = [row.interpretation && `해석: ${esc(row.interpretation)}`, row.comment && `코멘트: ${esc(row.comment)}`].filter(Boolean).join(' · ');
      const finalized = isFinalized(row.verifyState);
      return `<tr>
        <td>${esc(row.testName)} <span class="c">${esc(row.testCode)}</span></td>
        <td class="${crit ? 'crit' : ''}"><b>${esc(row.value)}</b>${finalized ? '' : ' <span class="prelim">예비</span>'}</td>
        <td>${esc(row.unit ?? '')}</td>
        <td>${esc(row.refRange)}</td>
        <td>${esc(row.flag ?? '')}</td>
        <td>${finalized ? '확정' : esc(row.verifyState ?? '')}${row.verifier ? ' · ' + esc(row.verifier) : ''}</td>
      </tr>${notes ? `<tr><td colspan="6" class="note">${notes}</td></tr>` : ''}`;
    }).join('');
    const p = r.patient;
    return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>결과보고서 ${esc(specimenNo)}</title>
<style>
body{font-family:'Malgun Gothic',sans-serif;color:#111;margin:24px;font-size:13px}
h1{font-size:18px;margin:0 0 4px}
.hd{display:flex;justify-content:space-between;border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:12px}
.meta{color:#444;font-size:12px;line-height:1.6}
table{width:100%;border-collapse:collapse;font-size:12px}
th,td{text-align:left;padding:5px 8px;border-bottom:1px solid #ddd}
th{background:#f4f4f4;border-bottom:1px solid #999}
.c{color:#888;font-family:monospace;font-size:11px}
.crit{color:#c00}
.prelim{color:#c60;font-size:10px;border:1px solid #c60;border-radius:3px;padding:0 3px}
.note{color:#555;font-style:italic;font-size:11px;padding-left:16px}
.ft{margin-top:16px;color:#777;font-size:11px;border-top:1px solid #ccc;padding-top:8px}
@media print{body{margin:0}}
</style></head><body>
<div class="hd"><div><h1>검사결과보고서</h1><div class="meta">검체번호 ${esc(specimenNo)} · 오더 ${esc(r.orderId)}</div></div>
<div class="meta">${esc(p.name)} (${esc(p.patientId)})<br>${esc(p.sex ?? '')} · ${esc(p.birthDate ?? '')}<br>보고 ${new Date().toISOString().slice(0, 10)}</div></div>
<table><thead><tr><th>검사</th><th>결과</th><th>단위</th><th>참고치</th><th>플래그</th><th>검증</th></tr></thead>
<tbody>${rowsHtml || '<tr><td colspan="6">결과 없음</td></tr>'}</tbody></table>
<div class="ft">본 보고서는 검사정보시스템(LIS)에서 출력되었습니다. 예비(미확정) 결과는 최종 확정 전 참고용입니다.</div>
</body></html>`;
  }

  /** 리포트 배포 기록(C1) — 인쇄·포털·의뢰의 전달 로그. */
  async recordDelivery(specimenNo: string, dto: { channel: string; recipient?: string; deliveredBy?: string; note?: string }) {
    const valid = ['PRINT', 'PORTAL', 'PROVIDER', 'FAX'];
    if (!valid.includes(dto.channel)) throw new BadRequestException(`배포 채널 오류: ${dto.channel}`);
    const spec = await this.prisma.specimen.findUnique({ where: { specimenNo } });
    if (!spec) throw new NotFoundException(`검체 없음: ${specimenNo}`);
    return this.prisma.reportDelivery.create({
      data: { specimenNo, channel: dto.channel, recipient: dto.recipient ?? null, deliveredBy: dto.deliveredBy ?? null, note: dto.note ?? null },
    });
  }

  /** 리포트 배포 이력 조회(C1). */
  async listDeliveries(specimenNo: string) {
    return this.prisma.reportDelivery.findMany({ where: { specimenNo }, orderBy: { deliveredDt: 'desc' } });
  }

  /**
   * 누적(추세) 보고서 — 환자의 확정 결과를 검사별 시계열로 묶어 경시 모니터링 제공.
   * 검체 단위 최신 버전만 채택(정정 반영). 기간 필터(from~to, 날짜) 선택.
   */
  async cumulativeReport(patientId: string, from?: string, to?: string) {
    const patient = await this.prisma.patient.findUnique({ where: { patientId } });
    if (!patient) throw new NotFoundException(`환자를 찾을 수 없습니다: ${patientId}`);

    const results = await this.prisma.result.findMany({
      where: {
        specimen: { order: { patientId } },
        status: { in: ['F', 'C'] },
        verifyState: { in: [...FINALIZED_VERIFY_STATES] },
        ...(from || to
          ? { reportedDt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(`${to}T23:59:59`) } : {}) } }
          : {}),
      },
      include: { test: true },
      orderBy: { reportedDt: 'asc' },
    });

    // (검사코드, 검체)별 최신 버전만 — 정정·재검 tie 안전(P1-1). results는 reportedDt asc.
    const byKey = pickLatestByKey(results, (r) => `${r.testCode}|${r.specimenNo}`);

    // 검사별 시계열
    const tests = new Map<string, { testCode: string; testName: string; unit: string | null; series: { dt: Date | null; specimenNo: string; value: string | null; flag: string | null }[] }>();
    for (const r of [...byKey.values()].sort((a, b) => (a.reportedDt?.getTime() ?? 0) - (b.reportedDt?.getTime() ?? 0))) {
      let t = tests.get(r.testCode);
      if (!t) { t = { testCode: r.testCode, testName: r.test.name, unit: r.unit ?? r.test.unitUcum, series: [] }; tests.set(r.testCode, t); }
      t.series.push({ dt: r.reportedDt, specimenNo: r.specimenNo, value: r.value, flag: r.flag });
    }

    // 참고범위 결합 — 성별·연령 매칭(표시=판정 일치). 검사 전체 일괄 조회(N+1 제거)
    const cumAge = this.calcAge(patient.birthDate);
    const cumRangeMap = await this.pickRangesBatch([...tests.keys()], patient.sex, cumAge);
    const list = [];
    for (const t of tests.values()) {
      const rr = cumRangeMap.get(t.testCode) ?? null;
      list.push({ ...t, refRange: rr?.low != null && rr?.high != null ? `${rr.low} – ${rr.high}` : '' });
    }
    return {
      patient: { patientId: patient.patientId, name: patient.name, sex: patient.sex, birthDate: patient.birthDate },
      tests: list.sort((a, b) => a.testName.localeCompare(b.testName)),
    };
  }

  /**
   * 결과 등록 + 자동 평가 — LIS 핵심 흐름 (근거: 07 §4)
   *  1) 참고치 매칭(성별·연령)  2) 판정(flag)  3) 자동검증 여부
   *  4) 위험치면 통보(CriticalNotify) 자동 생성
   */
  /**
   * 결과 제출 — 참고치 판정·델타·QC·패닉통보·리플렉스까지의 정본 경로.
   * `opts.forceHold`: 자동검증을 막고 지정 사유로 수동검증 대기시킨다(외부위탁 회신 등).
   *   자연 보류사유(위험치·델타 등)가 있으면 그쪽이 우선한다 — 워크리스트 정렬이 위험도를 따르도록.
   */
  async submitResult(dto: SubmitResultDto, opts?: { forceHold?: HoldReason }) {
    // 이중입력 검증(수기 경로 오타 방지) — 확인값 불일치 시 차단
    if (dto.valueConfirm != null && dto.valueConfirm !== dto.value) {
      throw new BadRequestException(
        `이중입력 불일치: 입력값(${dto.value}) ≠ 확인값(${dto.valueConfirm}) — 재확인 필요`,
      );
    }

    const specimen = await this.prisma.specimen.findUnique({
      where: { specimenNo: dto.specimenNo },
      include: { order: { include: { patient: true } } },
    });
    if (!specimen) throw new NotFoundException(`검체를 찾을 수 없습니다: ${dto.specimenNo}`);

    const test = await this.prisma.testMaster.findUnique({ where: { testCode: dto.testCode } });
    if (!test) throw new BadRequestException(`미등록 검사코드: ${dto.testCode}`);

    // 중복 결과 가드 — 동일 검체+검사에 이미 확정(AUTO/VERIFIED) 결과가 있는데 rerun이 아니면 재제출 차단.
    // 실수 재전송(HIS DR 재수신 등)이 조용히 version-1 중복행이 되던 것 방지(HIS 수신측 dedup과 대칭).
    // 의도적 재검(rerun=true)은 명시적 신호라 허용. 정정은 correct 경로(신규 버전 C, 원본 보존)로 유도.
    // 미확정(PENDING) 결과 재입력도 허용(아직 확정 전).
    if (!dto.rerun) {
      const existingFinal = await this.prisma.result.findFirst({
        where: { specimenNo: dto.specimenNo, testCode: dto.testCode, verifyState: { in: ['AUTO', 'VERIFIED'] } },
        orderBy: { reportedDt: 'desc' },
      });
      if (existingFinal) {
        throw new ConflictException(
          `이미 확정된 결과가 있습니다(${dto.testCode} @ ${dto.specimenNo}, ${existingFinal.resultId}). ` +
            `재입력 대신 정정(POST /results/${existingFinal.resultId}/correct) 또는 재검(rerun=true)을 사용하세요.`,
        );
      }
    }

    const patient = specimen.order.patient;
    const age = this.calcAge(patient.birthDate);
    // 희석배수 적용 — 입력값(원 판독)×배수 = 참값. 이후 평가·저장은 참값 기준.
    if (dto.dilutionFactor && dto.dilutionFactor > 1 && isNumeric(dto.value)) {
      // ★부동소수 오차가 그대로 환자 결과값이 되지 않도록 유효자릿수를 맞춘다.
      //   ("0.1" × 3 → "0.30000000000000004"가 판정 근거·보고서 출력·FHIR 값이 됐다)
      //   원본 값의 소수 자릿수를 유지한다(희석은 배수 곱이므로 정밀도가 늘어날 이유가 없다).
      const decimals = (dto.value.split('.')[1] ?? '').length;
      const scaled = Number(dto.value) * dto.dilutionFactor;
      dto.value = decimals > 0 ? String(Number(scaled.toFixed(decimals))) : String(scaled);
    }
    const numeric = isNumeric(dto.value);

    // 참고치 매칭 → 판정
    let flag: ResultFlag | null = null;
    let rangeConfigured = false; // 수치 결과인데 참고치가 없으면 자동검증 금지(패닉 미탐지 방지)
    let panicUnknown = false; // 이상치(H/L)인데 해당 방향 위험치 경계 미설정 → 위험 여부 불명(자동확정 금지)
    if (numeric) {
      const ranges = await this.prisma.referenceRange.findMany({
        where: { testCode: dto.testCode },
      });
      const rr = pickReferenceRange(
        ranges.map((r): RefRange => ({
          sex: r.sex,
          ageMin: r.ageMin,
          ageMax: r.ageMax,
          low: r.low,
          high: r.high,
          panicLow: r.panicLow,
          panicHigh: r.panicHigh,
        })),
        (patient.sex as Sex | null) ?? null,
        age,
      );
      if (rr) {
        flag = determineFlag(Number(dto.value), rr);
        // 참고치 행이 매칭돼도 정상/위험 경계가 하나도 없으면 '참고치 없음'과 같다(빈 행 자동 정상확정 방지·R2)
        rangeConfigured = [rr.low, rr.high, rr.panicLow, rr.panicHigh].some((v) => v != null);
        // 이상치인데 그 방향 위험치 경계가 없으면 치명 여부를 확정할 수 없다 → 사람 검토 강제(무통보 전송 방지·R1)
        panicUnknown = (flag === 'H' && rr.panicHigh == null) || (flag === 'L' && rr.panicLow == null);
      }
    }

    // 델타 체크 — 동일 환자·검사 직전 확정 결과 대비 급변 시 자동검증 차단.
    // B5: 검사별 %/절대 한계·look-back 창(deltaWindowDays) 적용(전역 하드코딩 대체).
    let delta = { hasPrev: false, prev: null as number | null, absDelta: null as number | null, pctDelta: null as number | null, exceeded: false };
    if (numeric) {
      const windowFrom = test.deltaWindowDays && test.deltaWindowDays > 0
        ? new Date(Date.now() - test.deltaWindowDays * 86400_000)
        : null;
      const prevResult = await this.prisma.result.findFirst({
        where: {
          testCode: dto.testCode,
          specimen: { order: { patientId: patient.patientId } },
          verifyState: { in: [...FINALIZED_VERIFY_STATES] },
          ...(windowFrom ? { reportedDt: { gte: windowFrom } } : {}),
        },
        orderBy: { reportedDt: 'desc' }, // 최신 확정결과(랜덤 ID라 ID 정렬 불가)
      });
      const prevNum = prevResult && isNumeric(prevResult.value) ? Number(prevResult.value) : null;
      delta = checkDelta(prevNum, Number(dto.value), { pctLimit: test.deltaPctLimit ?? 50, absLimit: test.deltaAbsLimit ?? undefined });
    }

    // QC 연동 — 당일 해당 검사(가능하면 산출 장비) QC가 FAIL이면 자동검증 차단
    const qcOk = await this.isQcOk(dto.testCode, dto.instrument);
    const critical = flag != null && isCritical(flag);
    // 수치인데 참고치 미설정이면 판정·패닉탐지 불가 → 자동검증 차단하고 수동검증 보류
    const noRange = numeric && !rangeConfigured;
    // B5: 검사별 자동검증 비활성(test.autoVerify=false)이면 항상 수동검증(MANUAL_POLICY).
    const autoDisabled = test.autoVerify === false;
    // R5: 입력 단위가 마스터 단위와 다르면 값 크기가 참고치(마스터 단위 기준)와 어긋나 오판 가능 → 자동확정 금지.
    //   표기 차이 오탐 최소화 위해 소문자·공백제거 정규화 후 비교(둘 다 있을 때만).
    const normU = (u?: string | null) => (u ?? '').toLowerCase().replace(/\s+/g, '');
    const unitMismatch = numeric && !!dto.unit && !!test.unitUcum && normU(dto.unit) !== normU(test.unitUcum);
    const auto = !opts?.forceHold && !autoDisabled && !noRange && !panicUnknown && !unitMismatch && isAutoVerifiable({ numeric, flag: flag ?? 'N', deltaExceeded: delta.exceeded, qcOk });
    // 기존 우선순위 유지(POLICY→NO_RANGE→PANIC_UNSET→자연사유). forceHold는 **아무 사유도 없을 때만** 쓰인다
    // — 위험치·델타가 걸린 위탁결과는 워크리스트에서 그 사유로 뜨는 게 맞다.
    const holdReason: HoldReason | null = auto
      ? null
      : autoDisabled
        ? 'POLICY'
        : noRange
          ? 'NO_RANGE'
          : panicUnknown
            ? 'PANIC_UNSET'
            : unitMismatch
              ? 'UNIT_MISMATCH' // 단위 불일치면 flag 자체가 불신 — 사람이 단위 정합 후 재판정
              : (holdReasonFor({ numeric, critical, deltaExceeded: delta.exceeded, qcOk }) ?? opts?.forceHold ?? null);

    // ★재검(rerun)은 기존 최신 버전 + 1로 만든다(정정과 동일 규칙).
    //   이전에는 rerun도 version 1이라 원본과 동률이었고, 최신 선택이 `version >`뿐이라
    //   원본이 남고 재검값이 가려졌다(P1-1). 희석 입력이 자동 rerun이라 흔하게 발생했다.
    let version = 1;
    if (dto.rerun) {
      const prevMax = await this.prisma.result.findFirst({
        where: { specimenNo: dto.specimenNo, testCode: dto.testCode },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      version = (prevMax?.version ?? 0) + 1;
    }

    const resultId = await this.generateId('R');
    const result = await this.prisma.result.create({
      data: {
        resultId,
        specimenNo: dto.specimenNo,
        testCode: dto.testCode,
        value: dto.value,
        unit: dto.unit ?? null,
        flag: flag ?? undefined,
        status: auto ? 'F' : 'P',
        verifyState: auto ? 'AUTO' : 'PENDING',
        version,
        holdReason: holdReason ?? undefined,
        source: dto.source ?? 'MANUAL',
        enteredBy: dto.enteredBy ?? null,
        instrument: dto.instrument ?? null,
        sourceDocRef: dto.sourceDocRef ?? null,
        dilutionFactor: dto.dilutionFactor && dto.dilutionFactor > 1 ? dto.dilutionFactor : null,
        rerun: dto.rerun ?? false,
        comment: dto.comment ?? null,
        interpretation: dto.interpretation ?? null,
        verifier: auto ? (dto.verifier ?? null) : null,
        reportedDt: auto ? new Date() : null,
      },
    });

    // 위험치 → 통보 생성(확인 대기) + 실통보 채널 디스패치 이벤트
    let criticalNotify = null;
    if (critical) {
      criticalNotify = await this.prisma.criticalNotify.create({
        data: {
          notifyId: await this.generateId('CN'),
          resultId: result.resultId,
          notifyTarget: '담당의',
          notifyMethod: '유선',
          dispatchStatus: 'PENDING',
        },
      });
      this.events.emit('critical.created', { notifyId: criticalNotify.notifyId });
    }

    // 확정(F) 결과: HIS 발신 이벤트 + 리플렉스 자동오더 (자동검증 통과분).
    // 수동검증 대기(P/PENDING)는 확정 시점(verifyResult)에 동일 처리.
    let reflex: { added: string[]; labels: string[] } = { added: [], labels: [] };
    if (auto) {
      this.events.emit('result.finalized', { specimenNo: dto.specimenNo });
      reflex = await this.applyReflex(result.resultId);
      await this.markItemReported(dto.specimenNo, dto.testCode);
      await this.deriveResults(dto.specimenNo).catch(() => []); // 계산검사 자동 산출
    }

    // D1 HIL 간섭 — 검체 용혈·황달·지질혈이 이 analyte에 영향 시 경고(하드블록 아님, 재채취는 사람 판단).
    const interference = hilInterference(dto.testCode, { hemolysis: specimen.hemolysis as never, icterus: specimen.icterus as never, lipemia: specimen.lipemia as never });
    return {
      result,
      evaluation: {
        numeric,
        flag,
        autoVerified: auto,
        critical,
        criticalNotifyId: criticalNotify?.notifyId ?? null,
        holdReason,
        delta,
        reflexAdded: reflex.added,
        interference,
      },
    };
  }

  /** D1 검체 품질 HIL 등급 기록(용혈·황달·지질혈: NONE/1+/2+/3+). */
  async recordHil(specimenNo: string, dto: { hemolysis?: string; icterus?: string; lipemia?: string }) {
    const spec = await this.prisma.specimen.findUnique({ where: { specimenNo } });
    if (!spec) throw new NotFoundException(`검체 없음: ${specimenNo}`);
    const GRADES = ['NONE', '1+', '2+', '3+'];
    for (const [k, v] of Object.entries(dto)) if (v && !GRADES.includes(v)) throw new BadRequestException(`${k} 등급은 ${GRADES.join('/')}: ${v}`);
    return this.prisma.specimen.update({
      where: { specimenNo },
      data: {
        ...(dto.hemolysis !== undefined ? { hemolysis: dto.hemolysis } : {}),
        ...(dto.icterus !== undefined ? { icterus: dto.icterus } : {}),
        ...(dto.lipemia !== undefined ? { lipemia: dto.lipemia } : {}),
      },
    });
  }

  /**
   * 결과 근거 종합 번들 — 검증 판단 근거를 한 곳에(적용 참고치·선택 근거·델타·패닉 임계·QC·HIL·추세).
   * 보류 사유 코드(DELTA/QC 등)만으론 "무엇과 비교해 얼마나 벗어났는지"를 알 수 없어, 수치 근거로 풀어준다.
   * 판독 검토용이자 향후 원내 LLM(RAG) 컨텍스트. 외부 전송 없음.
   */
  async evidenceContext(resultId: string) {
    const r = await this.prisma.result.findUnique({
      where: { resultId },
      include: { specimen: { include: { order: { include: { patient: true } } } } },
    });
    if (!r) throw new NotFoundException(`결과 없음: ${resultId}`);

    const patient = r.specimen?.order?.patient ?? null;
    const age = this.calcAge(patient?.birthDate ?? null);
    const ranges = await this.pickRangesBatch([r.testCode], patient?.sex ?? null, age);
    const refRange = ranges.get(r.testCode) ?? null;
    const test = await this.prisma.testMaster.findUnique({ where: { testCode: r.testCode }, select: { name: true } });

    // 델타 — 같은 환자·검사의 직전 확정 결과와 비교(현재 결과 제외)
    let delta: { hasPrev: boolean; prev: number | null; absDelta: number | null; pctDelta: number | null; exceeded: boolean; prevReportedDt: string | null } | null = null;
    let trend: { value: string | null; flag: string | null; reportedDt: string | null }[] = [];
    if (patient?.patientId) {
      const priors = await this.prisma.result.findMany({
        where: {
          resultId: { not: resultId }, testCode: r.testCode,
          verifyState: { in: [...FINALIZED_VERIFY_STATES] },
          specimen: { order: { patientId: patient.patientId } },
        },
        orderBy: { reportedDt: 'desc' }, take: 6,
        select: { value: true, flag: true, reportedDt: true },
      });
      trend = priors.map((p) => ({ value: p.value, flag: p.flag, reportedDt: p.reportedDt ? p.reportedDt.toISOString().slice(0, 16).replace('T', ' ') : null }));
      const prevNum = priors.length && isNumeric(priors[0].value) ? Number(priors[0].value) : null;
      const curNum = isNumeric(r.value) ? Number(r.value) : null;
      if (curNum != null) {
        const d = checkDelta(prevNum, curNum);
        delta = { ...d, prevReportedDt: trend[0]?.reportedDt ?? null };
      }
    }

    // QC 상태 — 수치결과일 때만 의미(비수치는 QC 게이트 대상 아님)
    const qcOk = isNumeric(r.value) ? await this.isQcOk(r.testCode, r.instrument) : null;
    const spec = r.specimen;

    return buildResultEvidenceContext({
      resultId: r.resultId,
      testCode: r.testCode,
      testName: test?.name ?? null,
      value: r.value,
      unit: r.unit,
      flag: r.flag,
      verifyState: r.verifyState,
      holdReason: r.holdReason,
      source: r.source,
      instrument: r.instrument,
      dilutionFactor: r.dilutionFactor,
      rerun: r.rerun,
      comment: r.comment,
      patientSex: patient?.sex ?? null,
      patientAge: age,
      refRange,
      delta,
      qcOk,
      hil: spec ? { hemolysis: spec.hemolysis, icterus: spec.icterus, lipemia: spec.lipemia } : null,
      // 이 검사에 대한 HIL 간섭 — "용혈 2+가 이 검사 값을 왜곡하는가"까지 근거로(등급만으론 판단 불가)
      hilInterference: spec ? hilInterference(r.testCode, { hemolysis: spec.hemolysis as never, icterus: spec.icterus as never, lipemia: spec.lipemia as never }) : null,
      trend,
    });
  }

  /**
   * 2차 검증 확정 — 수동검증 대기(PENDING) 결과를 검증의가 확정.
   * PENDING → VERIFIED, status P → F. 확정 시 HIS 발신 + 리플렉스 자동오더.
   * (근거: 기획 22 §6-1, 08 F-V2)
   */
  async verifyResult(resultId: string, dto: VerifyResultDto, opts?: { deferDerive?: boolean }) {
    const r = await this.prisma.result.findUnique({ where: { resultId } });
    if (!r) throw new NotFoundException(`결과 없음: ${resultId}`);
    if (r.verifyState !== 'PENDING') {
      throw new BadRequestException(`검증 대상이 아닙니다(현재 ${r.verifyState}): ${resultId}`);
    }
    // 직무분리(2인 검증) — 입력자는 자신의 결과를 검증할 수 없다. enteredBy·verifier 모두 JWT 서버결속이라
    //   신뢰 가능(수동 보류 결과의 2차 검토를 자가검증으로 우회하는 것 차단, CAP/ISO 15189).
    if (r.enteredBy && dto.verifier && r.enteredBy === dto.verifier) {
      throw new BadRequestException('직무분리: 결과 입력자는 자신의 결과를 검증할 수 없습니다 — 다른 검증자가 필요합니다');
    }
    const updated = await this.prisma.result.update({
      where: { resultId },
      data: {
        status: 'F',
        verifyState: 'VERIFIED',
        holdReason: null,
        verifier: dto.verifier,
        // 코멘트는 검증 시 제공분만 갱신(미제공이면 기존 유지)
        ...(dto.comment != null ? { comment: dto.comment } : {}),
        ...(dto.interpretation != null ? { interpretation: dto.interpretation } : {}),
        reportedDt: new Date(),
      },
    });
    this.events.emit('result.finalized', { specimenNo: updated.specimenNo });
    const reflex = await this.applyReflex(resultId);
    await this.markItemReported(updated.specimenNo, updated.testCode);
    // 파생검사는 검체 단위 — 일괄 검증 시 검체별 1회로 통합하기 위해 deferDerive면 호출측이 처리
    if (!opts?.deferDerive) await this.deriveResults(updated.specimenNo).catch(() => []);
    return { result: updated, reflexAdded: reflex.added, specimenNo: updated.specimenNo };
  }

  /** 2차 검증 일괄 확정 */
  async verifyBatch(dto: VerifyBatchDto) {
    const verified: string[] = [];
    const skipped: { resultId: string; reason: string }[] = [];
    const reflexAdded: string[] = []; // 일괄 확정으로 추가된 리플렉스 오더(검체채취 누락 방지 표시)
    const specimens = new Set<string>(); // 파생 재계산 중복 제거(검체 단위 1회)
    for (const id of dto.resultIds) {
      try {
        const r = await this.verifyResult(id, { verifier: dto.verifier }, { deferDerive: true });
        verified.push(id);
        specimens.add(r.specimenNo);
        if (r.reflexAdded?.length) reflexAdded.push(...r.reflexAdded);
      } catch (e) {
        skipped.push({ resultId: id, reason: e instanceof Error ? e.message : '실패' });
      }
    }
    // 파생검사 재계산은 검체 단위 1회씩만(동일 검체 다항목 일괄 시 중복 제거)
    for (const sp of specimens) await this.deriveResults(sp).catch(() => []);
    return { verified, skipped, count: verified.length, reflexAdded };
  }

  /**
   * 검증 대기 워크리스트 — 수동검증(PENDING) 결과를 사유 우선순위로 정렬.
   * 위험치 → 장비오류 → QC → 델타 → 비수치 순.
   */
  async verificationWorklist() {
    const rows = await this.prisma.result.findMany({
      where: { verifyState: 'PENDING' },
      include: { test: true, specimen: { include: { order: { include: { patient: true } } } } },
      orderBy: { reportedDt: 'asc' },
      take: 300, // 백로그 폭주 시 단일 대용량 응답 방지(오래된 순 우선)
    });
    // 델타 보류 행의 직전 확정값 조회 — 행별 순차(최대 300회)가 아니라 10개 단위 병렬.
    // (환자×검사별 최신 1건이라 단일 쿼리 배치가 안 되는 자리 — lab_order(patientId) 인덱스로 건당 비용은 낮다)
    const deltaRows = rows.filter((r) => r.holdReason === 'DELTA');
    const prevBy = new Map<string, { value: string | null } | null>();
    for (let i = 0; i < deltaRows.length; i += 10) {
      await Promise.all(deltaRows.slice(i, i + 10).map(async (r) => {
        const prev = await this.prisma.result.findFirst({
          where: {
            testCode: r.testCode,
            specimen: { order: { patientId: r.specimen.order.patient.patientId } },
            verifyState: { in: [...FINALIZED_VERIFY_STATES] },
          },
          orderBy: { reportedDt: 'desc' },
          select: { value: true },
        });
        prevBy.set(r.resultId, prev);
      }));
    }
    const out = [];
    for (const r of rows) {
      // 델타 보류 행: 직전 확정값·변화율 상세 제공(검증 판단 보조)
      let prevValue: string | null = null;
      let pctDelta: number | null = null;
      if (r.holdReason === 'DELTA') {
        const prev = prevBy.get(r.resultId);
        if (prev && isNumeric(prev.value) && isNumeric(r.value)) {
          prevValue = prev.value;
          const d = checkDelta(Number(prev.value), Number(r.value));
          pctDelta = d.pctDelta;
        }
      }
      out.push({
        resultId: r.resultId,
        specimenNo: r.specimenNo,
        testCode: r.testCode,
        testName: r.test.name,
        value: r.value,
        unit: r.unit,
        flag: r.flag,
        holdReason: r.holdReason as HoldReason | null,
        prevValue,
        pctDelta,
        patientId: r.specimen.order.patient.patientId,
        patientName: r.specimen.order.patient.name,
      });
    }
    return out.sort((a, b) => holdPriority(a.holdReason) - holdPriority(b.holdReason) || a.resultId.localeCompare(b.resultId));
  }

  /**
   * 리플렉스 자동오더 — 결과값이 규칙을 충족하면 후속검사를 동일 오더에 추가.
   * 이미 존재하는 검사항목은 건너뜀(멱등). 미등록 검사코드는 조용히 무시.
   */
  private async applyReflex(resultId: string): Promise<{ added: string[]; labels: string[] }> {
    const r = await this.prisma.result.findUnique({
      where: { resultId },
      include: { specimen: { include: { order: true } } },
    });
    if (!r) return { added: [], labels: [] };
    const value = isNumeric(r.value) ? Number(r.value) : null;
    const flag = (r.flag as ResultFlag) ?? 'N';
    // 승인(ACTIVE)된 Reflex 프로토콜만 로드해 평가 — 미승인 규칙은 원천적으로 실행 불가(기획 27)
    const protocols = await this.reflex.activeFor(r.testCode);
    const added: string[] = [];
    const labels: string[] = [];
    const orderId = r.specimen.order.orderId;
    for (const p of protocols) {
      if (!reflexMatches({ operator: p.operator, threshold: p.threshold, thresholdHigh: p.thresholdHigh, flag: p.flag }, value, flag)) continue;
      for (const tc of p.addTestCodes.split(',').map((s) => s.trim()).filter(Boolean)) {
        const test = await this.prisma.testMaster.findUnique({ where: { testCode: tc } });
        if (!test) continue; // 미등록 검사코드 무시
        const exists = await this.prisma.orderItem.findFirst({ where: { orderId, testCode: tc } });
        if (exists) continue; // 멱등
        try {
          await this.prisma.orderItem.create({
            data: { orderItemId: genId('OIR'), orderId, testCode: tc },
          });
        } catch (e) {
          if (isUniqueViolation(e)) continue; // 동시 리플렉스 경합 — 이미 추가됨(오더당 검사 유일)
          throw e;
        }
        added.push(tc);
        labels.push(`Reflex: ${p.name}`);
        // QI 실행 기록(리포트용)
        await this.prisma.reflexExecution.create({
          data: {
            execId: genId('RXE'), protocolId: p.protocolId, protocolName: p.name,
            orderId, addTestCode: tc, patientId: r.specimen.order.patientId,
            triggerValue: r.value ?? null, outboundMcid: `RX-${orderId}-${tc}`,
          },
        }).catch((e) => this.logger.warn(`reflex 실행기록 저장 실패(${p.name}/${tc}, order ${orderId}): ${e instanceof Error ? e.message : e}`));
        // 양방향 오더(기획 27 §8): 추가검사를 HIS 신규 오더로 구성·발신(미설정 시 스테이징)
        this.events.emit('reflex.ordered', {
          orderId, patientId: r.specimen.order.patientId, testCode: tc,
          protocolId: p.protocolId, protocolName: p.name,
        });
      }
    }
    return { added, labels };
  }

  /**
   * 결과 정정(Corrected) — 원본 보존, 신규 버전(status=C) 생성. (07 §7)
   */
  async correctResult(resultId: string, dto: CorrectResultDto) {
    const prev = await this.prisma.result.findUnique({
      where: { resultId },
      include: { specimen: { include: { order: { include: { patient: true } } } } },
    });
    if (!prev) throw new NotFoundException(`결과 없음: ${resultId}`);
    // 최신 버전만 정정 — 구버전을 정정하면 version+1이 현재 최신보다 낮아 pickLatest에 가려 보고서·누적에 안 뜬다.
    const newer = await this.prisma.result.findFirst({
      where: { specimenNo: prev.specimenNo, testCode: prev.testCode, version: { gt: prev.version } },
      select: { resultId: true },
    });
    if (newer) throw new BadRequestException('최신 버전 결과만 정정할 수 있습니다(이미 더 최신 버전이 있습니다)');
    const patient = prev.specimen?.order?.patient ?? null;

    // 정정값 재평가 — 판정·패닉을 이전 값에서 복사하지 않고 재계산(정정으로 위험치가 된 경우 통보 누락 방지)
    const numeric = isNumeric(dto.value);
    let flag: ResultFlag | null = null;
    if (numeric) {
      const ranges = await this.prisma.referenceRange.findMany({ where: { testCode: prev.testCode } });
      const rr = pickReferenceRange(
        ranges.map((r): RefRange => ({ sex: r.sex, ageMin: r.ageMin, ageMax: r.ageMax, low: r.low, high: r.high, panicLow: r.panicLow, panicHigh: r.panicHigh })),
        (patient?.sex as Sex | null) ?? null,
        this.calcAge(patient?.birthDate ?? null),
      );
      if (rr) flag = determineFlag(Number(dto.value), rr);
    }
    const critical = flag != null && isCritical(flag);

    const newId = await this.generateId('R');
    const corrected = await this.prisma.result.create({
      data: {
        resultId: newId,
        specimenNo: prev.specimenNo,
        testCode: prev.testCode,
        value: dto.value,
        unit: prev.unit,
        flag: flag ?? undefined,
        status: 'C',
        verifyState: 'VERIFIED',
        version: prev.version + 1,
        verifier: dto.verifier ?? null,
        correctedBy: dto.verifier ?? null,
        correctionReason: dto.reason, // 사유 영구 저장(CAP/ISO 15189 정정 추적성)
        supersedesId: prev.resultId,
        reportedDt: new Date(),
      },
    });

    // 정정으로 위험치가 된 경우 폐루프 통보 재생성(누락 방지)
    let criticalNotify = null;
    if (critical) {
      criticalNotify = await this.prisma.criticalNotify.create({
        data: { notifyId: await this.generateId('CN'), resultId: corrected.resultId, notifyTarget: '담당의', notifyMethod: '유선', dispatchStatus: 'PENDING' },
      });
      this.events.emit('critical.created', { notifyId: criticalNotify.notifyId });
    }
    // 정정값 HIS 재발신 + 보고(이전 값이 처방계에 남지 않도록)
    this.events.emit('result.finalized', { specimenNo: prev.specimenNo });
    await this.markItemReported(prev.specimenNo, prev.testCode);

    return { corrected, previous: resultId, version: corrected.version, reason: dto.reason, critical, criticalNotifyId: criticalNotify?.notifyId ?? null };
  }

  /** 위험치 통보 확인(폐루프 완료) */
  async ackCritical(notifyId: string, dto: AckCriticalDto) {
    const cn = await this.prisma.criticalNotify.findUnique({ where: { notifyId } });
    if (!cn) throw new NotFoundException(`통보를 찾을 수 없습니다: ${notifyId}`);
    return this.prisma.criticalNotify.update({
      where: { notifyId },
      data: {
        notifiedDt: cn.notifiedDt ?? new Date(),
        ackDt: new Date(),
        ackBy: dto.ackBy,
        readbackBy: dto.readbackBy ?? null,
        readbackNote: dto.readbackNote ?? null,
      },
    });
  }

  /** 위험치 통보 실채널 재발송(수동) */
  async dispatchCritical(notifyId: string) {
    const cn = await this.prisma.criticalNotify.findUnique({ where: { notifyId } });
    if (!cn) throw new NotFoundException(`통보를 찾을 수 없습니다: ${notifyId}`);
    return this.notifier.dispatch(notifyId);
  }

  /** 미확인 위험치 통보 목록(대시보드) */
  async pendingCriticals() {
    return this.prisma.criticalNotify.findMany({
      where: { ackDt: null },
      // 데이터 최소화: 환자는 식별·표시에 필요한 필드만(Patient 행 전체 노출 방지).
      include: {
        result: {
          include: {
            test: true,
            specimen: { include: { order: { include: { patient: { select: { patientId: true, name: true } } } } } },
          },
        },
      },
    });
  }

  /**
   * 결과 확정 시 해당 오더항목을 REPORTED로 — 부분보고 추적.
   * 활성(비취소) 항목이 전부 REPORTED가 되면 **오더도 REPORTED로 종결**한다.
   * 이전에는 오더가 IN_PROCESS에 머물러 종결 상태(REPORTED)가 사문화됐고,
   * 상태 필터·관리 집계에서 '보고' 오더가 항상 0건이었다(재검토 P2).
   * HOLD/CANCELLED는 덮지 않는다(보류·취소 워크플로 우선). add-on 추가 시 IN_PROCESS로 복귀(기존 로직).
   */
  private async markItemReported(specimenNo: string, testCode: string): Promise<void> {
    const specimen = await this.prisma.specimen.findUnique({ where: { specimenNo } });
    if (!specimen) return;
    await this.prisma.orderItem.updateMany({
      where: { orderId: specimen.orderId, testCode, status: { not: 'CANCELLED' } },
      data: { status: 'REPORTED' },
    });
    const [pending, reported] = await Promise.all([
      this.prisma.orderItem.count({ where: { orderId: specimen.orderId, status: { notIn: ['CANCELLED', 'REPORTED'] } } }),
      this.prisma.orderItem.count({ where: { orderId: specimen.orderId, status: 'REPORTED' } }),
    ]);
    if (pending === 0 && reported > 0) {
      await this.prisma.labOrder.updateMany({
        where: { orderId: specimen.orderId, status: { in: ['RECEIVED', 'IN_PROCESS'] } },
        data: { status: 'REPORTED' },
      });
    }
  }

  /**
   * 당일 해당 검사 QC 통과 여부 — (QC물질·장비)별 최신 verdict 중 하나라도 FAIL이면 false(자동검증 차단).
   * 단일 최신 1건만 보면 다른 물질/장비의 PASS가 앞선 FAIL을 가려버리므로, 관리군별 미해결 FAIL을 각각 확인.
   */
  private async isQcOk(testCode: string, instrument?: string | null): Promise<boolean> {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const rows = await this.prisma.qcResult.findMany({
      // 산출 장비를 알면 그 장비의 QC만(다른 장비 PASS가 이 장비 FAIL을 가리지 않도록). 모르면 전체.
      where: { testCode, measuredDt: { gte: start }, ...(instrument ? { instrument } : {}) },
      orderBy: { measuredDt: 'desc' },
    });
    // (qcCode|instrument) 관리군별 최신 verdict 추출
    const latestByGroup = new Map<string, string | null>();
    for (const r of rows) {
      const key = `${r.qcCode}|${r.instrument ?? ''}`;
      if (!latestByGroup.has(key)) latestByGroup.set(key, r.verdict); // rows가 desc라 첫 등장이 최신
    }
    // 하나의 관리군이라도 최신이 FAIL이면 차단
    for (const v of latestByGroup.values()) if (v === 'FAIL') return false;
    return true;
  }

  /**
   * 계산검사 자동 산출 — 검체 확정 수치결과로 파생검사(eGFR·LDL·anion gap·보정칼슘) 계산·생성.
   * 출력 검사가 마스터에 등록돼 있을 때만. 이미 있으면 최신 입력으로 값 갱신(오더에 없어도 결과로 부착).
   */
  async deriveResults(specimenNo: string): Promise<string[]> {
    const specimen = await this.prisma.specimen.findUnique({
      where: { specimenNo },
      include: { order: { include: { patient: true } }, results: true },
    });
    if (!specimen) return [];

    // 파생검사 입력도 검사별 최신 확정값만(P1-1 tie 안전). 시간순 정렬 후 축약.
    const finalizedInputs = specimen.results
      .filter((r) => ['F', 'C'].includes(r.status) && isFinalized(r.verifyState) && r.source !== 'CALCULATED')
      .sort((a, b) => (a.reportedDt?.getTime() ?? 0) - (b.reportedDt?.getTime() ?? 0));
    const latest = pickLatestByKey(finalizedInputs, (r) => r.testCode);
    const values: Record<string, number> = {};
    for (const [code, r] of latest) { const n = Number(r.value); if (!Number.isNaN(n)) values[code] = n; }

    const ctx = { age: this.calcAge(specimen.order.patient.birthDate), sex: specimen.order.patient.sex };
    const derived = computeDerived(values, ctx);
    const added: string[] = [];
    // 파생검사 마스터·참고치를 in 1회씩 선로드(파생별 반복 조회 N+1 제거)
    const derivedCodes = derived.map((d) => d.testCode);
    const masterRows = await this.prisma.testMaster.findMany({ where: { testCode: { in: derivedCodes } }, select: { testCode: true, autoVerify: true } });
    const masters = new Map(masterRows.map((m) => [m.testCode, m]));
    const rangeMap = await this.pickRangesBatch(derivedCodes, ctx.sex, ctx.age);
    for (const d of derived) {
      const master = masters.get(d.testCode);
      if (!master) continue; // 마스터 미등록 파생검사는 건너뜀
      // 파생값도 참고치로 판정(위험치 파생값 미표시 방지 — 환자안전)
      const rr = rangeMap.get(d.testCode) ?? null;
      const flag = isNumeric(String(d.value)) && rr ? determineFlag(Number(d.value), rr) : null;
      const critical = flag != null && isCritical(flag);

      const exists = specimen.results.find((r) => r.testCode === d.testCode && r.source === 'CALCULATED');
      if (exists) {
        if (exists.value !== String(d.value) || exists.flag !== (flag ?? null)) {
          // 재계산으로 위험치로 **바뀐** 경우 — 값만 조용히 덮으면 위험치가 통보 없이 확정 상태로 남는다.
          const becameCritical = critical && !(exists.flag != null && isCritical(exists.flag as ResultFlag));
          await this.prisma.result.update({
            where: { resultId: exists.resultId },
            data: {
              value: String(d.value), flag: flag ?? null, reportedDt: new Date(),
              // 자동확정(AUTO) 상태였다면 수동검증으로 되돌린다. 사람이 확정(VERIFIED)한 값은 상태 유지(통보만).
              ...(becameCritical && exists.verifyState === 'AUTO'
                ? { status: 'P', verifyState: 'PENDING', holdReason: 'CRITICAL', reportedDt: null }
                : {}),
            },
          });
          if (becameCritical) {
            const cn = await this.prisma.criticalNotify.create({
              data: { notifyId: await this.generateId('CN'), resultId: exists.resultId, notifyTarget: '담당의', notifyMethod: '유선', dispatchStatus: 'PENDING' },
            });
            this.events.emit('critical.created', { notifyId: cn.notifyId });
          }
        }
        continue;
      }

      // ★안전 게이트를 submitResult와 정합시킨다(Q3) — 이전에는 위험치만 보고
      //   QC FAIL 중이어도, 참고치가 없어도, 검사별 자동검증 OFF여도 파생값이 자동확정됐다.
      const qcOk = await this.isQcOk(d.testCode);
      const autoDisabled = master.autoVerify === false;
      // submitResult와 정합: 빈 참고치 행(경계 전무)은 참고치 없음, 이상치인데 위험치 경계 없으면 자동확정 금지
      const noRange = !rr || ![rr.low, rr.high, rr.panicLow, rr.panicHigh].some((v) => v != null);
      const panicUnknown = !!rr && ((flag === 'H' && rr.panicHigh == null) || (flag === 'L' && rr.panicLow == null));
      const auto = !autoDisabled && !noRange && !panicUnknown && isAutoVerifiable({ numeric: true, flag: flag ?? 'N', deltaExceeded: false, qcOk });
      const holdReason: HoldReason | null = auto
        ? null
        : autoDisabled
          ? 'POLICY'
          : noRange
            ? 'NO_RANGE'
            : panicUnknown
              ? 'PANIC_UNSET'
              : holdReasonFor({ numeric: true, critical, deltaExceeded: false, qcOk });
      const created = await this.prisma.result.create({
        data: {
          resultId: await this.generateId('R'),
          specimenNo, testCode: d.testCode, value: String(d.value), unit: d.unit,
          flag: flag ?? undefined,
          status: auto ? 'F' : 'P',
          verifyState: auto ? 'AUTO' : 'PENDING',
          holdReason: holdReason ?? undefined,
          source: 'CALCULATED', enteredBy: 'CALC',
          reportedDt: auto ? new Date() : null,
        },
      });
      if (critical) {
        const cn = await this.prisma.criticalNotify.create({
          data: { notifyId: await this.generateId('CN'), resultId: created.resultId, notifyTarget: '담당의', notifyMethod: '유선', dispatchStatus: 'PENDING' },
        });
        this.events.emit('critical.created', { notifyId: cn.notifyId });
      }
      added.push(d.testCode);
    }
    return added;
  }

  /**
   * 참고치 일괄 선택 — 여러 검사의 참고치를 `in` 1회 조회 후 in-memory 매칭(N+1 제거).
   * 보고서·누적처럼 검사 수(T)만큼 반복 조회하던 것을 상수 쿼리로 축소.
   */
  private async pickRangesBatch(testCodes: string[], sex: string | null, age: number | null): Promise<Map<string, RefRange | null>> {
    const codes = [...new Set(testCodes)];
    const rows = codes.length ? await this.prisma.referenceRange.findMany({ where: { testCode: { in: codes } } }) : [];
    const byCode = new Map<string, RefRange[]>();
    for (const r of rows) {
      const list = byCode.get(r.testCode) ?? [];
      list.push({ sex: r.sex, ageMin: r.ageMin, ageMax: r.ageMax, low: r.low, high: r.high, panicLow: r.panicLow, panicHigh: r.panicHigh });
      byCode.set(r.testCode, list);
    }
    const out = new Map<string, RefRange | null>();
    for (const code of codes) out.set(code, pickReferenceRange(byCode.get(code) ?? [], (sex as Sex | null) ?? null, age));
    return out;
  }

  /** 만 나이 — 도메인 정본(calcAge) 위임. 결과입력 프리뷰·판정·보고서가 같은 나이를 쓰게 공유. */
  private calcAge(birthDate: string | null): number | null {
    return calcAge(birthDate);
  }

  private async generateId(prefix: string): Promise<string> {
    return genId(prefix); // 충돌 내성(count 기반 제거)
  }

  // ============================================================
  // 검사결과 첨부 문서(PDF·이미지) — 문서 기반 결과 수집 지원
  // ============================================================
  static readonly ATTACH_MAX_BYTES = 20 * 1024 * 1024; // 20MB
  static readonly ATTACH_MIME = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

  /** 소유자 검증(검체 또는 병리 케이스) — 존재 확인 후 저장용 owner 반환. */
  private async resolveAttachOwner(owner: { specimenNo?: string; spNo?: string; genomicOrderId?: string; reactionId?: string; eqaId?: string; reportId?: string }) {
    const base = { specimenNo: null as string | null, spNo: null as string | null, genomicOrderId: null as string | null, reactionId: null as string | null, eqaId: null as string | null, reportId: null as string | null };
    if (owner.specimenNo) {
      const s = await this.prisma.specimen.findUnique({ where: { specimenNo: owner.specimenNo } });
      if (!s) throw new NotFoundException(`검체 없음: ${owner.specimenNo}`);
      return { ...base, specimenNo: owner.specimenNo };
    }
    if (owner.spNo) {
      const c = await this.prisma.pathologyCase.findUnique({ where: { spNo: owner.spNo } });
      if (!c) throw new NotFoundException(`병리 케이스 없음: ${owner.spNo}`);
      return { ...base, spNo: owner.spNo };
    }
    if (owner.genomicOrderId) {
      const g = await this.prisma.genomicOrder.findUnique({ where: { genomicOrderId: owner.genomicOrderId } });
      if (!g) throw new NotFoundException(`유전체 오더 없음: ${owner.genomicOrderId}`);
      return { ...base, genomicOrderId: owner.genomicOrderId };
    }
    if (owner.reactionId) {
      const r = await this.prisma.transfusionReaction.findUnique({ where: { reactionId: owner.reactionId } });
      if (!r) throw new NotFoundException(`수혈 이상반응 없음: ${owner.reactionId}`);
      return { ...base, reactionId: owner.reactionId };
    }
    if (owner.eqaId) {
      const e = await this.prisma.eqaSurvey.findUnique({ where: { surveyId: owner.eqaId } });
      if (!e) throw new NotFoundException(`EQA 서베이 없음: ${owner.eqaId}`);
      return { ...base, eqaId: owner.eqaId };
    }
    if (owner.reportId) {
      const rp = await this.prisma.infectiousReport.findUnique({ where: { reportId: owner.reportId } });
      if (!rp) throw new NotFoundException(`신고 기록 없음: ${owner.reportId}`);
      return { ...base, reportId: owner.reportId };
    }
    throw new BadRequestException('첨부 대상(검체·병리 케이스·유전체 오더·수혈 이상반응·EQA·법정감염병 신고)이 필요합니다');
  }

  async addAttachment(
    owner: { specimenNo?: string; spNo?: string; genomicOrderId?: string; reactionId?: string; eqaId?: string; reportId?: string },
    file: { buffer: Buffer; originalname: string; mimetype: string; size: number } | undefined,
    note: string | undefined,
    userId: string | undefined,
  ) {
    if (!file) throw new BadRequestException('파일이 없습니다');
    const resolved = await this.resolveAttachOwner(owner);
    if (!ResultService.ATTACH_MIME.includes(file.mimetype))
      throw new BadRequestException(`허용되지 않는 형식: ${file.mimetype} (PDF·PNG·JPEG·WEBP만 가능)`);
    if (file.size > ResultService.ATTACH_MAX_BYTES)
      throw new BadRequestException(`파일이 너무 큽니다(최대 20MB): ${(file.size / 1024 / 1024).toFixed(1)}MB`);
    // 파일명 정규화(경로/제어문자 제거)
    const safeName = (file.originalname || 'file').replace(/[/\\\r\n\t]/g, '_').slice(0, 200);
    const rec = await this.prisma.resultAttachment.create({
      data: {
        attachmentId: genId('ATT'),
        specimenNo: resolved.specimenNo,
        spNo: resolved.spNo,
        genomicOrderId: resolved.genomicOrderId,
        reactionId: resolved.reactionId,
        eqaId: resolved.eqaId,
        reportId: resolved.reportId,
        filename: safeName,
        mimeType: file.mimetype,
        sizeBytes: file.size,
        data: new Uint8Array(file.buffer),
        note: note?.slice(0, 300) || null,
        uploadedBy: userId ?? null,
      },
      select: { attachmentId: true, filename: true, mimeType: true, sizeBytes: true, note: true, uploadedBy: true, uploadedDt: true },
    });
    return rec;
  }

  /** 첨부 목록(메타데이터만, 바이너리 제외) — 검체 또는 병리 케이스 단위 */
  async listAttachments(owner: { specimenNo?: string; spNo?: string; genomicOrderId?: string; reactionId?: string; eqaId?: string; reportId?: string }) {
    const where = owner.specimenNo ? { specimenNo: owner.specimenNo }
      : owner.genomicOrderId ? { genomicOrderId: owner.genomicOrderId }
      : owner.reactionId ? { reactionId: owner.reactionId }
      : owner.eqaId ? { eqaId: owner.eqaId }
      : owner.reportId ? { reportId: owner.reportId }
      : { spNo: owner.spNo };
    return this.prisma.resultAttachment.findMany({
      where,
      orderBy: { uploadedDt: 'desc' },
      select: { attachmentId: true, filename: true, mimeType: true, sizeBytes: true, note: true, uploadedBy: true, uploadedDt: true },
    });
  }

  /** 다운로드용 원본(바이너리 포함) */
  /**
   * 첨부 원본 조회. 공용 엔드포인트(attachmentId만 받음)이므로 컨트롤러 가드만으로는
   * 도메인 격리가 되지 않는다 — 레코드의 소유 도메인을 판정해 호출자 역할로 재검증한다.
   */
  async getAttachment(attachmentId: string, roles: string[]) {
    const rec = await this.prisma.resultAttachment.findUnique({ where: { attachmentId } });
    if (!rec) throw new NotFoundException(`첨부 없음: ${attachmentId}`);
    const domain = attachmentDomain(rec);
    if (!canAccessAttachment(domain, roles, 'READ')) {
      throw new ForbiddenException(`이 첨부(${domain})에 대한 조회 권한이 없습니다`);
    }
    return rec;
  }

  async deleteAttachment(attachmentId: string, roles: string[]) {
    const rec = await this.prisma.resultAttachment.findUnique({
      where: { attachmentId },
      select: { attachmentId: true, specimenNo: true, spNo: true, genomicOrderId: true, reactionId: true, eqaId: true },
    });
    if (!rec) throw new NotFoundException(`첨부 없음: ${attachmentId}`);
    const domain = attachmentDomain(rec);
    if (!canAccessAttachment(domain, roles, 'WRITE')) {
      throw new ForbiddenException(`이 첨부(${domain})에 대한 삭제 권한이 없습니다`);
    }
    await this.prisma.resultAttachment.delete({ where: { attachmentId } });
    return { deleted: attachmentId };
  }
}
