/**
 * AuditService — audit 도메인 서비스.
 *
 * 주요 진입점: `summary()`, `patientAccess()`, `query()`
 * 일부 경로는 트랜잭션으로 묶인다 — 부분 반영 시 임상 상태가 깨지는 구간.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * 감사추적 조회 서비스 — 기록(AuditInterceptor)된 감사로그를 검색·조회.
 * 근거: 기획 22 §6-6, 인증(문서·기록 관리).
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 기간 요약 — 감사 대응·이상 접근 탐지용 집계.
   *
   * 단순 건수 나열이 아니라 **"무엇을 봐야 하는가"**로 정렬한다:
   * 실패(권한 위반 시도)·민감 접근·심야 접근·과다 조회 사용자가 먼저 눈에 들어와야
   * 감사자가 수천 건을 일일이 넘기지 않는다.
   */
  async summary(opts: { from?: string; to?: string } = {}) {
    const range = opts.from || opts.to
      ? { createdDt: { ...(opts.from ? { gte: new Date(opts.from) } : {}), ...(opts.to ? { lte: new Date(opts.to) } : {}) } }
      : {};

    const [total, byActionRaw, byUserRaw, sensitive, failed] = await Promise.all([
      this.prisma.auditLog.count({ where: range }),
      this.prisma.auditLog.groupBy({ by: ['action'], where: range, _count: { _all: true } }),
      this.prisma.auditLog.groupBy({ by: ['userId'], where: range, _count: { _all: true }, orderBy: { _count: { userId: 'desc' } }, take: 10 }),
      this.prisma.auditLog.count({ where: { ...range, sensitive: true } }),
      this.prisma.auditLog.count({ where: { ...range, status: { gte: 400 } } }),
    ]);

    // 사용자별 실패 건수 — 권한 위반 시도가 한 사람에게 몰리는지(계정 오용·권한 오설정 신호)
    const failedByUserRaw = await this.prisma.auditLog.groupBy({
      by: ['userId'],
      where: { ...range, status: { gte: 400 } },
      _count: { _all: true },
      orderBy: { _count: { userId: 'desc' } },
      take: 5,
    });

    // 심야·주말 접근 — 정규 업무시간(평일 07~20시) 밖 접근은 감사에서 먼저 확인하는 항목.
    // groupBy로는 시간대 추출이 안 되므로 기간 내 시각만 뽑아 집계한다(필드 1개라 가볍다).
    const times = await this.prisma.auditLog.findMany({
      where: range,
      select: { createdDt: true, userId: true },
      take: 20000, // 상한 — 초과 시 offHours.truncated로 알린다
    });
    let offHours = 0;
    const offByUser = new Map<string, number>();
    const byDay = new Map<string, number>();
    for (const t of times) {
      const d = t.createdDt;
      const day = d.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) ?? 0) + 1);
      const h = d.getHours();
      const isWeekend = d.getDay() === 0 || d.getDay() === 6;
      if (isWeekend || h < 7 || h >= 20) {
        offHours += 1;
        const u = t.userId ?? '(미인증)';
        offByUser.set(u, (offByUser.get(u) ?? 0) + 1);
      }
    }

    return {
      total,
      sensitive,
      failed,
      byAction: byActionRaw.map((a) => ({ action: a.action, count: a._count._all })).sort((x, y) => y.count - x.count),
      topUsers: byUserRaw.map((u) => ({ userId: u.userId ?? '(미인증)', count: u._count._all })),
      failedByUser: failedByUserRaw.map((u) => ({ userId: u.userId ?? '(미인증)', count: u._count._all })),
      offHours: {
        count: offHours,
        truncated: times.length >= 20000,
        topUsers: [...offByUser.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([userId, count]) => ({ userId, count })),
      },
      byDay: [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, count]) => ({ date, count })),
    };
  }

  /**
   * 환자별 열람·변경 이력 — "이 환자 기록을 누가 봤는가"(의료법 열람기록 대응).
   *
   * ★환자ID 문자열만으로 검색하면 **검체·오더 경유 접근이 통째로 빠진다.**
   *   실제 감사로그의 대다수는 `/results/report/S2607130001`처럼 검체번호로 남는다
   *   (운영 실측). 그래서 이 환자의 검체번호·오더ID·병리번호·유전체오더를 먼저 모아
   *   그 식별자들까지 함께 훑는다. 이렇게 하지 않으면 "열람 없음"이라는 잘못된 답을 준다.
   */
  async patientAccess(patientId: string, opts: { from?: string; to?: string; take?: number } = {}) {
    const take = Math.min(Math.max(opts.take ?? 200, 1), 500);

    // 이 환자에 속한 식별자 수집(감사 target/detail에 등장하는 형태)
    const [specimens, orders, pathCases, genomic] = await Promise.all([
      this.prisma.specimen.findMany({ where: { order: { patientId } }, select: { specimenNo: true } }),
      this.prisma.labOrder.findMany({ where: { patientId }, select: { orderId: true } }),
      this.prisma.pathologyCase.findMany({ where: { patientId }, select: { spNo: true } }),
      // 유전체 오더는 환자에 직접 붙지 않고 LabOrder를 통해 연결된다
      this.prisma.genomicOrder.findMany({ where: { order: { patientId } }, select: { genomicOrderId: true } }),
    ]);
    const keys = [
      patientId,
      ...specimens.map((x) => x.specimenNo),
      ...orders.map((x) => x.orderId),
      ...pathCases.map((x) => x.spNo),
      ...genomic.map((x) => x.genomicOrderId),
    ].filter(Boolean);

    // ★기간 무지정이면 최근 1년로 한정(2026-07-30 성능 검토): 이 쿼리는 식별자×2 개의
    //   contains OR라 인덱스를 못 탄다 — createdDt 범위로 스캔 대상을 물리적으로 묶어야
    //   수백만 행 테이블에서 요청 한 번이 수십 초 CPU를 먹는 것을 막는다. 더 옛 구간이
    //   필요하면 from/to를 명시해 구간별로 조회한다(응답 rangeApplied로 표시).
    const from = opts.from ? new Date(opts.from) : new Date(Date.now() - 365 * 24 * 3600 * 1000);
    const range = { createdDt: { gte: from, ...(opts.to ? { lte: new Date(opts.to) } : {}) } };

    const rows = await this.prisma.auditLog.findMany({
      where: {
        ...range,
        OR: keys.flatMap((k) => [{ target: { contains: k } }, { detail: { contains: k } }]),
      },
      orderBy: { createdDt: 'desc' },
      take,
    });

    // 무엇을 통해 접근했는지 표시(검체 경유인지 환자 직접인지) — 감사자가 경로를 알아야 한다
    const via = (r: { target: string; detail: string | null }) => {
      const hay = `${r.target} ${r.detail ?? ''}`;
      if (hay.includes(patientId)) return '환자 직접';
      const sp = specimens.find((x) => hay.includes(x.specimenNo));
      if (sp) return `검체 ${sp.specimenNo}`;
      const pc = pathCases.find((x) => hay.includes(x.spNo));
      if (pc) return `병리 ${pc.spNo}`;
      const go = genomic.find((x) => hay.includes(x.genomicOrderId));
      if (go) return `유전체 ${go.genomicOrderId}`;
      const od = orders.find((x) => hay.includes(x.orderId));
      if (od) return `오더 ${od.orderId}`;
      return '기타';
    };

    return {
      patientId,
      scannedKeys: keys.length, // 몇 개 식별자를 훑었는지(범위 투명성)
      rangeApplied: { from: from.toISOString(), to: opts.to ?? null }, // 기본 최근 1년 — 무한 스캔 방지
      count: rows.length,
      truncated: rows.length >= take,
      rows: rows.map((r) => ({ ...r, via: via(r) })),
    };
  }

  async query(opts: {
    userId?: string;
    action?: string;
    target?: string;
    sensitive?: boolean;
    /** true면 실패 응답(4xx·5xx)만 — 권한 위반·오류 시도 탐지 */
    failedOnly?: boolean;
    from?: string;
    to?: string;
    skip?: number;
    take?: number;
  }) {
    const where = {
      ...(opts.userId ? { userId: opts.userId } : {}),
      ...(opts.action ? { action: opts.action } : {}),
      ...(opts.target ? { target: { contains: opts.target } } : {}),
      ...(opts.sensitive != null ? { sensitive: opts.sensitive } : {}),
      ...(opts.failedOnly ? { status: { gte: 400 } } : {}),
      ...(opts.from || opts.to
        ? { createdDt: { ...(opts.from ? { gte: new Date(opts.from) } : {}), ...(opts.to ? { lte: new Date(opts.to) } : {}) } }
        : {}),
    };
    const take = Math.min(opts.take ?? 50, 200);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({ where, orderBy: { createdDt: 'desc' }, skip: opts.skip ?? 0, take }),
    ]);
    return { total, count: rows.length, rows };
  }
}
