/**
 * LifecycleService — admin 도메인 서비스.
 *
 * 주요 진입점: `status()`, `purge()`, `scheduledPurge()`
 * 스케줄 작업 1건 — env 스위치로 켜고 끈다(운영단계 정의서 §4 참조).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, Logger, ConflictException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { RETENTION_POLICY, cutoffDate } from '../../domain/retention';
import { SettingsService } from '../settings/settings.service';

/**
 * 데이터 수명주기 서비스 — 보존정책 현황·경과 데이터 정리(purge).
 * 임상 결과(법정 보존)는 정리 대상 제외. (기획 22 §P3)
 */
@Injectable()
export class LifecycleService {
  private readonly logger = new Logger(LifecycleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /**
   * 전환 실행 이력 — 보존 퍼지도 **비가역**이라 남긴다(감사로그 자체를 지우는 작업이다).
   * 기록 실패가 정리를 막지 않는다. 크론(무인)은 actor를 SYSTEM으로 남긴다.
   */
  private async recordRun(result: 'OK' | 'FAILED', actor: string | null, before: unknown, after: unknown, message: string) {
    try {
      await this.prisma.cutoverRun.create({
        data: {
          runId: `RUN-${randomUUID()}`, step: 'lifecycle-purge', mode: 'EXEC', result,
          requestedBy: actor, beforeJson: JSON.stringify(before).slice(0, 4000),
          afterJson: JSON.stringify(after).slice(0, 4000), message: message.slice(0, 500),
          finishedDt: new Date(),
        },
      });
    } catch (e) {
      this.logger.warn(`퍼지 실행 이력 기록 실패: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * 실제 적용 보존일 — 화면 설정이 있으면 그 값, 없으면 코드 기본값.
   * 법정 하한(감사 730일 등)은 설정 저장 시점에 강제한다(settings.catalog).
   */
  private daysFor(key: string, fallback: number): number {
    const v = this.settings.getNumber(`RETENTION_DAYS_${key}`, fallback);
    // ★법정 하한을 **적용 시점에도** 강제한다(2026-07-30 적대 검토).
    //   설정 화면 저장 경로에만 하한이 걸려 있어, env로 `RETENTION_DAYS_audit_log=1`을 넣으면
    //   매일 크론이 하루 지난 감사로그를 전량 삭제할 수 있었다. env는 어떤 게이트도 안 탄다.
    const rule = RETENTION_POLICY.find((r) => r.key === key);
    const floor = rule?.minDays ?? 0;
    if (floor > 0 && v < floor) {
      this.logger.error(
        `보존기간 설정이 법정 하한 미만이라 무시한다 — ${key}: 설정 ${v}일 < 하한 ${floor}일. 하한값(${floor})을 적용한다`,
      );
      return floor;
    }
    return v;
  }

  private counter(key: string): {
    model: {
      count: (args: { where: unknown }) => Promise<number>;
      findMany: (args: { where: unknown; select: unknown; take: number }) => Promise<Record<string, string>[]>;
      deleteMany: (args: { where: unknown }) => Promise<{ count: number }>;
    };
    idField: string;
  } {
    const map: Record<string, { model: unknown; idField: string }> = {
      interface_log: { model: this.prisma.interfaceLog, idField: 'logId' },
      audit_log: { model: this.prisma.auditLog, idField: 'logId' },
      notification: { model: this.prisma.notification, idField: 'notifyId' },
      result: { model: this.prisma.result, idField: 'resultId' },
    };
    const hit = map[key];
    // 미등록 키가 undefined로 새면 크론의 파괴적 deleteMany가 런타임 TypeError로 터진다(Q7) — 조기·명시 실패
    if (!hit) throw new Error(`RETENTION_POLICY 키 미등록: ${key}`);
    return hit as ReturnType<LifecycleService['counter']>;
  }

  /** 보존정책별 현황 — 전체·경과(정리대상) 건수. */
  async status() {
    const now = Date.now();
    const rows = [];
    for (const rule of RETENTION_POLICY) {
      const { model } = this.counter(rule.key);
      const days = this.daysFor(rule.key, rule.days);
      const cutoff = cutoffDate(days, now);
      const total = await model.count({ where: {} });
      const expired = await model.count({ where: { [rule.dateField]: { lt: cutoff } } });
      rows.push({ ...rule, days, cutoff, total, expired });
    }
    return { generatedAt: new Date(now), policies: rows };
  }

  /**
   * 보존기간 경과 운영로그 정리(purgeable만). dryRun이면 건수만 반환.
   * ★실삭제는 LIFECYCLE_PURGE가 켜져 있어야 한다(2026-07-30 보안 검토) — 설정 화면이
   *   "꺼 두면 dryRun만"이라고 안내하는데 수동 호출이 킬스위치를 우회하면 안 된다.
   * ★배치 삭제(2026-07-30 성능 검토): 첫 실행 시 수백만 행 단일 DELETE는 장시간 락·WAL
   *   폭증을 만든다 — id 청크(1만)로 나눠 지운다. 각 청크가 독립 트랜잭션이라 중단돼도
   *   다음 실행이 이어서 지운다(멱등).
   */
  async purge(dryRun = true, actor: string | null = null) {
    if (!dryRun && !this.settings.getBool('LIFECYCLE_PURGE')) {
      throw new ConflictException('LIFECYCLE_PURGE가 꺼져 있습니다 — 실삭제는 설정을 켠 뒤에만 가능합니다(법무 보존기간 확정 전 안전장치)');
    }
    const now = Date.now();
    const BATCH = 10_000;
    const results = [];
    for (const rule of RETENTION_POLICY.filter((r) => r.purgeable)) {
      const { model, idField } = this.counter(rule.key);
      const cutoff = cutoffDate(this.daysFor(rule.key, rule.days), now);
      const where = { [rule.dateField]: { lt: cutoff } };
      const eligible = await model.count({ where });
      let deleted = 0;
      if (!dryRun && eligible > 0) {
        for (;;) {
          const batch = await model.findMany({ where, select: { [idField]: true }, take: BATCH });
          if (batch.length === 0) break;
          const ids = batch.map((row) => row[idField]);
          deleted += (await model.deleteMany({ where: { [idField]: { in: ids } } })).count;
          if (batch.length < BATCH) break;
        }
      }
      results.push({ key: rule.key, label: rule.label, cutoff, eligible, deleted });
    }
    if (!dryRun) {
      const total = results.reduce((s2, r) => s2 + r.deleted, 0);
      await this.recordRun(
        'OK', actor,
        results.map((r) => ({ key: r.key, eligible: r.eligible })),
        results.map((r) => ({ key: r.key, deleted: r.deleted })),
        `보존기간 경과 정리 — ${total}건 삭제`,
      );
    }
    return { dryRun, results };
  }

  /** 정기 정리 — 매일 04:00, LIFECYCLE_PURGE가 켜져 있을 때만 실제 삭제(법무 확정 전에는 꺼 둔다). */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async scheduledPurge() {
    // [cron-guard:scheduledPurge] 크론에서 던진 예외는 unhandledRejection이 되어 프로세스를 죽인다.
    //   죽지 않더라도 조용히 멈추면 다음 주기까지 아무도 모르므로 반드시 로깅한다.
    try {
      if (!this.settings.getBool('LIFECYCLE_PURGE')) return;
      const r = await this.purge(false, 'SYSTEM(cron)');
      const total = r.results.reduce((s, x) => s + x.deleted, 0);
      if (total > 0) this.logger.log(`데이터 수명주기 정리: ${total}건 삭제`);
  
    } catch (e) {
      this.logger.error(`크론 scheduledPurge 실패: ${e instanceof Error ? e.message : e}`);
    }
}
}
