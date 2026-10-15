/**
 * NotificationService — notification 도메인 서비스.
 *
 * 주요 진입점: `badgeCounts()`, `findPending()`, `findHistory()`, `ack()`
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/**
 * 알림 유형별 열람 역할 — 도메인 API의 역할 격리를 알림함이 우회하지 않게 한다(최소권한).
 * 예: 제제회수추적 본문에는 회수 사유·수혈받은 환자ID가 실리는데, 수혈 API는 BB/PHY로
 * 좁혀져 있으면서 알림함은 접수담당·유전상담에게도 열려 있었다(2026-07-30 보안 검토).
 * 여기 없는 유형은 종전대로 임상 전 역할 열람(운영 알림 — QC위반 등 광역 통지가 목적).
 * ADM(관리)·AUD(감사)는 전 유형 열람 — 운영·감사 소명 책무.
 */
const NTYPE_VISIBILITY: Record<string, string[]> = {
  중대수혈반응: ['BB', 'PHY', 'ADM', 'AUD'],
  제제회수추적: ['BB', 'PHY', 'ADM', 'AUD'],
  혈액근접만료: ['BB', 'ADM', 'AUD'],
  동의철회: ['GEN', 'GC', 'ADM', 'AUD'],
  환자재귀속: ['RCP', 'TEC', 'ADM', 'AUD'],
  검체거부: ['RCP', 'TEC', 'PHY', 'ADM', 'AUD'],
  법정감염병신고: ['MIC', 'PHY', 'ADM', 'AUD'],
  서명변경: ['ADM', 'AUD'],
  개시승인무효: ['ADM', 'AUD'],
};

/** 이 역할 조합이 볼 수 없는 알림 유형 목록(쿼리 notIn용). */
export function blockedNtypesFor(roles: string[]): string[] {
  return Object.entries(NTYPE_VISIBILITY)
    .filter(([, allowed]) => !roles.some((r) => allowed.includes(r)))
    .map(([ntype]) => ntype);
}

@Injectable()
export class NotificationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 사이드바 배지용 미확인 건수 — **개수만** 반환한다(PHI 없음).
   *
   * 이 엔드포인트가 따로 있는 이유: 배지는 60초마다 전 사용자 브라우저에서 폴링된다.
   * 목록 API(`/pending`, `/results/criticals/pending`)를 그 용도로 쓰면
   *  ① 응답에 환자명이 실려 목록을 열지도 않은 사용자에게 PHI가 계속 전송되고
   *  ② PHI 조회 감사가 폴링으로 가득 차 실제 열람 추적이 묻힌다(운영 실측 93%가 폴링이었다).
   * 배지는 개수만 필요하므로 카운트 쿼리로 분리한다.
   */
  async badgeCounts(): Promise<{ notifications: number; criticals: number }> {
    const [notifications, criticals] = await Promise.all([
      this.prisma.notification.count({ where: { ackDt: null } }),
      this.prisma.criticalNotify.count({ where: { ackDt: null } }),
    ]);
    return { notifications, criticals };
  }

  /** 유형 조건 — 명시 요청한 유형이 차단 유형이면 빈 결과가 되도록 불능 조건을 만든다(우회 차단). */
  private ntypeCond(roles: string[], ntype?: string): { in?: string[]; notIn?: string[]; equals?: string } | string | undefined {
    const blocked = blockedNtypesFor(roles);
    if (ntype) return blocked.includes(ntype) ? { in: [] } : ntype;
    return blocked.length ? { notIn: blocked } : undefined;
  }

  /** 미확인 알림 목록(유형 필터·역할 가시성). take: 휴가·주말 뒤 무제한 적재 방지. */
  async findPending(roles: string[], ntype?: string) {
    return this.prisma.notification.findMany({
      where: { ackDt: null, ntype: this.ntypeCond(roles, ntype) },
      orderBy: { createdDt: 'desc' },
      take: 300,
    });
  }

  /** 확인 처리된 알림 이력 — 확인 후 소실 방지(인증 추적). 확인자는 AuditLog에 기록됨. */
  async findHistory(roles: string[], ntype?: string) {
    return this.prisma.notification.findMany({
      where: { ackDt: { not: null }, ntype: this.ntypeCond(roles, ntype) },
      orderBy: { ackDt: 'desc' },
      take: 100,
    });
  }

  /** 알림 확인 */
  async ack(notifyId: string) {
    const n = await this.prisma.notification.findUnique({ where: { notifyId } });
    if (!n) throw new NotFoundException(`알림 없음: ${notifyId}`);
    return this.prisma.notification.update({
      where: { notifyId },
      data: { ackDt: new Date() },
    });
  }
}
