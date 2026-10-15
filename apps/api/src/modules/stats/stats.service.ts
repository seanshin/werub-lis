/**
 * StatsService — stats 도메인 서비스.
 *
 * 주요 진입점: `tat()`, `volumes()`, `workload()`, `sectionTat()`, `volumeTrend()`, `antibiogram()`, `qcChart()`, `pathologyQa()`…
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { summarizeTat, antibiogramFrom, antibiogramCsv, ljPoints } from '../../domain/stats';
import { FINALIZED_VERIFY_STATES } from '../../domain/result-evaluation';

/**
 * 통계·리포트 서비스 — TAT·검사량·재검률·antibiogram·QC 차트·미보고 목록.
 * 근거: 기획 22 §6-5 (인증 필수 지표).
 */
@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  private range(from?: string, to?: string) {
    return {
      gte: from ? new Date(from) : new Date(Date.now() - 30 * 864e5),
      lte: to ? new Date(to) : new Date(),
    };
  }

  /**
   * TAT 원자료(접수→보고 분) 커서 순회 — 결과 행을 통째로 적재하지 않는다.
   * 2026-07-30 성능 검토: `include: { specimen: true }`로 30일치 15만 행 + 조인 검체
   * 전 컬럼을 힙에 올리고 있었다(6개월 지정 시 90만 행). 필요한 두 시각만 뽑아 청크로 읽는다.
   * 집계 수식은 그대로라 결과값은 동일하다.
   */
  private async tatMinutesByDomain(gte: Date, lte: Date): Promise<Map<string, number[]>> {
    const CHUNK = 20_000;
    const out = new Map<string, number[]>();
    let cursor: string | undefined;
    for (;;) {
      const rows = await this.prisma.result.findMany({
        where: { reportedDt: { not: null, gte, lte } },
        select: { resultId: true, reportedDt: true, test: { select: { domain: true } }, specimen: { select: { receivedDt: true } } },
        orderBy: { resultId: 'asc' },
        take: CHUNK,
        ...(cursor ? { cursor: { resultId: cursor }, skip: 1 } : {}),
      });
      if (rows.length === 0) break;
      for (const x of rows) {
        if (!x.reportedDt || !x.specimen.receivedDt) continue;
        const mins = (x.reportedDt.getTime() - x.specimen.receivedDt.getTime()) / 60000;
        const list = out.get(x.test.domain);
        if (list) list.push(mins);
        else out.set(x.test.domain, [mins]);
      }
      cursor = rows[rows.length - 1].resultId;
      if (rows.length < CHUNK) break;
    }
    return out;
  }

  /** TAT — 접수(receivedDt)→보고(reportedDt) 소요시간(분) 분포. */
  async tat(from?: string, to?: string) {
    const r = this.range(from, to);
    const byDomain = await this.tatMinutesByDomain(r.gte, r.lte);
    const minutes = [...byDomain.values()].flat();
    return { from: r.gte, to: r.lte, ...summarizeTat(minutes) };
  }

  /** 검사량·재검률 — 도메인별 건수 + 정정(재검) 비율. */
  async volumes(from?: string, to?: string) {
    const r = this.range(from, to);
    const where = { reportedDt: { gte: r.gte, lte: r.lte } };
    // groupBy + count로 DB에서 집계 — 전 결과 행+검사마스터 조인을 적재하지 않는다.
    // 도메인은 testCode→TestMaster(수십~수백 행) 매핑으로 얻는다.
    const [byTest, total, corrected, tests] = await Promise.all([
      this.prisma.result.groupBy({ by: ['testCode'], where, _count: { _all: true } }),
      this.prisma.result.count({ where }),
      this.prisma.result.count({ where: { ...where, OR: [{ status: 'C' }, { version: { gt: 1 } }] } }),
      this.prisma.testMaster.findMany({ select: { testCode: true, domain: true } }),
    ]);
    const domainOf = new Map(tests.map((t) => [t.testCode, t.domain]));
    const byDomain: Record<string, number> = {};
    for (const g of byTest) {
      const d = domainOf.get(g.testCode) ?? 'UNKNOWN';
      byDomain[d] = (byDomain[d] ?? 0) + g._count._all;
    }
    return {
      from: r.gte,
      to: r.lte,
      total,
      byDomain,
      rerunCount: corrected,
      rerunRatePct: total ? Math.round((corrected / total) * 1000) / 10 : 0,
    };
  }

  /** 워크로드(C4) — 직원별 결과입력·검증 건수(생산성). enteredBy/verifier 집계. */
  async workload(from?: string, to?: string) {
    const r = this.range(from, to);
    const where = { reportedDt: { gte: r.gte, lte: r.lte } };
    // groupBy로 DB 집계 — 사용자 수만큼의 행만 돌아온다(종전은 전 결과 행 적재).
    const [enteredG, verifiedG, total] = await Promise.all([
      this.prisma.result.groupBy({ by: ['enteredBy'], where: { ...where, enteredBy: { not: null } }, _count: { _all: true } }),
      this.prisma.result.groupBy({
        by: ['verifier'],
        where: { ...where, verifier: { not: null }, verifyState: { in: [...FINALIZED_VERIFY_STATES] } },
        _count: { _all: true },
      }),
      this.prisma.result.count({ where }),
    ]);
    const toRows = (g: { _count: { _all: number } }[], key: 'enteredBy' | 'verifier') =>
      g.map((x) => ({ user: (x as unknown as Record<string, string>)[key], count: x._count._all })).sort((a, b) => b.count - a.count);
    return { from: r.gte, to: r.lte, total, entered: toRows(enteredG, 'enteredBy'), verified: toRows(verifiedG, 'verifier') };
  }

  /** 섹션(도메인)별 TAT(C4) — 접수→보고 소요(분)를 검사 도메인별로 평균·중앙값. */
  async sectionTat(from?: string, to?: string) {
    const r = this.range(from, to);
    const bucket = await this.tatMinutesByDomain(r.gte, r.lte);
    const rows = [...bucket.entries()].map(([domain, arr]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
      const median = sorted[Math.floor(sorted.length / 2)];
      return { domain, count: arr.length, meanMin: Math.round(mean), medianMin: Math.round(median) };
    }).sort((a, b) => b.count - a.count);
    return { from: r.gte, to: r.lte, sections: rows };
  }

  /** 검사량 추세(C4) — 일자별 결과 건수(시계열). */
  async volumeTrend(from?: string, to?: string) {
    const r = this.range(from, to);
    // 일자 집계는 SQL에서 — 전 결과의 reportedDt를 적재해 JS로 세지 않는다.
    // (UTC 기준 일자 — 종전 toISOString().slice(0,10)와 동일 기준)
    // 일자는 문자열로 받는다 — timestamp를 Date로 되받으면 드라이버가 로컬시간으로 해석해
    // 하루가 밀릴 수 있다(서버 TZ에 따라). SQL에서 UTC 기준 문자열로 확정한다.
    const rows = await this.prisma.$queryRaw<{ day: string; count: bigint }[]>`
      SELECT to_char("reported_dt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, COUNT(*)::bigint AS count
      FROM "result"
      WHERE "reported_dt" IS NOT NULL AND "reported_dt" >= ${r.gte} AND "reported_dt" <= ${r.lte}
      GROUP BY 1 ORDER BY 1 ASC`;
    const series = rows.map((x) => ({ day: x.day, count: Number(x.count) }));
    return { from: r.gte, to: r.lte, total: series.reduce((s, x) => s + x.count, 0), series };
  }

  /** 월간 antibiogram — organism × antibiotic %S. CSV 포함. */
  async antibiogram() {
    // ★antibiogram은 **전체 누적**이다 — 감수성/분리주에 신뢰할 기간 타임스탬프가 없어 기간 필터를 적용할 수
    //   없다(from/to를 받아 필터한 척하면 오해를 부른다). cumulative:true로 명시하고 기간은 null로 반환한다.
    //   기간별 antibiogram이 필요하면 Susceptibility에 확정일 컬럼 도입이 선행돼야 한다(백로그).
    // 필요한 3개 필드만 select — isolate 전 컬럼 적재를 피한다(누적이라 행 수는 계속 는다).
    const sus = await this.prisma.susceptibility.findMany({
      select: { antibiotic: true, interpretation: true, isolate: { select: { organism: true } } },
    });
    const rows = sus.map((s) => ({
      organism: s.isolate.organism,
      antibiotic: s.antibiotic,
      interpretation: s.interpretation,
    }));
    const agg = antibiogramFrom(rows);
    return { from: null, to: null, cumulative: true, organisms: agg, csv: antibiogramCsv(agg) };
  }

  /** QC Levey-Jennings — 목표(mean/sd) 대비 측정값 z-score 시계열. */
  async qcChart(qcCode: string, instrument: string, testCode: string) {
    // 로트별 타깃 존재 가능 — DEFAULT 우선, 없으면 아무 로트(LJ 차트용).
    const target = (await this.prisma.qcTarget.findUnique({
      where: { qcCode_instrument_testCode_lot: { qcCode, instrument, testCode, lot: 'DEFAULT' } },
    })) ?? (await this.prisma.qcTarget.findFirst({ where: { qcCode, instrument, testCode } }));
    if (!target) throw new NotFoundException(`QC 목표 없음: ${qcCode}/${instrument}/${testCode}`);
    const results = await this.prisma.qcResult.findMany({
      where: { qcCode, instrument, testCode, measuredValue: { not: null } },
      orderBy: { measuredDt: 'asc' },
    });
    const points = ljPoints(
      results.map((x) => ({ measuredDt: x.measuredDt?.toISOString() ?? null, value: x.measuredValue! })),
      target.mean,
      target.sd,
    );
    return { qcCode, instrument, testCode, mean: target.mean, sd: target.sd, points };
  }

  /**
   * 병리 QA·통계(PP6) — 케이스량(유형별)·개정률·동결절편 일치도·TAT(접수→서명)·IHC/세포병리 볼륨.
   * 근거: CAP/인증 병리 지표(amendment rate·frozen-permanent concordance·TAT).
   */
  async pathologyQa(from?: string, to?: string) {
    const r = this.range(from, to);
    // 케이스는 receivedDate가 문자열(YYYY-MM-DD) — 문자열 범위로 비교.
    const fromStr = r.gte.toISOString().slice(0, 10);
    const toStr = r.lte.toISOString().slice(0, 10);
    const cases = await this.prisma.pathologyCase.findMany({
      where: { receivedDate: { gte: fromStr, lte: toStr } },
      include: { report: true, cytology: true },
    });
    const byType: Record<string, number> = {};
    let signed = 0, amended = 0, frozenTotal = 0, frozenConcordant = 0;
    const tatMinutes: number[] = [];
    for (const c of cases) {
      byType[c.caseType] = (byType[c.caseType] ?? 0) + 1;
      const rep = c.report;
      if (rep?.signedDt || c.cytology?.signedDt) signed += 1;
      if ((rep?.version ?? 1) > 1) amended += 1;
      if (rep?.frozenConcordance) {
        frozenTotal += 1;
        if (rep.frozenConcordance === 'CONCORDANT') frozenConcordant += 1;
      }
      // TAT: 접수일(자정 기준)→서명시각
      const signedDt = rep?.signedDt ?? c.cytology?.signedDt ?? null;
      if (signedDt && c.receivedDate) {
        const recv = new Date(c.receivedDate + 'T00:00:00Z').getTime();
        tatMinutes.push((signedDt.getTime() - recv) / 60000);
      }
    }
    const [ihcCount, cytoCount] = await Promise.all([
      this.prisma.ihcResult.count({ where: { reportedDt: { gte: r.gte, lte: r.lte } } }),
      this.prisma.cytologyReport.count({ where: { reportedDt: { gte: r.gte, lte: r.lte } } }),
    ]);
    const total = cases.length;
    return {
      from: r.gte, to: r.lte,
      totalCases: total,
      byCaseType: byType,
      signedCases: signed,
      amendedCases: amended,
      amendmentRatePct: signed ? Math.round((amended / signed) * 1000) / 10 : 0,
      frozen: {
        total: frozenTotal,
        concordant: frozenConcordant,
        concordanceRatePct: frozenTotal ? Math.round((frozenConcordant / frozenTotal) * 1000) / 10 : null,
      },
      tat: summarizeTat(tatMinutes),
      ihcResultCount: ihcCount,
      cytologyReportCount: cytoCount,
    };
  }

  /**
   * 수혈 사용·폐기 통계(T3) — 출고·수혈·교차·폐기·반납 + 파생지표(C:T ratio·반납률·폐기건수) + 재고 스냅샷.
   * 근거: 혈액 이용 적정성(C:T ratio)·폐기율(hemovigilance)·인증 QA 지표.
   */
  async transfusionStats(from?: string, to?: string) {
    const r = this.range(from, to);
    const [issues, acts, crossmatches, discards, units] = await Promise.all([
      this.prisma.bloodIssue.findMany({ where: { issuedDt: { gte: r.gte, lte: r.lte } }, select: { status: true, emergency: true, unitNo: true } }),
      this.prisma.transfusionAct.findMany({ where: { startDt: { gte: r.gte, lte: r.lte } }, select: { issueId: true } }),
      this.prisma.crossmatch.count({ where: { testedDt: { gte: r.gte, lte: r.lte } } }),
      this.prisma.bloodUnit.findMany({ where: { discardedDt: { gte: r.gte, lte: r.lte } }, select: { productType: true, discardReason: true } }),
      this.prisma.bloodUnit.groupBy({ by: ['status'], _count: { _all: true } }),
    ]);
    // 수혈 제제유형별 — act→issue→unit.productType
    const issueMap = new Map((await this.prisma.bloodIssue.findMany({ where: { issueId: { in: acts.map((a) => a.issueId) } }, select: { issueId: true, unit: { select: { productType: true } } } })).map((i) => [i.issueId, i.unit?.productType ?? '기타']));
    const byProduct: Record<string, number> = {};
    for (const a of acts) { const p = issueMap.get(a.issueId) ?? '기타'; byProduct[p] = (byProduct[p] ?? 0) + 1; }

    const issued = issues.length;
    const returned = issues.filter((i) => i.status === 'RETURNED').length;
    const emergency = issues.filter((i) => i.emergency).length;
    const transfused = acts.length;
    const discardCount = discards.length;
    const discardByReason: Record<string, number> = {};
    for (const d of discards) { const k = (d.discardReason ?? '기타').split(' · ')[0].slice(0, 40); discardByReason[k] = (discardByReason[k] ?? 0) + 1; }
    const inventory = Object.fromEntries(units.map((u) => [u.status, u._count._all]));

    return {
      from: r.gte, to: r.lte,
      issued, transfused, returned, emergency, crossmatches, discardCount,
      byProduct, discardByReason, inventory,
      // 파생지표
      ctRatio: transfused ? Math.round((crossmatches / transfused) * 100) / 100 : null, // 교차:수혈(낮을수록 적정, 목표 ≤2)
      returnRatePct: issued ? Math.round((returned / issued) * 1000) / 10 : 0,
      emergencyRatePct: issued ? Math.round((emergency / issued) * 1000) / 10 : 0,
    };
  }

  /** 미보고·지연 목록 — 검증 대기(PENDING) 결과를 경과시간 순으로. */
  async pending(overdueHours = 4) {
    const rows = await this.prisma.result.findMany({
      where: { verifyState: 'PENDING' },
      select: {
        resultId: true, specimenNo: true, testCode: true, holdReason: true,
        test: { select: { name: true } }, specimen: { select: { receivedDt: true } },
      },
      orderBy: { reportedDt: 'asc' }, // 오래된 것 우선 — 상한에 걸려도 급한 건이 남는다
      take: 500, // 검증 워크리스트(take 300)와 같은 이유의 상한 — 적체 시 단일 대용량 응답 방지
    });
    const now = Date.now();
    return rows
      .map((x) => {
        const base = x.specimen.receivedDt?.getTime() ?? now;
        const ageMin = Math.round((now - base) / 60000);
        return {
          resultId: x.resultId,
          specimenNo: x.specimenNo,
          testCode: x.testCode,
          testName: x.test.name,
          holdReason: x.holdReason,
          ageMin,
          overdue: ageMin > overdueHours * 60,
        };
      })
      .sort((a, b) => b.ageMin - a.ageMin);
  }
}
