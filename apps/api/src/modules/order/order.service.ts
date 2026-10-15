/**
 * OrderService — order 도메인 서비스.
 *
 * 주요 진입점: `findAll()`, `summary()`, `exportOrders()`, `findOne()`, `createOrder()`, `listDowntimePending()`, `reconcileHisOrderNo()`, `addOnTests()`…
 * 일부 경로는 트랜잭션으로 묶인다 — 부분 반영 시 임상 상태가 깨지는 구간.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { OrderStatus, SpecimenStatus } from '@prisma/client';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { ReceiveSpecimenDto, RejectSpecimenDto, CreateAliquotsDto } from './dto/order.dto';
import { buildZplLabel } from '../../domain/label';
import { pickReferenceRange, calcAge, RefRange, Sex } from '../../domain/result-evaluation';
import { nextSuffixSeq, formatSeq } from '../../domain/numbering';
import { genId } from '../../common/id.util';
import { isUniqueViolation } from '../../common/prisma-error.util';

const REJECT_REASONS = ['HEMOLYZED', 'INSUFFICIENT', 'CLOTTED', 'CONTAMINATED', 'OTHER'];

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);
  constructor(private readonly prisma: PrismaService) {}

  /**
   * orderDt 범위 필터 — 날짜(YYYY-MM-DD)는 서버 로컬(Asia/Seoul) 당일 경계로 정규화.
   * from → 해당일 00:00:00.000, to → 해당일 23:59:59.999. 시각 포함 ISO는 그대로 사용.
   */
  private dateRange(from?: string, to?: string): { gte?: Date; lte?: Date } | undefined {
    const bound = (s: string, end: boolean): Date | null => {
      const d = new Date(s);
      if (isNaN(d.getTime())) return null;
      if (!s.includes('T')) { if (end) d.setHours(23, 59, 59, 999); else d.setHours(0, 0, 0, 0); } // 날짜-only만 경계 정규화
      return d;
    };
    const r: { gte?: Date; lte?: Date } = {};
    if (from) { const d = bound(from, false); if (d) r.gte = d; }
    if (to) { const d = bound(to, true); if (d) r.lte = d; }
    return r.gte || r.lte ? r : undefined;
  }

  private listWhere(status?: string, from?: string, to?: string) {
    // 맨 쿼리스트링을 Prisma enum에 직행시키지 않는다 — 오타면 500이 아니라 400으로 알린다(Q7)
    if (status && !(status in OrderStatus)) {
      throw new BadRequestException(`status는 ${Object.keys(OrderStatus).join('/')} 중 하나: ${status}`);
    }
    const dt = this.dateRange(from, to);
    return {
      ...(status ? { status: status as OrderStatus } : {}),
      ...(dt ? { orderDt: dt } : {}),
    };
  }

  async findAll(status?: string, skip = 0, take = 50, from?: string, to?: string) {
    const where = this.listWhere(status, from, to);
    const t = Math.min(Math.max(take, 1), 100); // 대량 방지: 최대 100
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.labOrder.count({ where }),
      this.prisma.labOrder.findMany({
        where,
        // 데이터 최소화: 목록에 필요한 환자 필드만 투영한다(include: true는 Patient 행 전체를 노출).
        include: {
          patient: { select: { patientId: true, name: true } },
          provider: true,
          items: { include: { test: true } },
        },
        orderBy: { orderDt: 'desc' },
        skip: Math.max(skip, 0),
        take: t,
      }),
    ]);
    return { total, count: rows.length, skip, take: t, rows };
  }

  /** 기간별 처리 현황 요약 — 총 건수 + 상태 분포(관리 리포트). */
  async summary(status?: string, from?: string, to?: string) {
    const where = this.listWhere(status, from, to);
    const total = await this.prisma.labOrder.count({ where });
    const grouped = await this.prisma.labOrder.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
      orderBy: { status: 'asc' },
    });
    const byStatus: Record<string, number> = {};
    for (const g of grouped) byStatus[g.status] = g._count?._all ?? 0;
    const statCount = await this.prisma.labOrder.count({ where: { ...where, priority: 'S' as never } });
    return { total, byStatus, statCount, from: from ?? null, to: to ?? null };
  }

  /** 기간 오더 평면 내보내기(CSV용) — 페이지네이션 없이 최대 5000건. 초과 시 truncated 표시. */
  async exportOrders(status?: string, from?: string, to?: string) {
    const CAP = 5000;
    const where = this.listWhere(status, from, to);
    const total = await this.prisma.labOrder.count({ where });
    const rows = await this.prisma.labOrder.findMany({
      where,
      include: {
        patient: { select: { patientId: true, name: true } },
        provider: true,
        items: { include: { test: true } },
      },
      orderBy: { orderDt: 'desc' },
      take: CAP,
    });
    return {
      total,
      truncated: total > CAP,
      rows: rows.map((o) => ({
        orderId: o.orderId,
        hisOrderNo: o.hisOrderNo ?? '',
        orderDt: o.orderDt ? o.orderDt.toISOString() : '',
        patientId: o.patient?.patientId ?? '',
        patientName: o.patient?.name ?? '',
        orderingProvider: o.orderingProvider ?? '',
        orderingProviderName: o.provider?.name ?? '',
        priority: o.priority,
        status: o.status,
        tests: o.items.map((it) => it.test?.name ?? it.testCode).join('; '),
      })),
    };
  }

  async findOne(orderId: string) {
    const order = await this.prisma.labOrder.findUnique({
      where: { orderId },
      include: { patient: true, provider: true, items: { include: { test: true } }, specimens: true },
    });
    if (!order) throw new NotFoundException(`오더를 찾을 수 없습니다: ${orderId}`);
    return order;
  }

  /**
   * LIS 자체 오더 생성(C3) — 수기·add-on·다운타임(HIS 오프라인) 접수 경로.
   * 현재 오더는 HIS 폴링/HL7만 유입 → HIS 다운 시 수기 접수 불가하던 것 해소.
   * hisOrderNo=null(LIS 기원). 다운타임 신규 환자는 이름으로 즉석 생성 후 HIS 대사(사후).
   */
  async createOrder(dto: { patientId: string; patientName?: string; testCodes: string[]; orderingProvider?: string; priority?: string; downtime?: boolean; downtimeReason?: string }) {
    if (!dto.testCodes?.length) throw new BadRequestException('검사코드 1개 이상 필요');
    const patient = await this.prisma.patient.findUnique({ where: { patientId: dto.patientId } });
    if (!patient) {
      if (!dto.patientName) throw new BadRequestException('미등록 환자 — 다운타임 수기 오더는 환자명(patientName) 필요');
      await this.prisma.patient.create({ data: { patientId: dto.patientId, name: dto.patientName } });
    }
    // 동일 검사코드 중복 입력은 1항목으로(오더당 검사 유일 — order_item unique와 정합)
    const testCodes = [...new Set(dto.testCodes)];
    const tests = await this.prisma.testMaster.findMany({ where: { testCode: { in: testCodes } } });
    const valid = new Set(tests.map((t) => t.testCode));
    const missing = testCodes.filter((c) => !valid.has(c));
    if (missing.length) throw new BadRequestException(`미등록 검사코드: ${missing.join(', ')}`);
    if (dto.orderingProvider) {
      const prv = await this.prisma.provider.findUnique({ where: { providerId: dto.orderingProvider } });
      if (!prv) throw new BadRequestException(`미등록 처방의: ${dto.orderingProvider}`);
    }
    const priority: 'R' | 'S' = dto.priority === 'S' ? 'S' : 'R';
    const orderId = await this.generateOrderId();
    const order = await this.prisma.labOrder.create({
      data: {
        orderId,
        patientId: dto.patientId,
        hisOrderNo: null, // LIS 기원(HIS 미유입)
        // 다운타임(HIS 단절 중 접수)은 복구 후 HIS 대사 대상이라 별도 기원으로 표시한다.
        orderSource: dto.downtime === true ? 'DOWNTIME' : 'MANUAL',
        downtimeReason: dto.downtime === true ? (dto.downtimeReason ?? null) : null,
        orderingProvider: dto.orderingProvider ?? null,
        orderDt: new Date(),
        priority,
        status: 'RECEIVED',
        items: { create: testCodes.map((tc, i) => ({ orderItemId: `${orderId}-I${i + 1}`, testCode: tc, status: 'RECEIVED' })) },
      },
      include: { items: true },
    });
    return { order, lisOriginated: true, downtime: dto.downtime === true };
  }

  /**
   * 다운타임 오더 대사 대기 목록 — HIS 복구 후 hisOrderNo를 채워야 하는 건.
   * 이 목록이 없으면 다운타임 접수분이 HIS와 영영 연결되지 않아 청구·이력이 이원화된다.
   */
  async listDowntimePending() {
    const rows = await this.prisma.labOrder.findMany({
      where: { orderSource: 'DOWNTIME', hisOrderNo: null },
      orderBy: { orderDt: 'asc' },
      include: { patient: { select: { name: true } }, items: { select: { testCode: true } } },
    });
    return rows.map((o) => ({
      orderId: o.orderId,
      patientId: o.patientId,
      patientName: o.patient?.name ?? null,
      tests: o.items.map((i) => i.testCode),
      priority: o.priority,
      downtimeReason: o.downtimeReason,
      orderDt: o.orderDt,
      status: o.status,
    }));
  }

  /**
   * 다운타임 오더에 HIS 오더번호를 사후 연결(대사). HIS 복구 후 담당자가 수기 대조해 입력한다.
   *  - HIS 기원 오더(orderSource=HIS)는 대상 아님(이미 연결됨)
   *  - 같은 hisOrderNo가 다른 오더에 이미 연결됐으면 거부(이중 연결=청구 중복 위험)
   */
  async reconcileHisOrderNo(orderId: string, hisOrderNo: string, actor?: string) {
    const trimmed = (hisOrderNo ?? '').trim();
    if (!trimmed) throw new BadRequestException('HIS 오더번호를 입력하세요');
    const order = await this.prisma.labOrder.findUnique({ where: { orderId } });
    if (!order) throw new NotFoundException(`오더 없음: ${orderId}`);
    if (order.orderSource !== 'DOWNTIME') throw new BadRequestException(`다운타임 오더만 대사 대상입니다(현재 기원 ${order.orderSource})`);
    if (order.hisOrderNo) throw new BadRequestException(`이미 대사됨(HIS ${order.hisOrderNo})`);
    const dup = await this.prisma.labOrder.findFirst({ where: { hisOrderNo: trimmed, NOT: { orderId } } });
    if (dup) throw new BadRequestException(`HIS 오더번호 ${trimmed}는 이미 오더 ${dup.orderId}에 연결됨 — 중복 연결 불가`);
    const updated = await this.prisma.labOrder.update({
      where: { orderId },
      data: { hisOrderNo: trimmed, reconciledDt: new Date() },
    });
    this.logger.log(`다운타임 오더 대사: ${orderId} → HIS ${trimmed}${actor ? ` (${actor})` : ''}`);
    return { orderId, hisOrderNo: updated.hisOrderNo, reconciledDt: updated.reconciledDt };
  }

  /**
   * Add-on(추가 검사) — **기존 검체에 검사 항목을 추가**한다(P1-3).
   *
   * 이전에는 오더 생성이 항상 새 오더·새 검체번호를 만들어, 이미 채취·접수된 검체가 있어도
   * 추가 검사를 붙일 수 없었다 → 실무상 **재채취**를 유도(환자 재천자·지연). Add-on은 같은
   * 검체(specimen)의 오더에 order_item을 더해 재채취 없이 추가 검사를 돌린다.
   *
   * 검체 잔량·물리 적합성은 시스템이 알 수 없으므로 **하드블록하지 않고 경고**만 낸다:
   *  - 검체종류 불일치(예: 혈청 검체에 전혈 요구 검사) → 경고(검사자가 재채취 판단)
   *  - 이미 오더에 있는 검사(취소분 제외) → 스킵하고 그 사실을 보고
   * 반려·폐기된 검체에는 붙일 수 없다(그 검체로는 검사 불가).
   */
  async addOnTests(specimenNo: string, testCodes: string[]) {
    if (!testCodes?.length) throw new BadRequestException('추가할 검사코드 1개 이상 필요');
    const specimen = await this.prisma.specimen.findUnique({
      where: { specimenNo },
      include: { order: { include: { items: true } } },
    });
    if (!specimen) throw new NotFoundException(`검체 없음: ${specimenNo}`);
    if (specimen.status === 'REJECTED' || specimen.status === 'DISPOSED') {
      throw new BadRequestException(`추가 불가 — 검체 상태 ${specimen.status}(반려/폐기). 재채취가 필요합니다`);
    }
    if (specimen.order.status === 'CANCELLED') {
      throw new BadRequestException('추가 불가 — 취소된 오더입니다. 신규 오더로 접수하세요');
    }

    const tests = await this.prisma.testMaster.findMany({ where: { testCode: { in: testCodes } } });
    const validMap = new Map(tests.map((t) => [t.testCode, t]));
    const missing = testCodes.filter((c) => !validMap.has(c));
    if (missing.length) throw new BadRequestException(`미등록 검사코드: ${missing.join(', ')}`);

    // 이미 오더에 있는(취소 안 된) 검사는 중복 추가하지 않는다.
    const existing = new Set(specimen.order.items.filter((i) => i.status !== 'CANCELLED').map((i) => i.testCode));
    const toAdd = [...new Set(testCodes)].filter((c) => !existing.has(c));
    const skipped = [...new Set(testCodes)].filter((c) => existing.has(c));

    // 검체종류 적합성 경고(하드블록 아님) — 검사 마스터 specimenType과 실제 검체종류 대조.
    const warnings: string[] = [];
    for (const c of toAdd) {
      const need = validMap.get(c)?.specimenType;
      if (need && specimen.specimenType && need !== specimen.specimenType) {
        warnings.push(`${c}: 권장 검체종류 ${need} ≠ 현재 ${specimen.specimenType}(적합성 확인 필요)`);
      }
    }

    if (toAdd.length === 0) {
      return { specimenNo, orderId: specimen.orderId, added: [], skipped, warnings, message: '추가할 신규 검사가 없습니다(전부 기존 오더에 존재)' };
    }

    // 취소됐던 동일 검사는 새 행이 아니라 **기존 행 재활성화**(오더당 검사 유일 제약과 정합)
    const cancelledByCode = new Map(specimen.order.items.filter((i) => i.status === 'CANCELLED').map((i) => [i.testCode, i.orderItemId]));
    const toReactivate = toAdd.filter((c) => cancelledByCode.has(c));
    const toCreate = toAdd.filter((c) => !cancelledByCode.has(c));

    // order_item 인덱스는 기존 최대 뒤로 — `${orderId}-I${n}` 규칙 유지(중복 PK 방지).
    const maxIdx = specimen.order.items.reduce((m, it) => {
      const n = Number((it.orderItemId.split('-I').pop() ?? '0'));
      return Number.isFinite(n) && n > m ? n : m;
    }, 0);
    await this.prisma.$transaction([
      ...(toReactivate.length
        ? [this.prisma.orderItem.updateMany({
            where: { orderItemId: { in: toReactivate.map((c) => cancelledByCode.get(c)!) } },
            data: { status: 'RECEIVED' },
          })]
        : []),
      ...(toCreate.length
        ? [this.prisma.orderItem.createMany({
            data: toCreate.map((tc, i) => ({ orderItemId: `${specimen.orderId}-I${maxIdx + i + 1}`, orderId: specimen.orderId, testCode: tc, status: 'RECEIVED' })),
          })]
        : []),
    ]);
    // 오더가 완료/보고 상태였다면 추가 검사가 남았으므로 진행 상태로 되돌린다.
    if (specimen.order.status === 'COMPLETED' || specimen.order.status === 'REPORTED') {
      await this.prisma.labOrder.update({ where: { orderId: specimen.orderId }, data: { status: 'IN_PROCESS' } });
    }
    this.logger.log(`Add-on ${specimenNo}(오더 ${specimen.orderId}): +${toAdd.join(',')}${skipped.length ? ` (중복 스킵 ${skipped.join(',')})` : ''}`);
    return { specimenNo, orderId: specimen.orderId, added: toAdd, skipped, warnings };
  }

  /**
   * 검체 접수 — 바코드 채번·검체 생성, 오더/항목 상태 IN_PROCESS 전이.
   * 근거: 07 §2 (접수/분주)
   */
  async receiveSpecimen(dto: ReceiveSpecimenDto) {
    const order = await this.findOne(dto.orderId);

    // 동시 접수 경합 시 같은 번호를 뽑을 수 있다 → 유니크 위반이면 재채번(최대 3회)
    let specimen: Awaited<ReturnType<typeof this.prisma.specimen.create>> | undefined;
    let specimenNo = '';
    for (let attempt = 0; attempt < 3; attempt++) {
      specimenNo = await this.generateSpecimenNo();
      try {
        [specimen] = await this.prisma.$transaction([
          this.prisma.specimen.create({
            data: {
              specimenNo,
              orderId: order.orderId,
              containerCode: dto.containerCode ?? null,
              specimenType: dto.specimenType ?? null,
              collectedDt: dto.collectedDt ? new Date(dto.collectedDt) : null,
              collectedBy: dto.collectedBy ?? null,
              receivedDt: new Date(),
              status: 'RECEIVED',
            },
          }),
          this.prisma.labOrder.update({
            where: { orderId: order.orderId },
            data: { status: 'IN_PROCESS' },
          }),
          this.prisma.orderItem.updateMany({
            where: { orderId: order.orderId, status: { not: 'CANCELLED' } }, // 취소된 항목은 접수로 되살리지 않음
            data: { status: 'IN_PROCESS' },
          }),
        ]);
        break;
      } catch (e) {
        if (!isUniqueViolation(e) || attempt === 2) throw e;
      }
    }
    if (!specimen) throw new BadRequestException('검체번호 채번 실패 — 재시도 필요');

    // 접수 시 분석기별 분주(Aliquot) 자동생성
    let aliquots: { aliquotNo: string; targetInstrument: string | null }[] = [];
    if (dto.aliquotTargets?.length) {
      aliquots = await this.createAliquots(specimenNo, { targets: dto.aliquotTargets });
    }
    return { ...specimen, aliquots };
  }

  /** 검체 분주(Aliquot) 생성 — 분석기별 자검체. aliquotNo = {검체}-A{n}. */
  async createAliquots(specimenNo: string, dto: CreateAliquotsDto) {
    const specimen = await this.prisma.specimen.findUnique({ where: { specimenNo } });
    if (!specimen) throw new NotFoundException(`검체 없음: ${specimenNo}`);
    if (specimen.status === 'REJECTED') throw new BadRequestException('거부된 검체는 분주할 수 없습니다');
    const existing = await this.prisma.aliquot.count({ where: { specimenNo } });
    const created = [];
    for (let i = 0; i < dto.targets.length; i++) {
      const aliquotNo = `${specimenNo}-A${existing + i + 1}`;
      created.push(
        await this.prisma.aliquot.create({
          data: { aliquotNo, specimenNo, targetInstrument: dto.targets[i], containerCode: specimen.containerCode },
        }),
      );
    }
    return created.map((a) => ({ aliquotNo: a.aliquotNo, targetInstrument: a.targetInstrument }));
  }

  /**
   * 검체 거부 — 부적합 사유 기록·상태 REJECTED. 필요 시 재채취 오더 생성.
   * 근거: 기획 22 §6-4, 인증(검체 거부 기준).
   */
  async rejectSpecimen(specimenNo: string, dto: RejectSpecimenDto) {
    if (!REJECT_REASONS.includes(dto.reason)) {
      throw new BadRequestException(`거부 사유코드 오류: ${dto.reason} (허용: ${REJECT_REASONS.join(', ')})`);
    }
    const specimen = await this.prisma.specimen.findUnique({
      where: { specimenNo },
      include: { order: { include: { items: true } } },
    });
    if (!specimen) throw new NotFoundException(`검체 없음: ${specimenNo}`);
    if (specimen.status === 'REJECTED') throw new BadRequestException('이미 거부된 검체입니다');

    await this.prisma.specimen.update({
      where: { specimenNo },
      data: { status: 'REJECTED', rejectReason: dto.reason, rejectedDt: new Date() },
    });

    /**
     * 검체 거부는 **재채취가 뒤따라야 완결**된다.
     * 재채취 오더는 아래에서 자동 생성되지만, 그것만으로는 "누가 다시 채취하러 가는가"가
     * 연결되지 않는다 — 오더는 목록 어딘가에 생길 뿐이고 병동·접수는 거부 사실을 모른다.
     * 그래서 사유와 함께 알림함에 올린다(매일 발생하는 업무라 경보 피로를 피해 warn 계열).
     */
    await this.prisma.notification
      .create({
        data: {
          notifyId: genId('NTF'),
          ntype: '검체거부',
          target: '접수·병동',
          message: `검체 ${specimenNo} 거부(${dto.reason}) — 환자 ${specimen.order.patientId}${dto.recollect !== false ? ' · 재채취 오더 생성됨' : ' · 재채취 없음'}`.slice(0, 500),
          createdDt: new Date(),
        },
      })
      .catch(() => undefined); // 알림 실패가 거부 처리를 막지 않는다

    // 재채취 오더 생성(원 오더의 검사항목 복제)
    let recollection: { orderId: string } | null = null;
    if (dto.recollect !== false) {
      const newOrderId = await this.generateOrderId();
      await this.prisma.labOrder.create({
        data: {
          orderId: newOrderId,
          patientId: specimen.order.patientId,
          hisOrderNo: specimen.order.hisOrderNo,
          priority: specimen.order.priority,
          status: 'RECEIVED', // 재채취 대기(신규 오더 기본 상태)
          items: {
            create: specimen.order.items.map((it, i) => ({
              orderItemId: `${newOrderId}-I${i + 1}`,
              testCode: it.testCode,
              status: 'RECEIVED',
            })),
          },
        },
      });
      recollection = { orderId: newOrderId };
    }
    return { specimenNo, status: 'REJECTED', reason: dto.reason, recollection };
  }

  /**
   * 오더 취소(P1-5) — 반려 후 포기한 재채취 오더 등을 접수 대기에서 제거한다.
   *
   * 이전에는 취소·보류 API가 없어 포기한 오더가 영구히 RECEIVED로 남고 DB 직접 수정 외엔 방법이
   * 없었다. 결과가 하나라도 있으면 취소하지 않는다(이미 검사가 진행됨 — 정정·개정 경로로).
   * 검체가 이미 접수된 오더도 막는다(검체 처리 흐름과 충돌 방지 — 검체 반려로 처리).
   */
  async cancelOrder(orderId: string, reason: string, actor?: string) {
    if (!reason?.trim()) throw new BadRequestException('취소 사유가 필요합니다');
    const order = await this.prisma.labOrder.findUnique({
      where: { orderId },
      include: { items: true, specimens: true },
    });
    if (!order) throw new NotFoundException(`오더 없음: ${orderId}`);
    if (order.status === 'CANCELLED') throw new BadRequestException('이미 취소된 오더입니다');
    if (order.status === 'COMPLETED' || order.status === 'REPORTED') {
      throw new BadRequestException(`완료/보고된 오더는 취소 불가(현재 ${order.status})`);
    }
    // 결과 존재 여부 — 검체를 거쳐 결과가 나왔으면 취소가 아니라 정정/개정 대상.
    const resultCount = await this.prisma.result.count({ where: { specimen: { orderId } } });
    if (resultCount > 0) throw new BadRequestException(`결과가 있는 오더는 취소 불가(${resultCount}건) — 정정/개정으로 처리하세요`);
    // 이미 접수된 검체가 있으면 검체 처리 흐름을 따른다(검체 반려).
    const activeSpec = order.specimens.filter((sp) => sp.status !== 'REJECTED' && sp.status !== 'DISPOSED');
    if (activeSpec.length > 0) throw new BadRequestException(`접수된 검체가 있는 오더는 취소 불가 — 검체 반려로 처리하세요(검체 ${activeSpec.map((s) => s.specimenNo).join(', ')})`);

    await this.prisma.$transaction([
      this.prisma.labOrder.update({ where: { orderId }, data: { status: 'CANCELLED', downtimeReason: order.downtimeReason } }),
      this.prisma.orderItem.updateMany({ where: { orderId, status: { notIn: ['CANCELLED', 'REPORTED'] as never } }, data: { status: 'CANCELLED' } }),
    ]);
    this.logger.log(`오더 취소 ${orderId}: ${reason}${actor ? ` (${actor})` : ''}`);
    return { orderId, status: 'CANCELLED', reason };
  }

  /**
   * 오더 보류/해제(P1-5) — 처방 확인 대기 등으로 접수를 잠시 멈춘다. HOLD는 워크리스트에서 빠지되
   * 취소와 달리 되돌릴 수 있다. 결과가 있으면 보류하지 않는다(이미 진행 중).
   */
  async setOrderHold(orderId: string, hold: boolean, reason?: string, actor?: string) {
    const order = await this.prisma.labOrder.findUnique({ where: { orderId } });
    if (!order) throw new NotFoundException(`오더 없음: ${orderId}`);
    if (hold) {
      if (order.status === 'CANCELLED' || order.status === 'COMPLETED' || order.status === 'REPORTED') {
        throw new BadRequestException(`보류 불가 상태: ${order.status}`);
      }
      const resultCount = await this.prisma.result.count({ where: { specimen: { orderId } } });
      if (resultCount > 0) throw new BadRequestException('결과가 있는 오더는 보류 불가');
      await this.prisma.labOrder.update({ where: { orderId }, data: { status: 'HOLD' } });
      this.logger.log(`오더 보류 ${orderId}: ${reason ?? ''}${actor ? ` (${actor})` : ''}`);
      return { orderId, status: 'HOLD', reason: reason ?? null };
    }
    if (order.status !== 'HOLD') throw new BadRequestException(`보류 상태가 아닙니다(현재 ${order.status})`);
    // 해제 시 검체 유무로 복귀 상태 결정(접수됐으면 IN_PROCESS, 아니면 RECEIVED).
    const specCount = await this.prisma.specimen.count({ where: { orderId, status: { notIn: ['REJECTED', 'DISPOSED'] as never } } });
    const back = specCount > 0 ? 'IN_PROCESS' : 'RECEIVED';
    await this.prisma.labOrder.update({ where: { orderId }, data: { status: back } });
    this.logger.log(`오더 보류해제 ${orderId} → ${back}${actor ? ` (${actor})` : ''}`);
    return { orderId, status: back };
  }

    /** 검체 라벨(ZPL) 생성 — 프린터 전송용. */
  async specimenLabel(specimenNo: string) {
    const specimen = await this.prisma.specimen.findUnique({
      where: { specimenNo },
      include: { order: { include: { patient: true, items: { include: { test: true } } } } },
    });
    if (!specimen) throw new NotFoundException(`검체 없음: ${specimenNo}`);
    const tests = specimen.order.items.map((it) => it.test.name).join(', ');
    const zpl = buildZplLabel({
      specimenNo,
      patientName: specimen.order.patient.name,
      patientId: specimen.order.patient.patientId,
      testSummary: tests || '(검사 없음)',
      collectedDt: specimen.collectedDt?.toISOString().slice(0, 16).replace('T', ' '),
    });
    return { specimenNo, zpl };
  }

  /** 검체 추적 타임라인 — 채취·접수·분주·결과·거부 이벤트를 시간순으로. */
  async specimenTimeline(specimenNo: string) {
    const specimen = await this.prisma.specimen.findUnique({
      where: { specimenNo },
      include: { aliquots: true, results: true, order: { include: { patient: true } } },
    });
    if (!specimen) throw new NotFoundException(`검체 없음: ${specimenNo}`);
    const events: { at: Date | null; event: string; detail: string }[] = [];
    if (specimen.collectedDt) events.push({ at: specimen.collectedDt, event: 'COLLECTED', detail: `채취 ${specimen.collectedBy ?? ''}`.trim() });
    if (specimen.receivedDt) events.push({ at: specimen.receivedDt, event: 'RECEIVED', detail: '접수' });
    for (const a of specimen.aliquots) events.push({ at: specimen.receivedDt, event: 'ALIQUOT', detail: `분주 ${a.aliquotNo}→${a.targetInstrument ?? ''}` });
    for (const r of specimen.results) events.push({ at: r.reportedDt, event: 'RESULT', detail: `${r.testCode}=${r.value ?? ''} [${r.verifyState}]` });
    if (specimen.rejectedDt) events.push({ at: specimen.rejectedDt, event: 'REJECTED', detail: `거부 ${specimen.rejectReason ?? ''}` });
    events.sort((a, b) => (a.at?.getTime() ?? 0) - (b.at?.getTime() ?? 0));
    return {
      specimenNo,
      status: specimen.status,
      specimen: {
        orderId: specimen.orderId,
        patientName: specimen.order?.patient?.name ?? '',
        containerCode: specimen.containerCode,
        collectedDt: specimen.collectedDt,
        collectedBy: specimen.collectedBy,
        rejectReason: specimen.rejectReason,
        hasResults: specimen.results.length > 0,
        aliquotCount: specimen.aliquots.length,
      },
      events,
    };
  }

  /** 접수 정정 — 용기·채취시각·채취자 수정. 결과 입력·거부 검체는 불가(무결성). */
  async correctReceipt(specimenNo: string, dto: { containerCode?: string; collectedDt?: string; collectedBy?: string }) {
    const specimen = await this.prisma.specimen.findUnique({ where: { specimenNo }, include: { results: true } });
    if (!specimen) throw new NotFoundException(`검체 없음: ${specimenNo}`);
    if (specimen.status === 'REJECTED') throw new BadRequestException('거부된 검체는 정정할 수 없습니다');
    if (specimen.results.length > 0) throw new BadRequestException('결과가 입력된 검체는 정정할 수 없습니다');
    // 용기 코드는 Container FK — 미등록 값은 500 대신 명확한 400
    if (dto.containerCode) {
      const c = await this.prisma.container.findUnique({ where: { containerCode: dto.containerCode } });
      if (!c) throw new BadRequestException(`등록되지 않은 용기 코드: ${dto.containerCode}`);
    }
    return this.prisma.specimen.update({
      where: { specimenNo },
      data: {
        ...(dto.containerCode !== undefined ? { containerCode: dto.containerCode || null } : {}),
        ...(dto.collectedDt !== undefined ? { collectedDt: dto.collectedDt ? new Date(dto.collectedDt) : null } : {}),
        ...(dto.collectedBy !== undefined ? { collectedBy: dto.collectedBy || null } : {}),
      },
    });
  }

  /** 접수 취소 — 오접수 되돌리기. RECEIVED·결과/배양 없음만. 검체·분주 삭제 후, 잔여 검체 없으면 오더 RECEIVED 복귀. */
  async cancelReceipt(specimenNo: string) {
    const specimen = await this.prisma.specimen.findUnique({
      where: { specimenNo },
      include: { results: true, cultures: true, attachments: { select: { attachmentId: true } } },
    });
    if (!specimen) throw new NotFoundException(`검체 없음: ${specimenNo}`);
    if (specimen.status !== 'RECEIVED') throw new BadRequestException(`접수 취소는 RECEIVED 상태만 가능(현재 ${specimen.status})`);
    if (specimen.results.length > 0) throw new BadRequestException('결과가 입력된 검체는 접수 취소할 수 없습니다');
    if (specimen.cultures.length > 0) throw new BadRequestException('배양이 진행된 검체는 접수 취소할 수 없습니다'); // FK(culture) 보호
    // ★첨부는 `onDelete: Cascade`라 검체를 지우면 **함께 삭제된다**. 장비 미연동 도메인에서는
    //   외부 결과지 PDF가 그 검사의 유일한 원본이므로, 남아 있으면 취소를 막는다(임상기록 소실 방지).
    if (specimen.attachments.length > 0) {
      throw new BadRequestException(
        `첨부 문서(${specimen.attachments.length}건)가 있는 검체는 접수 취소할 수 없습니다 — 첨부를 먼저 확인·삭제하세요`,
      );
    }
    // FK가 없어 캐스케이드로 정리되지 않고 고아가 되는 참조들. 존재하면 취소를 막는다.
    const [sendouts, molecular] = await Promise.all([
      this.prisma.sendout.count({ where: { specimenNo } }),
      this.prisma.molecularResult.count({ where: { specimenNo } }),
    ]);
    if (sendouts > 0) throw new BadRequestException(`외부위탁(${sendouts}건)이 있는 검체는 접수 취소할 수 없습니다`);
    if (molecular > 0) throw new BadRequestException(`분자검사 결과(${molecular}건)가 있는 검체는 접수 취소할 수 없습니다`);

    const others = await this.prisma.specimen.count({ where: { orderId: specimen.orderId, specimenNo: { not: specimenNo } } });
    // 이 오더의 유일한 검체면 오더/항목을 접수 전(RECEIVED)으로 복귀 — 단, 이미 취소된 항목은 되살리지 않음
    const revert = others === 0
      ? [
          this.prisma.labOrder.update({ where: { orderId: specimen.orderId }, data: { status: 'RECEIVED' as never } }),
          this.prisma.orderItem.updateMany({ where: { orderId: specimen.orderId, status: { not: 'CANCELLED' as never } }, data: { status: 'RECEIVED' as never } }),
        ]
      : [];
    try {
      await this.prisma.$transaction([
        this.prisma.aliquot.deleteMany({ where: { specimenNo } }),
        this.prisma.specimen.delete({ where: { specimenNo } }),
        ...revert,
      ]);
    } catch (e) {
      // 동시 이중 취소 등으로 이미 삭제된 경우. 단, 데드락·커넥션 오류도 같은 메시지가 되므로
      // 원인은 반드시 로그로 남긴다(과거 조사 시 원인 추적이 불가능했다).
      this.logger.error(`접수 취소 실패(${specimenNo}): ${e instanceof Error ? e.message : e}`);
      throw new BadRequestException('이미 취소되었거나 처리 중인 검체입니다');
    }
    return { specimenNo, cancelled: true, orderId: specimen.orderId, orderReverted: others === 0 };
  }

  /** 오더 완결도 — 항목별 보고 상태·부분보고 여부(일부만 보고됨). */
  async completeness(orderId: string) {
    const order = await this.prisma.labOrder.findUnique({
      where: { orderId },
      include: { items: { include: { test: true } } },
    });
    if (!order) throw new NotFoundException(`오더 없음: ${orderId}`);
    const active = order.items.filter((i) => i.status !== 'CANCELLED');
    const reported = active.filter((i) => i.status === 'REPORTED');
    // 검체번호 → 보고서 딥링크 근거(오더 1건에 다검체 가능)
    const specimens = await this.prisma.specimen.findMany({ where: { orderId }, select: { specimenNo: true }, orderBy: { specimenNo: 'asc' } });
    return {
      orderId,
      status: order.status,
      total: active.length,
      reported: reported.length,
      partial: reported.length > 0 && reported.length < active.length,
      complete: active.length > 0 && reported.length === active.length,
      specimenNos: specimens.map((s) => s.specimenNo),
      items: order.items.map((i) => ({ testCode: i.testCode, testName: i.test.name, status: i.status })),
    };
  }

  /**
   * 결과입력 컨텍스트 — 검체(바코드)로 환자·오더 검사항목·기존 결과를 로드.
   * 결과입력 화면이 항목별 그리드를 구성하는 데 사용.
   */
  async specimenEntry(specimenNo: string) {
    const specimen = await this.prisma.specimen.findUnique({
      where: { specimenNo },
      include: {
        order: { include: { patient: true, items: { include: { test: true } } } },
        results: { include: { test: true } },
      },
    });
    if (!specimen) throw new NotFoundException(`검체 없음: ${specimenNo}`);
    const latest = new Map<string, (typeof specimen.results)[number]>();
    for (const r of specimen.results) {
      const cur = latest.get(r.testCode);
      if (!cur || r.version > cur.version) latest.set(r.testCode, r);
    }
    // A5: 입력 시점 의사결정 맥락 — 참고치(성별·연령 매칭)·직전값
    const patient = specimen.order.patient;
    const codes = specimen.order.items.filter((it) => it.status !== 'CANCELLED').map((it) => it.testCode);
    const ranges = await this.prisma.referenceRange.findMany({ where: { testCode: { in: codes } } });
    // ★생일 경과까지 반영한 정본 나이(calcAge) — 제출 판정·보고서와 동일. 연도만 빼면 밴드 경계 근처에서
    //   화면 참고치와 실제 판정 참고치가 달라진다(표시≠판정).
    const age = calcAge(patient.birthDate);
    const byCode = new Map<string, RefRange[]>();
    for (const rr of ranges) {
      const list = byCode.get(rr.testCode) ?? [];
      list.push({ sex: rr.sex, ageMin: rr.ageMin, ageMax: rr.ageMax, low: rr.low, high: rr.high, panicLow: rr.panicLow, panicHigh: rr.panicHigh });
      byCode.set(rr.testCode, list);
    }
    const rangeBy = new Map<string, RefRange | null>();
    for (const [code, list] of byCode) rangeBy.set(code, pickReferenceRange(list, (patient.sex as Sex | null) ?? null, Number.isNaN(age) ? null : age));
    const prev = await this.prisma.result.findMany({
      where: { testCode: { in: codes }, verifyState: { in: ['VERIFIED', 'AUTO'] }, value: { not: null }, specimen: { order: { patientId: patient.patientId } }, NOT: { specimenNo } },
      orderBy: { reportedDt: 'desc' },
      select: { testCode: true, value: true, reportedDt: true },
    });
    const prevBy = new Map<string, string>();
    for (const p of prev) if (!prevBy.has(p.testCode) && p.value != null) prevBy.set(p.testCode, p.value);
    // 파생(계산)검사 — 오더 항목이 아니라 결과로 부착되므로 입력 그리드에 읽기전용으로 노출(입력 전 검토)
    const orderCodes = new Set(codes);
    const derived = [...latest.values()]
      .filter((r) => r.source === 'CALCULATED' && !orderCodes.has(r.testCode))
      .map((r) => ({ testCode: r.testCode, testName: r.test.name, unit: r.unit ?? r.test.unitUcum, value: r.value, flag: r.flag ?? null, verifyState: r.verifyState }));
    return {
      specimenNo,
      status: specimen.status,
      rejected: specimen.status === 'REJECTED',
      patient: { patientId: patient.patientId, name: patient.name },
      orderId: specimen.orderId,
      derived,
      items: specimen.order.items
        .filter((it) => it.status !== 'CANCELLED')
        .map((it) => {
          const r = latest.get(it.testCode);
          const rr = rangeBy.get(it.testCode);
          return {
            testCode: it.testCode,
            testName: it.test.name,
            unit: it.test.unitUcum,
            value: r?.value ?? null,
            flag: r?.flag ?? null,
            verifyState: r?.verifyState ?? null,
            holdReason: r?.holdReason ?? null,
            // 한쪽 경계만 있는 참고치(예: 상한만)도 표시 — 양쪽 다 있을 때만 보이면 판정엔 쓰는 경계가 화면엔 공백이었다.
            refRange: rr ? (rr.low != null && rr.high != null ? `${rr.low} ~ ${rr.high}` : rr.low != null ? `≥ ${rr.low}` : rr.high != null ? `≤ ${rr.high}` : '') : '',
            prevValue: prevBy.get(it.testCode) ?? null,
          };
        }),
    };
  }

  /** 결과입력 워크리스트 — 진행 중 검체 목록(항목·보고 진척). */
  /**
   * 결과입력 대기 검체 워크리스트.
   *
   * ★기본값이 'IN_PROCESS'였는데 **접수는 검체를 RECEIVED로 만들고 이후 IN_PROCESS로 바꾸는 코드가 없다**
   *   (IN_PROCESS를 쓰는 곳은 LabOrder·OrderItem뿐). 그래서 실사용에서 이 목록은 항상 비어 있었고,
   *   검사자는 바코드를 손에 든 검체만 처리할 수 있어 누락 검체를 발견할 수 없었다.
   *   status를 명시하면 그 상태만, 생략하면 처리 대기 상태(RECEIVED·IN_PROCESS)를 함께 보여준다.
   */
  async specimenWorklist(status?: string, take = 50) {
    // 오타 status가 500 또는 빈 워크리스트("대기 없음" 오판)로 새지 않게 검증(Q7)
    if (status && !(status in SpecimenStatus)) {
      throw new BadRequestException(`status는 ${Object.keys(SpecimenStatus).join('/')} 중 하나: ${status}`);
    }
    const specimens = await this.prisma.specimen.findMany({
      where: status ? { status: status as SpecimenStatus } : { status: { in: [SpecimenStatus.RECEIVED, SpecimenStatus.IN_PROCESS] } },
      include: { order: { include: { patient: true, items: true } } },
      orderBy: { receivedDt: 'desc' },
      take: Math.min(Math.max(take, 1), 100),
    });
    return specimens.map((s) => {
      const active = s.order.items.filter((i) => i.status !== 'CANCELLED');
      return {
        specimenNo: s.specimenNo,
        patientName: s.order.patient.name,
        patientId: s.order.patient.patientId,
        specimenType: s.specimenType,
        total: active.length,
        reported: active.filter((i) => i.status === 'REPORTED').length,
      };
    });
  }

  private async generateOrderId(): Promise<string> {
    return genId('O');
  }

  /**
   * 검체번호 채번: S + YYMMDD + 4자리 일련 (근거: 06 §6)
   * count+1이 아닌 **당일 최대값+1** — 삭제·경합에도 번호가 역행(재사용)하지 않는다.
   * 동시 접수 경합의 잔여 창은 호출부(receiveSpecimen)의 P2002 재채번으로 흡수.
   */
  private async generateSpecimenNo(): Promise<string> {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const prefix = `S${yy}${mm}${dd}`;
    const rows = await this.prisma.specimen.findMany({
      where: { specimenNo: { startsWith: prefix } },
      select: { specimenNo: true },
    });
    return formatSeq(prefix, nextSuffixSeq(rows.map((r) => r.specimenNo), prefix), 4);
  }
}
