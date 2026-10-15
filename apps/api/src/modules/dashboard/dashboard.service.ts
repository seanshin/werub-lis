/**
 * DashboardService — dashboard 도메인 서비스.
 *
 * 주요 진입점: `overview()`
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  private ymd(d: Date): string {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  /** 대시보드 종합 현황 — 연계 상태 + 오늘 처리 + 5분야별 대기 + QC. 단일 집계. */
  async overview() {
    const now = new Date();
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const in7 = new Date(now); in7.setDate(now.getDate() + 7);
    const in7Str = this.ymd(in7);

    const [todayGroups, rxGroups, pendingReport, pathologyOpen, culturing, bloodExpiring, qcFailToday, genomicPending] = await Promise.all([
      this.prisma.labOrder.groupBy({ by: ['status'], where: { orderDt: { gte: dayStart } }, _count: { _all: true }, orderBy: { status: 'asc' } }),
      this.prisma.interfaceLog.groupBy({ by: ['status'], where: { ifId: 'IF-RX', direction: 'OUTBOUND' }, _count: { _all: true }, orderBy: { status: 'asc' } }),
      this.prisma.orderItem.count({ where: { status: { in: ['RECEIVED', 'IN_PROCESS'] as never } } }),
      this.prisma.pathologyCase.count({ where: { status: { notIn: ['완료', '개정', '최종'] } } }),
      this.prisma.culture.count({ where: { status: { notIn: ['COMPLETED', '완료', '최종'] } } }),
      this.prisma.bloodUnit.count({ where: { status: 'IN_STOCK', expiryDate: { lte: in7Str } } }),
      this.prisma.qcResult.count({ where: { verdict: 'FAIL', measuredDt: { gte: dayStart } } }),
      // 판독 대기 = FINAL 해석이 없는 변이를 하나라도 가진 오더. count로 DB에서 센다 —
      // 전 오더의 전 변이·해석을 적재하면 NGS 누적 시 대시보드 폴링마다 수십만 행이 딸려온다.
      this.prisma.genomicOrder.count({
        where: { variants: { some: { interpretations: { none: { status: 'FINAL' } } } } },
      }),
    ]);

    const groupToRec = (g: { status: string; _count: { _all: number } }[]) => {
      const r: Record<string, number> = {};
      for (const x of g) r[x.status] = x._count._all;
      return r;
    };
    const today = groupToRec(todayGroups);
    const reflex = groupToRec(rxGroups);

    const hisFhir = !!(process.env.HIS_FHIR_BASE && process.env.HIS_CLIENT_ID && process.env.HIS_CLIENT_SECRET);
    const pacs = !!(process.env.PACS_MLLP_HOST && process.env.PACS_MLLP_PORT) || !!process.env.PACS_BASE;

    return {
      integration: {
        hisFhir, // FHIR 오더폴링·결과발신 자격증명 구성 여부
        pacs, // PACS MWL/QIDO 대상 구성 여부
        hisOrderPoll: process.env.HIS_ORDER_POLL === 'on',
        reflexPoll: process.env.HIS_REFLEX_POLL === 'on',
        reflex, // Reflex 양방향오더 발신 상태 분포(STAGED/PROCESSED/FAILED/DLQ/APPROVED/REJECTED)
      },
      today: {
        received: today.RECEIVED ?? 0,
        inProcess: today.IN_PROCESS ?? 0,
        completed: today.COMPLETED ?? 0,
        reported: today.REPORTED ?? 0,
        cancelled: today.CANCELLED ?? 0,
        total: Object.values(today).reduce((a, b) => a + b, 0),
      },
      domains: {
        diagnosticPending: pendingReport, // 미보고(접수·진행) 검사항목
        pathologyOpen, // 병리 판독/진행 케이스
        culturing, // 미생물 배양 진행
        bloodExpiring, // 7일내 만료 임박 재고
        genomicPending, // 유전체 미해석(FINAL 없는 변이 보유 오더)
      },
      qc: { failToday: qcFailToday },
      generatedAt: now.toISOString(),
    };
  }
}
