/**
 * PatientService — patient 도메인 서비스.
 *
 * 주요 진입점: `findAll()`, `findOne()`, `create()`, `update()`, `merge()`
 * 일부 경로는 트랜잭션으로 묶인다 — 부분 반영 시 임상 상태가 깨지는 구간.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CreatePatientDto, UpdatePatientDto } from './dto/patient.dto';
import { maskName } from '../../common/privacy.util';

@Injectable()
export class PatientService {
  constructor(private readonly prisma: PrismaService) {}

  /** 환자 검색(브라우즈) — 성명은 서버에서 마스킹(PHI 최소열람). 검색은 원문 질의로 매칭. */
  async findAll(q?: string, from?: string, to?: string, page = 0) {
    const s = q?.trim();
    // 병합(MERGED) 레코드는 브라우즈·성명검색에서 제외. 환자ID 검색으로만 노출(구 MRN 추적용).
    const nameOrId = s
      ? { OR: [
          { patientId: { contains: s } }, // 환자ID(구 MRN) 검색은 MERGED 포함
          { AND: [{ name: { contains: s } }, { status: { not: 'MERGED' } }] }, // 성명 검색은 MERGED 제외
        ] }
      : { status: { not: 'MERGED' } };
    // 기간 필터 — 해당 기간에 오더(검사) 활동이 있는 환자만(일자별 워크리스트). to는 그날 끝까지 포함.
    const conds: object[] = [nameOrId];
    if (from || to) {
      conds.push({
        orders: { some: { orderDt: {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lt: new Date(new Date(to).getTime() + 86400000) } : {}),
        } } },
      });
    }
    // 100건 초과 시 탭(페이지) 분할 — total 반환해 웹이 페이지 탭 렌더.
    const PAGE = 100;
    const p = Math.max(0, page);
    const where = { AND: conds };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.patient.count({ where }),
      this.prisma.patient.findMany({ where, orderBy: { patientId: 'asc' }, skip: p * PAGE, take: PAGE }),
    ]);
    return { total, page: p, pageSize: PAGE, rows: rows.map((r) => ({ ...r, name: maskName(r.name) })) };
  }

  /**
   * 환자 상세 — 방문·오더(항목 포함).
   *
   * ★상한(2026-07-30 성능 검토): 장기 환자는 방문·오더가 수백 건까지 쌓인다. 무제한 include는
   *   응답을 키울 뿐 아니라, 화면이 **오더마다 완결도 API를 한 번씩 호출**하므로 그대로 요청 폭증이
   *   된다(오더 300건 = HTTP 300회). 최근 것부터 자르고 잘렸음을 알린다 — 전체 이력은 오더 화면에서 본다.
   */
  async findOne(patientId: string) {
    const LIMIT = 100;
    const [patient, orderTotal, visitTotal] = await Promise.all([
      this.prisma.patient.findUnique({
        where: { patientId },
        include: {
          visits: { orderBy: { visitId: 'desc' }, take: LIMIT },
          orders: { include: { items: true }, orderBy: [{ orderDt: 'desc' }, { orderId: 'desc' }], take: LIMIT },
        },
      }),
      this.prisma.labOrder.count({ where: { patientId } }),
      this.prisma.visit.count({ where: { patientId } }),
    ]);
    if (!patient) throw new NotFoundException(`환자를 찾을 수 없습니다: ${patientId}`);
    return {
      ...patient,
      orderTotal,
      visitTotal,
      ordersTruncated: orderTotal > patient.orders.length,
      visitsTruncated: visitTotal > patient.visits.length,
    };
  }

  async create(dto: CreatePatientDto) {
    return this.prisma.patient.create({ data: dto });
  }

  /** 환자 인적정보 정정 — 성별·생년 오타는 참고치 오분류로 이어지므로 수정 경로 필수. */
  async update(patientId: string, dto: UpdatePatientDto) {
    const p = await this.prisma.patient.findUnique({ where: { patientId } });
    if (!p) throw new NotFoundException(`환자 없음: ${patientId}`);
    return this.prisma.patient.update({
      where: { patientId },
      data: { name: dto.name ?? undefined, sex: dto.sex ?? undefined, birthDate: dto.birthDate ?? undefined },
    });
  }

  /**
   * 환자 병합 — 중복 등록(source)의 임상 레코드를 정본(target)으로 이관하고 source를 MERGED 처리.
   * 이관 대상: 내원·오더(→유전체 포함)·병리·교차·출고·혈액형·수혈시행/반응·Reflex. 이력 보존 위해 source는 삭제하지 않음.
   */
  async merge(targetId: string, sourceId: string) {
    if (targetId === sourceId) throw new BadRequestException('동일 환자는 병합할 수 없습니다');
    const [target, source] = await Promise.all([
      this.prisma.patient.findUnique({ where: { patientId: targetId } }),
      this.prisma.patient.findUnique({ where: { patientId: sourceId } }),
    ]);
    if (!target) throw new NotFoundException(`정본 환자 없음: ${targetId}`);
    if (!source) throw new NotFoundException(`병합 대상(source) 환자 없음: ${sourceId}`);
    if (source.status === 'MERGED') throw new BadRequestException('이미 병합된 환자입니다');
    if (target.status === 'MERGED') throw new BadRequestException('정본(target)이 이미 병합된 환자입니다 — 브라우즈에서 숨겨진 레코드로 이관 금지');

    return this.prisma.$transaction(async (tx) => {
      const where = { where: { patientId: sourceId }, data: { patientId: targetId } };
      const moved = {
        visits: (await tx.visit.updateMany(where)).count,
        orders: (await tx.labOrder.updateMany(where)).count,
        pathologyCases: (await tx.pathologyCase.updateMany(where)).count,
        crossmatches: (await tx.crossmatch.updateMany(where)).count,
        bloodIssues: (await tx.bloodIssue.updateMany(where)).count,
        bloodTypings: (await tx.bloodTyping.updateMany(where)).count,
        transfusionReqs: (await tx.patientTransfusionReq.updateMany(where)).count,
        transfusionActs: (await tx.transfusionAct.updateMany(where)).count,
        transfusionReactions: (await tx.transfusionReaction.updateMany(where)).count,
        reflexExecutions: (await tx.reflexExecution.updateMany(where)).count,
        // ★아래 4종은 누락돼 있었다(2026-07-29 발견). 전부 실제 영향이 있다:
        //   청구 2종을 안 옮기면 **잘못된 환자로 청구**되고(이미 캡처된 항목이 구 환자ID로 전송된다),
        //   위험치 통보·법정감염병 신고를 안 옮기면 **환자별 이력 조회에서 빠져** 임상 소명·신고
        //   추적이 끊긴다. 병합의 목적이 "한 사람의 기록을 한 곳으로"인데 그게 절반만 됐던 것.
        billingItems: (await tx.billingItem.updateMany(where)).count,
        billingClaims: (await tx.billingClaim.updateMany(where)).count,
        criticalNotifies: (await tx.criticalNotify.updateMany(where)).count,
        infectiousReports: (await tx.infectiousReport.updateMany(where)).count,
      };
      await tx.patient.update({ where: { patientId: sourceId }, data: { status: 'MERGED', mergedInto: targetId } });
      return { target: targetId, source: sourceId, moved };
    });
  }
}
