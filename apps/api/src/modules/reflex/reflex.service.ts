/**
 * ReflexService — reflex 도메인 서비스.
 *
 * 주요 진입점: `onModuleInit()`, `report()`, `listRejections()`, `resolveRejection()`, `list()`, `get()`, `activeFor()`, `create()`…
 * 일부 경로는 트랜잭션으로 묶인다 — 부분 반영 시 임상 상태가 깨지는 구간.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, NotFoundException, BadRequestException, ConflictException, OnModuleInit, Logger } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { genId } from '../../common/id.util';
import { REFLEX_OPERATORS } from '../../domain/reflex';

export interface ReflexInput {
  name: string;
  whenTestCode: string;
  operator: string;
  threshold?: number | null;
  thresholdHigh?: number | null;
  flag?: string | null;
  addTestCodes: string; // 콤마구분
  priority?: string | null;
  effectiveFrom?: string | null;
  effectiveTo?: string | null;
  supersedesProtocolId?: string | null; // 이 프로토콜이 개정하는 선행 프로토콜(계보) — 활성화 시 선행을 SUPERSEDED
}

// 상태 전이 규칙 — 승인 라이프사이클(기획 27 §3)
const EDITABLE = ['DRAFT', 'REJECTED'];

@Injectable()
export class ReflexService implements OnModuleInit {
  private readonly logger = new Logger(ReflexService.name);
  constructor(private readonly prisma: PrismaService) {}

  /** 기존 하드코딩 규칙(GLU≥200→HbA1c)을 승인된 시드 프로토콜로 무손실 이관(멱등). */
  async onModuleInit() {
    try {
      const seedId = 'RP-SEED-GLU-HBA1C';
      const exists = await this.prisma.reflexProtocol.findUnique({ where: { protocolId: seedId } });
      if (!exists) {
        await this.prisma.reflexProtocol.create({
          data: {
            protocolId: seedId,
            name: '고혈당 반사검사(포도당≥200 → HbA1c)',
            status: 'ACTIVE',
            whenTestCode: 'CHE-GLU',
            operator: '>=',
            threshold: 200,
            addTestCodes: 'CHE-HBA1C',
            specialistBy: 'SEED',
            specialistDt: new Date(),
            committeeNo: 'SEED-이관(실운영 전 위원회 의결로 대체)',
            committeeDt: new Date(),
            hisRef: 'SEED',
            createdBy: 'SYSTEM',
            events: { create: { eventId: genId('RPE'), event: 'ACTIVATE', actor: 'SYSTEM', note: '하드코딩 규칙 이관 시드' } },
          },
        });
        this.logger.log('Reflex 시드 프로토콜 이관 완료(GLU→HbA1c)');
      }
    } catch (e) {
      this.logger.warn(`Reflex 시드 이관 skip: ${e instanceof Error ? e.message : e}`);
    }
  }

  /**
   * QI 리포트 — 프로토콜별 실행 빈도·양방향 오더 결과(승인/반려)·의사 반려율.
   * outbound 상태는 interface_log(IF-RX)의 messageControlId로 결합.
   */
  async report(from?: string, to?: string) {
    const where = from || to
      ? { executedDt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } }
      : {};
    const execs = await this.prisma.reflexExecution.findMany({ where, orderBy: { executedDt: 'desc' }, take: 5000 });
    // outbound 상태 결합
    const mcids = execs.map((e) => e.outboundMcid).filter((x): x is string => !!x);
    const outRows = mcids.length
      ? await this.prisma.interfaceLog.findMany({ where: { direction: 'OUTBOUND', messageControlId: { in: mcids } }, select: { messageControlId: true, status: true } })
      : [];
    const outBy = new Map(outRows.map((r) => [r.messageControlId, r.status]));

    // 프로토콜별 집계
    const byProto = new Map<string, { protocolId: string; name: string; executions: number; outbound: Record<string, number> }>();
    for (const e of execs) {
      const g = byProto.get(e.protocolId) ?? { protocolId: e.protocolId, name: e.protocolName, executions: 0, outbound: {} };
      g.executions++;
      const st = e.outboundMcid ? (outBy.get(e.outboundMcid) ?? 'NONE') : 'NONE';
      g.outbound[st] = (g.outbound[st] ?? 0) + 1;
      byProto.set(e.protocolId, g);
    }
    const protocols = [...byProto.values()].map((g) => {
      const approved = g.outbound['APPROVED'] ?? 0;
      // 반려는 처리(취소/유지) 후 status가 REJECTED_CANCELLED/REJECTED_KEPT로 바뀐다 — 처리했다고 반려율이
      // 줄면 과다발동 프로토콜의 근거가 사라진다. 처리분까지 모두 '반려'로 집계.
      const rejected = (g.outbound['REJECTED'] ?? 0) + (g.outbound['REJECTED_CANCELLED'] ?? 0) + (g.outbound['REJECTED_KEPT'] ?? 0);
      const decided = approved + rejected;
      return { ...g, approved, rejected, rejectionRatePct: decided ? Math.round((rejected / decided) * 100) : null };
    }).sort((a, b) => b.executions - a.executions);

    // 일자별 추세(최근 집계)
    const byDay = new Map<string, number>();
    for (const e of execs) {
      const d = e.executedDt.toISOString().slice(0, 10);
      byDay.set(d, (byDay.get(d) ?? 0) + 1);
    }
    const trend = [...byDay.entries()].sort().map(([date, count]) => ({ date, count }));

    return {
      total: execs.length,
      truncated: execs.length >= 5000, // 5000행 상한 — 넘으면 집계가 최근 5000건만이라 화면이 알려야 한다(기간 좁히기 유도)
      protocols,
      trend,
      totalRejected: protocols.reduce((s, p) => s + p.rejected, 0),
      totalApproved: protocols.reduce((s, p) => s + p.approved, 0),
    };
  }

  /** HIS 의사 반려(REJECTED)된 Reflex add-on 목록 — 후속검사 취소/유지 판단용. */
  async listRejections() {
    const rejected = await this.prisma.interfaceLog.findMany({
      where: { ifId: 'IF-RX', direction: 'OUTBOUND', status: 'REJECTED' },
      orderBy: { createdDt: 'desc' },
      take: 200,
    });
    const mcids = rejected.map((r) => r.messageControlId).filter((x): x is string => !!x);
    const execs = mcids.length ? await this.prisma.reflexExecution.findMany({ where: { outboundMcid: { in: mcids } } }) : [];
    const execBy = new Map(execs.map((e) => [e.outboundMcid, e]));
    // 오더항목·결과 존재 여부를 일괄 조회(N+1 제거 — 종전 행당 2쿼리×200건).
    const pairs = execs.map((e) => ({ orderId: e.orderId, testCode: e.addTestCode }));
    const [items, resultRows] = pairs.length
      ? await Promise.all([
          this.prisma.orderItem.findMany({ where: { OR: pairs }, select: { orderId: true, testCode: true, status: true } }),
          this.prisma.result.findMany({
            where: { OR: pairs.map((p) => ({ specimen: { orderId: p.orderId }, testCode: p.testCode })) },
            select: { testCode: true, specimen: { select: { orderId: true } } },
          }),
        ])
      : [[], []];
    const itemBy = new Map(items.map((i) => [`${i.orderId}|${i.testCode}`, i.status]));
    const resultedSet = new Set(resultRows.map((r) => `${r.specimen.orderId}|${r.testCode}`));
    const out = [];
    for (const r of rejected) {
      const e = r.messageControlId ? execBy.get(r.messageControlId) : undefined;
      const key = e ? `${e.orderId}|${e.addTestCode}` : null;
      const itemStatus = key ? itemBy.get(key) ?? null : null;
      const resulted = key != null && itemStatus != null && resultedSet.has(key);
      out.push({
        mcid: r.messageControlId, rejectedDt: r.createdDt,
        protocolName: e?.protocolName ?? null, orderId: e?.orderId ?? null,
        addTestCode: e?.addTestCode ?? null, patientId: e?.patientId ?? null,
        itemStatus, resulted,
      });
    }
    return out;
  }

  /** 반려 해소 — 후속검사 취소(orderItem CANCELLED) 또는 유지. 감사·이력 기록. */
  async resolveRejection(mcid: string, action: 'cancel' | 'keep', actor?: string) {
    const e = await this.prisma.reflexExecution.findFirst({ where: { outboundMcid: mcid } });
    if (!e) throw new NotFoundException(`반려 대상 없음: ${mcid}`);
    if (action === 'cancel') {
      const item = await this.prisma.orderItem.findFirst({ where: { orderId: e.orderId, testCode: e.addTestCode } });
      if (item) await this.prisma.orderItem.update({ where: { orderItemId: item.orderItemId }, data: { status: 'CANCELLED' } });
      await this.prisma.interfaceLog.updateMany({ where: { direction: 'OUTBOUND', messageControlId: mcid }, data: { status: 'REJECTED_CANCELLED', errorText: `취소 by ${actor ?? '?'}` } });
    } else {
      await this.prisma.interfaceLog.updateMany({ where: { direction: 'OUTBOUND', messageControlId: mcid }, data: { status: 'REJECTED_KEPT', errorText: `유지 by ${actor ?? '?'}` } });
    }
    return { mcid, action };
  }

  async list(status?: string) {
    return this.prisma.reflexProtocol.findMany({
      where: status ? { status } : undefined,
      orderBy: [{ status: 'asc' }, { createdDt: 'desc' }],
      include: { _count: { select: { events: true } } },
    });
  }

  async get(protocolId: string) {
    const p = await this.prisma.reflexProtocol.findUnique({
      where: { protocolId },
      include: { events: { orderBy: { createdDt: 'desc' } } },
    });
    if (!p) throw new NotFoundException(`프로토콜 없음: ${protocolId}`);
    return p;
  }

  /** 실행 대상 — ACTIVE + 유효기간. 엔진(result.service)이 사용. */
  async activeFor(whenTestCode: string) {
    const today = new Date().toISOString().slice(0, 10);
    return this.prisma.reflexProtocol.findMany({
      where: {
        status: 'ACTIVE',
        whenTestCode,
        AND: [
          { OR: [{ effectiveFrom: null }, { effectiveFrom: { lte: today } }] },
          { OR: [{ effectiveTo: null }, { effectiveTo: { gte: today } }] },
        ],
      },
    });
  }

  private validate(input: ReflexInput) {
    if (!input.name?.trim()) throw new BadRequestException('이름 필수');
    if (!input.whenTestCode?.trim()) throw new BadRequestException('트리거 검사코드 필수');
    if (!REFLEX_OPERATORS.includes(input.operator as never)) throw new BadRequestException(`연산자 오류: ${input.operator}`);
    const cmp = ['>=', '<=', '>', '<'].includes(input.operator);
    if (cmp && (input.threshold == null || Number.isNaN(input.threshold))) throw new BadRequestException('임계값 필수(비교 연산자)');
    if (input.operator === 'BETWEEN') {
      if (input.threshold == null || input.thresholdHigh == null) throw new BadRequestException('BETWEEN은 하한·상한 모두 필수');
      if (input.threshold > input.thresholdHigh) throw new BadRequestException('BETWEEN 하한이 상한보다 큼');
    }
    if (input.operator === 'FLAG' && !input.flag) throw new BadRequestException('플래그 필수(FLAG 연산자)');
    if (!input.addTestCodes?.trim()) throw new BadRequestException('후속검사 필수');
  }

  /**
   * 트리거·후속 검사코드가 마스터에 실재하는지 검증. 오타 코드는 실행 시 조용히 매칭 실패/무시돼
   * (result.service: 미등록 검사코드 무시) 프로토콜이 ACTIVE인데 한 번도 안 도는 상태가 된다 — 사전 차단.
   */
  private async assertTestCodesExist(input: ReflexInput) {
    const codes = [...new Set([input.whenTestCode.trim(), ...input.addTestCodes.split(',').map((s) => s.trim()).filter(Boolean)])];
    const found = await this.prisma.testMaster.findMany({ where: { testCode: { in: codes } }, select: { testCode: true } });
    const foundSet = new Set(found.map((f) => f.testCode));
    const missing = codes.filter((c) => !foundSet.has(c));
    if (missing.length) throw new BadRequestException(`마스터에 없는 검사코드: ${missing.join(', ')} — 반사검사가 실행되지 않습니다(코드 확인)`);
  }

  private async event(protocolId: string, event: string, actor?: string, note?: string) {
    await this.prisma.reflexProtocolEvent.create({ data: { eventId: genId('RPE'), protocolId, event, actor: actor ?? null, note: note ?? null } });
  }

  async create(input: ReflexInput, actor?: string) {
    this.validate(input);
    await this.assertTestCodesExist(input);
    // 계보(개정): 선행 프로토콜을 명시하면 그 위 버전으로 만든다(같은 트리거의 무관한 프로토콜을 오인 대체하지 않도록
    // 트리거 그룹이 아니라 **명시 포인터**로 계보를 잡는다). lineageId(계보 뿌리 id)를 물려받아, 활성화 시
    // 같은 계보의 다른 활성본을 세대·분기 무관하게 전량 SUPERSEDED로 접는다(단일 레벨 매칭의 분기 누락 방지).
    const protocolId = genId('RP');
    let version = 1;
    let supersedesProtocolId: string | null = null;
    let lineageId = protocolId; // 뿌리는 자기 자신이 계보
    if (input.supersedesProtocolId?.trim()) {
      const pred = await this.prisma.reflexProtocol.findUnique({ where: { protocolId: input.supersedesProtocolId.trim() } });
      if (!pred) throw new BadRequestException(`대체 대상(선행) 프로토콜 없음: ${input.supersedesProtocolId}`);
      if (pred.status === 'SUPERSEDED' || pred.status === 'RETIRED') {
        throw new BadRequestException(`이미 대체/폐기된 프로토콜은 선행으로 지정 불가(${pred.protocolId}: ${pred.status})`);
      }
      // 계보=같은 트리거 검사여야 한다 — 무관한(다른 트리거) 프로토콜을 선행으로 지정해 조용히 폐기시키는 것 차단.
      if (pred.whenTestCode !== input.whenTestCode) {
        throw new BadRequestException(`선행과 트리거 검사코드가 달라 계보로 볼 수 없음(선행 ${pred.whenTestCode} ≠ ${input.whenTestCode})`);
      }
      supersedesProtocolId = pred.protocolId;
      version = (pred.version ?? 1) + 1;
      lineageId = pred.lineageId ?? pred.protocolId; // 뿌리의 계보를 승계
    }
    const p = await this.prisma.reflexProtocol.create({
      data: {
        protocolId,
        name: input.name,
        version,
        supersedesProtocolId,
        lineageId,
        whenTestCode: input.whenTestCode,
        operator: input.operator,
        threshold: input.threshold ?? null,
        thresholdHigh: input.thresholdHigh ?? null,
        flag: input.flag ?? null,
        addTestCodes: input.addTestCodes,
        priority: input.priority ?? null,
        effectiveFrom: input.effectiveFrom ?? null,
        effectiveTo: input.effectiveTo ?? null,
        createdBy: actor ?? null,
        status: 'DRAFT',
        events: { create: { eventId: genId('RPE'), event: 'CREATE', actor: actor ?? null, note: supersedesProtocolId ? `개정 v${version}(선행 ${supersedesProtocolId})` : null } },
      },
    });
    return p;
  }

  async update(protocolId: string, input: ReflexInput, actor?: string) {
    const p = await this.get(protocolId);
    if (!EDITABLE.includes(p.status)) throw new BadRequestException(`편집 불가 상태(${p.status}) — 초안/반려만 수정 가능`);
    this.validate(input);
    await this.assertTestCodesExist(input);
    const updated = await this.prisma.reflexProtocol.update({
      where: { protocolId },
      data: {
        name: input.name, whenTestCode: input.whenTestCode, operator: input.operator,
        threshold: input.threshold ?? null, thresholdHigh: input.thresholdHigh ?? null, flag: input.flag ?? null,
        addTestCodes: input.addTestCodes, priority: input.priority ?? null,
        effectiveFrom: input.effectiveFrom ?? null, effectiveTo: input.effectiveTo ?? null,
        status: p.status === 'REJECTED' ? 'DRAFT' : p.status, // 반려분 수정 시 초안으로
      },
    });
    await this.event(protocolId, 'EDIT', actor);
    return updated;
  }

  // ── 승인 라이프사이클 전이 ──
  private async transition(protocolId: string, from: string[], to: string, event: string, actor?: string, note?: string, extra: Record<string, unknown> = {}) {
    const p = await this.get(protocolId);
    if (!from.includes(p.status)) throw new BadRequestException(`전이 불가: 현재 ${p.status} → ${to} (허용 이전상태: ${from.join('/')})`);
    const updated = await this.prisma.reflexProtocol.update({ where: { protocolId }, data: { status: to, ...extra } });
    await this.event(protocolId, event, actor, note);
    return updated;
  }

  submit(id: string, actor?: string) { return this.transition(id, ['DRAFT'], 'PENDING_SPECIALIST', 'SUBMIT', actor); }
  // 직무분리(four-eyes): 전문의 승인자는 작성자와 달라야 함
  async specialistApprove(id: string, actor?: string, note?: string) {
    const p = await this.get(id);
    if (actor && p.createdBy && actor === p.createdBy) throw new BadRequestException('직무분리: 작성자는 전문의 승인 불가(다른 전문의 승인 필요)');
    return this.transition(id, ['PENDING_SPECIALIST'], 'PENDING_COMMITTEE', 'SPECIALIST_APPROVE', actor, note, { specialistBy: actor ?? null, specialistDt: new Date() });
  }
  reject(id: string, actor?: string, note?: string) {
    return this.transition(id, ['PENDING_SPECIALIST', 'PENDING_COMMITTEE', 'PENDING_HIS'], 'REJECTED', 'REJECT', actor, note);
  }
  // 직무분리: 위원회 의결자는 전문의 승인자·작성자와 달라야 함
  async committee(id: string, committeeNo: string, actor?: string) {
    if (!committeeNo?.trim()) throw new BadRequestException('위원회 의결번호 필수');
    const p = await this.get(id);
    if (actor && p.specialistBy && actor === p.specialistBy) throw new BadRequestException('직무분리: 전문의 승인자는 위원회 의결 기록 불가');
    if (actor && p.createdBy && actor === p.createdBy) throw new BadRequestException('직무분리: 작성자는 위원회 의결 기록 불가');
    return this.transition(id, ['PENDING_COMMITTEE'], 'PENDING_HIS', 'COMMITTEE', actor, `의결번호 ${committeeNo}`, { committeeNo, committeeDt: new Date() });
  }
  /**
   * HIS 등록·수용 확인 → ACTIVE. hisRef(등록ID/회신) 기록.
   * 계보(개정) 활성화 시 **같은 계보(lineageId)의 다른 활성/보류본을 세대·분기 무관하게 전량** SUPERSEDED로
   * 접는다 — 활성만 되고 폐기가 실패하면 같은 계보의 둘이 반사오더를 중복 발동하므로 반드시 한 트랜잭션.
   * 계보 단위 advisory lock으로 동시 활성화(형제 개정) 경합도 직렬화 → "계보당 활성 1개" 불변식 보장.
   */
  async activate(id: string, hisRef: string, actor?: string) {
    const p = await this.get(id);
    if (p.status !== 'PENDING_HIS') throw new BadRequestException(`전이 불가: 현재 ${p.status} → ACTIVE (허용 이전상태: PENDING_HIS)`);
    const lineage = p.lineageId ?? id;
    return this.prisma.$transaction(async (tx) => {
      // 같은 계보의 활성화를 직렬화(형제 동시활성 TOCTOU 방지). 다른 계보는 다른 락이라 무경합.
      // ★$executeRaw 사용 — pg_advisory_xact_lock은 void 반환이라 $queryRaw는 역직렬화 실패.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lineage}))`;
      // 조건부 원자 전이(그사이 상태가 바뀌었으면 count 0) — 같은 id 동시 활성화 이중처리 방지.
      const claim = await tx.reflexProtocol.updateMany({ where: { protocolId: id, status: 'PENDING_HIS' }, data: { status: 'ACTIVE', hisRef: hisRef || 'MANUAL' } });
      if (claim.count === 0) throw new ConflictException('그사이 프로토콜 상태가 바뀌었습니다(PENDING_HIS 아님) — 새로고침');
      await tx.reflexProtocolEvent.create({ data: { eventId: genId('RPE'), protocolId: id, event: 'ACTIVATE', actor: actor ?? null, note: hisRef ? `HIS ${hisRef}` : null } });
      // 계보 붕괴: 같은 lineageId의 다른 활성/보류본 전량 SUPERSEDED(뿌리·형제·구세대 모두).
      const targets = await tx.reflexProtocol.findMany({
        where: { lineageId: lineage, protocolId: { not: id }, status: { in: ['ACTIVE', 'SUSPENDED'] } },
        select: { protocolId: true },
      });
      for (const t of targets) {
        await tx.reflexProtocol.update({ where: { protocolId: t.protocolId }, data: { status: 'SUPERSEDED' } });
        await tx.reflexProtocolEvent.create({ data: { eventId: genId('RPE'), protocolId: t.protocolId, event: 'SUPERSEDE', actor: actor ?? null, note: `${id}(v${p.version})로 대체` } });
      }
      return tx.reflexProtocol.findUnique({ where: { protocolId: id } });
    });
  }
  suspend(id: string, actor?: string, note?: string) { return this.transition(id, ['ACTIVE'], 'SUSPENDED', 'SUSPEND', actor, note); }
  resume(id: string, actor?: string) { return this.transition(id, ['SUSPENDED'], 'ACTIVE', 'ACTIVATE', actor); }
  retire(id: string, actor?: string, note?: string) { return this.transition(id, ['DRAFT', 'REJECTED', 'ACTIVE', 'SUSPENDED', 'PENDING_SPECIALIST', 'PENDING_COMMITTEE', 'PENDING_HIS'], 'RETIRED', 'RETIRE', actor, note); }
}
