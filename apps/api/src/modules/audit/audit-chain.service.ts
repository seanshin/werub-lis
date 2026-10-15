/**
 * AuditChainService — audit 도메인 서비스.
 *
 * 주요 진입점: `onModuleInit()`, `append()`, `verify()`
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'crypto';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

/** 제네시스 prevHash(첫 레코드) — SHA256 길이(64) 0. */
const GENESIS = '0'.repeat(64);

/** 감사 해시체인에 담기는 불변 필드(레코드 정체성 = 이 필드들의 정규화 문자열). */
export interface AuditRecord {
  userId: string | null;
  action: string;
  target: string;
  detail: string | null;
  status: number | null;
  sensitive: boolean;
}

/** seq·prevHash·createdDt를 확정한 뒤 해시 입력 문자열을 만드는 순수 함수(검증부와 공유). */
export function auditHashInput(
  r: AuditRecord,
  seq: number,
  prevHash: string,
  createdDt: Date,
): string {
  return [
    seq,
    r.userId ?? '',
    r.action,
    r.target,
    r.detail ?? '',
    r.status ?? '',
    r.sensitive ? 1 : 0,
    createdDt.toISOString(),
    prevHash,
  ].join('|');
}

export function auditHash(
  r: AuditRecord,
  seq: number,
  prevHash: string,
  createdDt: Date,
): string {
  return createHash('sha256').update(auditHashInput(r, seq, prevHash, createdDt)).digest('hex');
}

/**
 * Tamper-evident 감사 해시체인(개시 전 백로그: 감사 무결성).
 *
 * - 단일 인스턴스(lis-api 1) 전제: in-memory tail(마지막 seq·hash)을 뮤텍스(promise 체인)로
 *   직렬화해 append → 동시요청에도 seq 단조·prevHash 정확. 재기동 시 DB의 max(seq) 재적재.
 * - 레코드 변조(필드 수정)는 hash 재계산 불일치로, 삭제·재정렬·삽입은 prevHash 링크 단절로 탐지.
 * - 보존 퍼지(retention)는 오래된 체인 앞부분을 지울 수 있음 → verify는 "현존 레코드 구간의
 *   연속성"을 검증(경계에서 제네시스 불일치는 정상). 필드 변조 탐지는 퍼지와 무관하게 유효.
 */
@Injectable()
export class AuditChainService implements OnModuleInit {
  private readonly logger = new Logger('AuditChain');
  private tail: { seq: number; hash: string } | null = null;
  private mutex: Promise<void> = Promise.resolve();

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    const last = await this.prisma.auditLog.findFirst({
      where: { seq: { not: null } },
      orderBy: { seq: 'desc' },
      select: { seq: true, hash: true },
    });
    if (last?.seq != null && last.hash) {
      this.tail = { seq: last.seq, hash: last.hash };
      this.logger.log(`감사 체인 tail 적재: seq=${last.seq}`);
    }
  }

  /**
   * 감사 레코드를 체인에 추가(직렬화). 인터셉터에서 fire-and-forget로 호출하되 순서는 보장.
   * 실패는 로깅(무추적 조치 감지) — 삼키지 않음.
   */
  append(record: AuditRecord): Promise<void> {
    const run = this.mutex.then(async () => {
      const seq = (this.tail?.seq ?? 0) + 1;
      const prevHash = this.tail?.hash ?? GENESIS;
      const createdDt = new Date();
      const hash = auditHash(record, seq, prevHash, createdDt);
      await this.prisma.auditLog.create({
        data: { ...record, seq, prevHash, hash, createdDt },
      });
      this.tail = { seq, hash };
    });
    // 실패해도 뮤텍스가 rejected 상태로 굳지 않도록 catch로 흡수(다음 append 진행 가능).
    this.mutex = run.catch(() => undefined);
    return run.catch((e) => {
      this.logger.error(`감사 체인 기록 실패: ${e instanceof Error ? e.message : e}`);
    });
  }

  /**
   * 체인 무결성 검증 — seq 있는 전 레코드를 seq 오름차순으로 순회하며
   *  (1) 저장된 hash == 필드 재계산 hash (필드 변조 탐지)
   *  (2) seq 연속성: prev.seq+1 이어야 함 — gap = 중간 레코드 삭제(정당한 retention 퍼지는
   *      항상 오래된 연속 prefix만 제거하므로 내부 gap을 남기지 않음)
   *  (3) prevHash == 직전 hash (재정렬·삽입 탐지)
   *  (4) firstSeq==1이면 첫 레코드 prevHash는 제네시스여야 함(진짜 최초 레코드 무결). firstSeq>1은
   *      prefix 퍼지로 간주해 첫 레코드 링크 검증 생략.
   * 를 확인. brokenAt=최초 불일치 seq(정상=null).
   */
  async verify(): Promise<{
    ok: boolean;
    count: number;
    firstSeq: number | null;
    lastSeq: number | null;
    brokenAt: number | null;
    reason: string | null;
  }> {
    // ★커서 배치 순회(2026-07-30 성능 검토): 전량 findMany는 수백만 행에서 수 GB를
    //   Node 힙에 올려 OOM으로 프로세스가 죽는 유일한 단발 쿼리였다. 체인 검증은 순차라
    //   청크로 잘라도 알고리즘이 같다 — seq > cursor 오름차순으로 이어붙인다.
    const CHUNK = 50_000;
    let count = 0;
    let firstSeq: number | null = null;
    let lastSeq: number | null = null;
    let prev: { seq: number; hash: string } | null = null;
    let cursor = 0;
    for (;;) {
      const rows = await this.prisma.auditLog.findMany({
        where: { seq: { gt: cursor } },
        orderBy: { seq: 'asc' },
        take: CHUNK,
        select: {
          seq: true, userId: true, action: true, target: true,
          detail: true, status: true, sensitive: true, createdDt: true,
          prevHash: true, hash: true,
        },
      });
      if (rows.length === 0) break;
      for (const row of rows) {
        const seq = row.seq as number;
        firstSeq ??= seq;
        lastSeq = seq;
        count += 1;
        const rec: AuditRecord = {
          userId: row.userId, action: row.action, target: row.target,
          detail: row.detail, status: row.status, sensitive: row.sensitive,
        };
        const broken = (reason: string) => ({ ok: false, count, firstSeq, lastSeq, brokenAt: seq, reason });
        // (1) 필드 변조
        if (auditHash(rec, seq, row.prevHash ?? GENESIS, row.createdDt) !== row.hash) {
          return broken('hash 불일치(레코드 변조)');
        }
        if (prev) {
          // (2) seq 연속성 — gap은 중간 삭제
          if (seq !== prev.seq + 1) return broken(`seq gap(중간 레코드 삭제: ${prev.seq}→${seq})`);
          // (3) 링크
          if (row.prevHash !== prev.hash) return broken('prevHash 링크 단절(재정렬·삽입)');
        } else if (seq === 1 && row.prevHash !== GENESIS) {
          // (4) 진짜 최초 레코드는 제네시스 링크
          return broken('최초 레코드 prevHash != 제네시스');
        }
        prev = { seq, hash: row.hash as string };
      }
      cursor = rows[rows.length - 1].seq as number;
      if (rows.length < CHUNK) break;
    }
    if (count === 0) {
      return { ok: true, count: 0, firstSeq: null, lastSeq: null, brokenAt: null, reason: null };
    }
    return { ok: true, count, firstSeq, lastSeq, brokenAt: null, reason: null };
  }
}
