/**
 * QcService — qc 도메인 서비스.
 *
 * 주요 진입점: `submitQc()`, `establishLotTarget()`, `getStatus()`, `monthlySummary()`, `recordReview()`, `listReviews()`, `listResults()`
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { evaluateWestgard, crossLevelViolations } from '../../domain/westgard';
import { genId } from '../../common/id.util';
import { QC_REVIEW_VERDICTS, isOneOf } from '../../domain/enums';

interface SubmitQcInput {
  qcCode: string;
  instrument: string;
  testCode: string;
  value: number;
  lot?: string; // D1 QC 로트(미지정=DEFAULT)
}

@Injectable()
export class QcService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * QC 측정값 등록 + Westgard 판정.
   * 목표치(QcTarget) 대비 최근 시퀀스로 다중규칙 평가 → verdict 저장.
   * FAIL 시 해당 항목 결과 확정 차단 신호(Notification) 생성. (07 §8)
   */
  async submitQc(input: SubmitQcInput) {
    const lot = input.lot ?? 'DEFAULT';
    const target = await this.prisma.qcTarget.findUnique({
      where: {
        qcCode_instrument_testCode_lot: {
          qcCode: input.qcCode,
          instrument: input.instrument,
          testCode: input.testCode,
          lot,
        },
      },
    });
    if (!target) throw new BadRequestException(`QC 목표치(QcTarget) 미설정 — 로트 ${lot} (신로트는 크로스오버로 확립 필요)`);

    // 최근 측정값(오래된→최신) + 신규값 — 10x/4-1s 규칙 판정. 로트 경계에서 시퀀스 리셋(같은 로트만).
    const recent = await this.prisma.qcResult.findMany({
      where: { qcCode: input.qcCode, instrument: input.instrument, testCode: input.testCode, lot },
      orderBy: { measuredDt: 'desc' },
      take: 11,
    });
    const series = recent
      .reverse()
      .map((r) => r.measuredValue ?? 0)
      .concat(input.value);

    const evalResult = evaluateWestgard(series, target.mean, target.sd);

    // Within-run 다중레벨 규칙 — 같은 장비·검사의 다른 컨트롤 레벨(당일 최신)과 교차 평가
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const [peerTargets, peerResults] = await Promise.all([
      this.prisma.qcTarget.findMany({ where: { instrument: input.instrument, testCode: input.testCode, qcCode: { not: input.qcCode } } }),
      this.prisma.qcResult.findMany({ where: { instrument: input.instrument, testCode: input.testCode, qcCode: { not: input.qcCode }, measuredDt: { gte: start } }, orderBy: { measuredDt: 'desc' } }),
    ]);
    const targetByCode = new Map(peerTargets.map((t) => [`${t.qcCode}|${t.lot}`, t]));
    const seenPeer = new Set<string>();
    // sd 가드 — 0이면 ±Infinity가 교차레벨 규칙으로 흘러들어가 판정이 뒤죽박죽이 된다.
    //   저장 시점에 sd>0을 강제하지만, 과거 데이터가 남아 있을 수 있다.
    const thisZ = target.sd > 0 ? (input.value - target.mean) / target.sd : 0;
    const peerZs: number[] = [];
    for (const pr of peerResults) {
      if (seenPeer.has(pr.qcCode)) continue; // 레벨별 최신 1건
      seenPeer.add(pr.qcCode);
      const pt = targetByCode.get(`${pr.qcCode}|${pr.lot}`); // 피어 물질의 해당 로트 타깃
      if (pt && pt.sd > 0 && pr.measuredValue != null) peerZs.push((pr.measuredValue - pt.mean) / pt.sd);
    }
    const crossViol = crossLevelViolations([thisZ, ...peerZs]);
    for (const cv of crossViol) if (!evalResult.violations.includes(cv)) evalResult.violations.push(cv);
    if (crossViol.length > 0) evalResult.verdict = 'FAIL'; // within-run 규칙은 계통오차 → FAIL

    const saved = await this.prisma.qcResult.create({
      data: {
        qcResultId: genId('QCR'),
        qcCode: input.qcCode,
        instrument: input.instrument,
        testCode: input.testCode,
        measuredValue: input.value,
        measuredDt: new Date(),
        verdict: evalResult.verdict,
        lot,
      },
    });

    if (evalResult.verdict === 'FAIL') {
      await this.prisma.notification.create({
        data: {
          notifyId: `N-QC-${saved.qcResultId}`,
          ntype: 'QC위반',
          target: input.instrument,
          message: `${input.testCode} Westgard ${evalResult.violations.join(',')} — 결과 확정 차단`,
          createdDt: new Date(),
        },
      });
    }

    return { saved, evaluation: evalResult };
  }

  /**
   * QC 로트 크로스오버(D1) — 신로트 목표범위(mean/SD) 확립. 평행검사값(values, 통상 20일) 제공 시
   * mean/SD를 계산해 upsert, 또는 mean/sd 직접 지정. 로트별 QcTarget으로 저장(구로트 이력 보존).
   */
  async establishLotTarget(dto: { qcCode: string; instrument: string; testCode: string; lot: string; values?: number[]; mean?: number; sd?: number }) {
    let mean = dto.mean;
    let sd = dto.sd;
    if (dto.values && dto.values.length >= 2) {
      const n = dto.values.length;
      mean = dto.values.reduce((s, v) => s + v, 0) / n;
      const variance = dto.values.reduce((s, v) => s + (v - (mean as number)) ** 2, 0) / (n - 1); // 표본표준편차
      sd = Math.sqrt(variance);
    }
    if (mean == null || sd == null) throw new BadRequestException('평행검사값(values ≥2) 또는 mean·sd 필요');
    if (sd <= 0) throw new BadRequestException('SD는 0보다 커야 합니다(평행검사 변동 필요)');
    const target = await this.prisma.qcTarget.upsert({
      where: { qcCode_instrument_testCode_lot: { qcCode: dto.qcCode, instrument: dto.instrument, testCode: dto.testCode, lot: dto.lot } },
      update: { mean, sd },
      create: { qcTargetId: genId('QCT'), qcCode: dto.qcCode, instrument: dto.instrument, testCode: dto.testCode, lot: dto.lot, mean, sd },
    });
    return { target, computed: dto.values ? { n: dto.values.length, mean, sd } : null };
  }

  /** 당일 검사별 QC 상태 — (물질·장비)별 최신 판정 기준. 미해결 FAIL이 있으면 차단(다른 물질 PASS가 가리지 않음). */
  async getStatus(testCode: string) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    const rows = await this.prisma.qcResult.findMany({
      where: { testCode, measuredDt: { gte: start } },
      orderBy: { measuredDt: 'desc' },
    });
    const latest = rows[0];
    const latestByGroup = new Map<string, string | null>();
    for (const r of rows) {
      const key = `${r.qcCode}|${r.instrument ?? ''}`;
      if (!latestByGroup.has(key)) latestByGroup.set(key, r.verdict);
    }
    const blocked = [...latestByGroup.values()].some((v) => v === 'FAIL');
    return {
      testCode,
      verdict: latest?.verdict ?? 'NONE',
      measuredDt: latest?.measuredDt ?? null,
      blocked,
    };
  }

  /** 월간 QC 요약 — 해당 월(YYYY-MM) QC 결과를 verdict별 집계(월간 리뷰 근거). */
  async monthlySummary(period: string, testCode?: string, instrument?: string) {
    const [y, m] = period.split('-').map(Number);
    if (!y || !m) throw new BadRequestException('period는 YYYY-MM 형식');
    const from = new Date(Date.UTC(y, m - 1, 1));
    const to = new Date(Date.UTC(y, m, 1));
    const results = await this.prisma.qcResult.findMany({
      where: { measuredDt: { gte: from, lt: to }, ...(testCode ? { testCode } : {}), ...(instrument ? { instrument } : {}) },
    });
    const by: Record<string, { PASS: number; WARN: number; FAIL: number; total: number }> = {};
    for (const r of results) {
      const k = `${r.testCode}|${r.instrument ?? ''}`;
      by[k] = by[k] ?? { PASS: 0, WARN: 0, FAIL: 0, total: 0 };
      const v = (r.verdict as 'PASS' | 'WARN' | 'FAIL') ?? 'PASS';
      by[k][v] = (by[k][v] ?? 0) + 1;
      by[k].total++;
    }
    const rows = Object.entries(by).map(([k, c]) => { const [tc, inst] = k.split('|'); return { testCode: tc, instrument: inst || null, ...c, failRate: c.total ? Math.round((c.FAIL / c.total) * 100) : 0 }; });
    const review = await this.prisma.qcReview.findFirst({ where: { period, scope: testCode ?? 'ALL', instrument: instrument ?? null } });
    return { period, total: results.length, rows: rows.sort((a, b) => b.FAIL - a.FAIL), review };
  }

  /** 월간 QC 리뷰 사인오프 기록 — 감독자 검토·승인(인증 요건). 동일 기간·범위는 갱신. */
  async recordReview(dto: { period: string; scope?: string; instrument?: string; reviewedBy: string; verdict: string; note?: string }) {
    if (!/^\d{4}-\d{2}$/.test(dto.period)) throw new BadRequestException('period는 YYYY-MM 형식');
    if (!isOneOf(QC_REVIEW_VERDICTS, dto.verdict)) throw new BadRequestException(`verdict는 ${QC_REVIEW_VERDICTS.join('/')}`);
    const scope = dto.scope ?? 'ALL';
    const instrument = dto.instrument ?? null;
    const existing = await this.prisma.qcReview.findFirst({ where: { period: dto.period, scope, instrument } });
    if (existing) {
      return this.prisma.qcReview.update({ where: { reviewId: existing.reviewId }, data: { reviewedBy: dto.reviewedBy, verdict: dto.verdict, note: dto.note ?? null, reviewedDt: new Date() } });
    }
    return this.prisma.qcReview.create({ data: { reviewId: genId('QCR'), period: dto.period, scope, instrument, reviewedBy: dto.reviewedBy, verdict: dto.verdict, note: dto.note ?? null } });
  }

  async listReviews(period?: string) {
    return this.prisma.qcReview.findMany({ where: period ? { period } : undefined, orderBy: { reviewedDt: 'desc' }, take: 100 });
  }

  /**
   * QC 측정 로그 — 최근 QC 결과를 목록으로. 화면의 '판정 이력'이 클라이언트 세션 제출분만
   * 보여줘서, 새로고침하면 이력이 사라지고 다른 사람이 넣은 측정·과거 측정을 볼 수 없었다.
   * 서버가 저장한 측정을 값·판정·로트·측정일과 함께 조회한다(검사·장비·기간 필터).
   */
  async listResults(opts: { testCode?: string; instrument?: string; verdict?: string; from?: string; to?: string; limit?: number }) {
    const where: Record<string, unknown> = {};
    if (opts.testCode) where.testCode = opts.testCode;
    if (opts.instrument) where.instrument = opts.instrument;
    if (opts.verdict) where.verdict = opts.verdict;
    if (opts.from || opts.to) {
      const dt: Record<string, Date> = {};
      if (opts.from) { const d = new Date(opts.from); if (!isNaN(d.getTime())) { d.setHours(0, 0, 0, 0); dt.gte = d; } }
      if (opts.to) { const d = new Date(opts.to); if (!isNaN(d.getTime())) { d.setHours(23, 59, 59, 999); dt.lte = d; } }
      if (Object.keys(dt).length) where.measuredDt = dt;
    }
    const rows = await this.prisma.qcResult.findMany({
      where,
      include: { test: { select: { name: true, unitUcum: true } } },
      orderBy: { measuredDt: 'desc' },
      take: Math.min(opts.limit ?? 100, 300),
    });
    return rows.map((r) => ({
      qcResultId: r.qcResultId,
      qcCode: r.qcCode,
      instrument: r.instrument,
      testCode: r.testCode,
      testName: r.test?.name ?? r.testCode,
      unit: r.test?.unitUcum ?? null,
      measuredValue: r.measuredValue,
      verdict: r.verdict,
      lot: r.lot,
      measuredDt: r.measuredDt,
    }));
  }
}
