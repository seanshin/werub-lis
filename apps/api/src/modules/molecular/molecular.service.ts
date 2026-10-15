/**
 * MolecularService — molecular 도메인 서비스.
 *
 * 주요 진입점: `listAssays()`, `upsertAssay()`, `deleteAssay()`, `interpretSuggest()`, `record()`, `listBySpecimen()`, `detectedRecent()`
 * 일부 경로는 트랜잭션으로 묶인다 — 부분 반영 시 임상 상태가 깨지는 구간.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { CatalogService } from '../catalog/catalog.service';
import { classifyNotifiable, classifyNotifiableFrom } from '../../domain/notifiable-disease';
import { DETECTIONS, MOL_STATUSES, validateCt, ctConsistencyWarning, ctEquivocalWarning, suggestInterpretation, CT_MIN, CT_MAX } from '../../domain/molecular';

/**
 * 분자진단/PCR 결과 파운데이션(D4, C-대) — 타깃·Ct·검출유무·정량 기록.
 * assay 카탈로그(`MolecularAssay`)에 패널별 타깃·Ct 컷오프를 등록하면 그 값으로 판정 보조를 한다
 * — 없으면 기본 컷오프(40)로 동작한다(카탈로그 없이도 결과 입력은 막지 않는다).
 * DETECTED가 법정감염병 타깃이면 기존 감염병 신고(InfectiousReport, B3)와 연동.
 */
@Injectable()
export class MolecularService {
  private readonly logger = new Logger(MolecularService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogService,
    private readonly events: EventEmitter2,
  ) {}


  // ── assay 카탈로그(패널별 타깃·Ct 판정 한계) ──
  listAssays(panelCode?: string) {
    return this.prisma.molecularAssay.findMany({
      where: panelCode ? { panelCode } : undefined,
      orderBy: [{ panelCode: 'asc' }, { target: 'asc' }],
    });
  }

  /**
   * assay 등록·수정. 키트 문서의 타깃·판정 한계를 검사실이 직접 넣는다.
   * 컷오프가 Ct 물리 범위를 벗어나거나 회색지대가 컷오프를 넘으면 판정이 뒤집히므로 막는다.
   */
  async upsertAssay(
    dto: { panelCode: string; target: string; assayName?: string; ctCutoff?: number | null; equivocalFrom?: number | null; note?: string },
    userId: string | null,
  ) {
    const panelCode = dto.panelCode?.trim();
    const target = dto.target?.trim();
    if (!panelCode) throw new BadRequestException('패널 코드 필요');
    if (!target) throw new BadRequestException('타깃 필요');
    for (const [label, v] of [['판정 한계(ctCutoff)', dto.ctCutoff], ['판정보류 시작(equivocalFrom)', dto.equivocalFrom]] as const) {
      if (v != null && (v < CT_MIN || v > CT_MAX)) throw new BadRequestException(`${label}는 ${CT_MIN}~${CT_MAX} 범위여야 합니다(입력: ${v})`);
    }
    // 회색지대가 컷오프보다 위면 구간이 성립하지 않는다(모든 값이 판정보류가 되거나 아무것도 안 걸린다)
    if (dto.equivocalFrom != null && dto.ctCutoff != null && dto.equivocalFrom >= dto.ctCutoff) {
      throw new BadRequestException(`판정보류 시작(${dto.equivocalFrom})은 판정 한계(${dto.ctCutoff})보다 작아야 합니다`);
    }
    const data = {
      assayName: dto.assayName?.trim() || null,
      ctCutoff: dto.ctCutoff ?? null,
      equivocalFrom: dto.equivocalFrom ?? null,
      note: dto.note?.trim() || null,
      updatedBy: userId,
    };
    return this.prisma.molecularAssay.upsert({
      where: { panelCode_target: { panelCode, target } },
      create: { panelCode, target, ...data },
      update: data,
    });
  }

  async deleteAssay(panelCode: string, target: string) {
    const found = await this.prisma.molecularAssay.findUnique({ where: { panelCode_target: { panelCode, target } } });
    if (!found) throw new NotFoundException(`assay 없음: ${panelCode}/${target}`);
    await this.prisma.molecularAssay.delete({ where: { panelCode_target: { panelCode, target } } });
    return { deleted: `${panelCode}/${target}` };
  }

  /** 판정 해석 제안(미리보기·DB 미기록) — 검출유무+Ct+assay 카탈로그로 초안. 확정은 검사자. */
  async interpretSuggest(dto: { target: string; detection: string; panelCode?: string; ct?: number }) {
    const assay = dto.panelCode
      ? await this.prisma.molecularAssay.findUnique({ where: { panelCode_target: { panelCode: dto.panelCode, target: dto.target } } })
      : await this.prisma.molecularAssay.findFirst({ where: { target: dto.target } });
    return { suggestion: suggestInterpretation(dto.detection, dto.ct, assay), assayFound: !!assay };
  }

  async record(dto: { specimenNo: string; target: string; detection: string; panelCode?: string; assay?: string; ct?: number; quantValue?: string; quantUnit?: string; interpretation?: string; reportedBy?: string; status?: string }) {
    if (!(DETECTIONS as readonly string[]).includes(dto.detection)) throw new BadRequestException(`검출유무 오류: ${dto.detection} (${DETECTIONS.join('/')})`);
    if (dto.status && !(MOL_STATUSES as readonly string[]).includes(dto.status)) throw new BadRequestException(`보고 상태 오류: ${dto.status} (${MOL_STATUSES.join('/')})`);
    if (!dto.target?.trim()) throw new BadRequestException('검출 타깃(target) 필요');
    // Ct 입력 위생 — 검증이 없어 음수·999가 저장되던 것(정량 해석·추세 비교가 틀어진다)
    const ctErr = validateCt(dto.ct);
    if (ctErr) throw new BadRequestException(ctErr);
    const spec = await this.prisma.specimen.findUnique({ where: { specimenNo: dto.specimenNo }, include: { order: { include: { patient: true } } } });
    if (!spec) throw new NotFoundException(`검체 없음: ${dto.specimenNo}`);

    // ── 카탈로그 대조(차단하지 않고 경고로) + 법정감염병 판정 — 결과 생성 전 계산(읽기·순수) ──
    //   target이 자유 문자열이라 "SARS-CoV-2"와 "SARS-CoV2"가 조용히 다른 타깃이 된다.
    const warnings: string[] = [];
    const assay = dto.panelCode
      ? await this.prisma.molecularAssay.findUnique({ where: { panelCode_target: { panelCode: dto.panelCode, target: dto.target } } })
      : await this.prisma.molecularAssay.findFirst({ where: { target: dto.target } });
    if (dto.panelCode && !assay) {
      const known = await this.prisma.molecularAssay.findMany({ where: { panelCode: dto.panelCode }, select: { target: true }, take: 30 });
      warnings.push(
        known.length
          ? `패널 ${dto.panelCode}에 등록되지 않은 타깃입니다 — 등록된 타깃: ${known.map((k) => k.target).join(', ')}`
          : `패널 ${dto.panelCode}의 타깃 카탈로그가 비어 있습니다 — 검사실에서 등록하면 Ct 판정 한계까지 함께 적용됩니다`,
      );
    }
    const consistency = ctConsistencyWarning(dto.detection, dto.ct, assay?.ctCutoff ?? undefined);
    if (consistency) warnings.push(consistency);
    const equivocal = ctEquivocalWarning(dto.detection, dto.ct, assay?.equivocalFrom, assay?.ctCutoff);
    if (equivocal) warnings.push(equivocal);
    const warning = warnings.length ? warnings.join(' / ') : null;
    const suggestion = suggestInterpretation(dto.detection, dto.ct, assay);

    const nRules = this.catalog.notifiableRules();
    const n = dto.detection === 'DETECTED'
      ? (nRules ? classifyNotifiableFrom(dto.target, null, nRules) : classifyNotifiable(dto.target, null))
      : { reportable: false, disease: null, grade: null };

    // ★결과 생성 + 법정감염병 신고 생성을 **한 트랜잭션**으로 — 이전에는 결과가 먼저 커밋된 뒤 신고 생성이
    //   실패하면 결과만 고아로 남고, 그 오류로 클라이언트가 재시도해 **중복 결과**를 만들 수 있었다.
    const pt = spec.order.patient;
    const { result, infectiousReport, reportReused } = await this.prisma.$transaction(async (tx) => {
      const result = await tx.molecularResult.create({
        data: {
          specimenNo: dto.specimenNo, panelCode: dto.panelCode ?? null, target: dto.target, assay: dto.assay ?? null,
          detection: dto.detection, ct: dto.ct ?? null, quantValue: dto.quantValue ?? null, quantUnit: dto.quantUnit ?? null,
          interpretation: dto.interpretation ?? null, reportedBy: dto.reportedBy ?? null, status: dto.status ?? 'FINAL',
        },
      });
      if (dto.detection === 'DETECTED' && n.reportable) {
        // 같은 검체·타깃 미처리(PENDING) 신고가 있으면 재사용(중복 신고 방지). NOTIFIED 후 재검출은 별개 사건.
        const pending = await tx.infectiousReport.findFirst({ where: { specimenNo: dto.specimenNo, organism: dto.target, status: 'PENDING' } });
        if (pending) return { result, infectiousReport: pending, reportReused: true };
        const rep = await tx.infectiousReport.create({
          data: { patientId: pt.patientId, patientName: pt.name, organism: dto.target, disease: n.disease as string, grade: n.grade, specimenNo: dto.specimenNo, status: 'PENDING', note: `분자검사(PCR) 검출 — ${dto.assay ?? ''}` },
        });
        return { result, infectiousReport: rep, reportReused: false };
      }
      return { result, infectiousReport: null as null | Awaited<ReturnType<typeof tx.infectiousReport.create>>, reportReused: false };
    });

    if (reportReused && infectiousReport) this.logger.log(`법정감염병 신고 재사용 — 미처리 건 존재(${infectiousReport.reportId}, ${dto.target})`);
    // 감염관리팀 알림(신규 신고 시만) — 트랜잭션 밖(알림 실패가 신고를 롤백하면 안 됨). 실패는 삼키지 않고 로깅.
    if (infectiousReport && !reportReused) {
      try {
        await this.prisma.notification.create({
          data: {
            notifyId: `N-NOTIF-${infectiousReport.reportId}`, ntype: '법정감염병신고', target: '감염관리팀',
            message: `⚠ 신고대상 ${n.disease}(${n.grade ?? '-'}) — ${dto.target} PCR 검출(검체 ${dto.specimenNo})`.slice(0, 500),
            createdDt: new Date(),
          },
        });
      } catch (e) {
        this.logger.error(`감염관리팀 알림 생성 실패(신고기록 ${infectiousReport.reportId}) — 신고 대기 목록 확인 필요: ${e instanceof Error ? e.message : e}`);
      }
    }
    // molecular #3: 제1·2급 법정감염병 분자 검출 → 담당의 **폐루프 위험치 통보**(혈액배양과 동일한 ack·에스컬레이션).
    //   제3·4급(COVID·간염·STI 등)은 감염관리 알림으로 충분 — 담당의 즉시통보 대상은 아니라 과잉알림 방지.
    //   ★reportReused로 게이트하지 않는다: 감염관리 신고는 미처리 건 재사용(dedup)이 맞지만, 담당의 위험치 통보는
    //   **검출 사건마다** 떠야 한다(혈액배양이 분리주마다 통보하는 것과 동일). 그래야 첫 통보 생성이 실패해도
    //   다음 검출에서 복구되고, 재검출도 누락 없이 알린다. notifyId는 결과 molId별로 달라 중복 생성도 없다.
    if (infectiousReport && (n.grade === '제1급' || n.grade === '제2급')) {
      try {
        const cn = await this.prisma.criticalNotify.create({
          data: {
            notifyId: `CN-MOL-${result.molId}`, resultId: null, category: 'MOLECULAR', sourceRef: result.molId,
            specimenNo: dto.specimenNo, patientId: pt?.patientId ?? null, patientName: pt?.name ?? null,
            label: `분자 위험병원체 검출(${n.grade})`, value: `${dto.target} — ${n.disease}`,
            notifyTarget: '담당의', notifyMethod: '유선', dispatchStatus: 'PENDING',
          },
        });
        this.events.emit('critical.created', { notifyId: cn.notifyId });
      } catch (e) {
        this.logger.error(`분자 위험치 폐루프 통보 생성 실패(${dto.target}) — 담당의 통보 확인 필요: ${e instanceof Error ? e.message : e}`);
      }
    }
    return { result, infectiousReport, reportReused, warning, suggestion };
  }

  async listBySpecimen(specimenNo: string) {
    return this.prisma.molecularResult.findMany({ where: { specimenNo }, orderBy: { reportedDt: 'desc' } });
  }

  /** 최근 검출(DETECTED) 워크리스트 — 감염관리·후속 대상. */
  async detectedRecent(from?: string, to?: string) {
    const where = {
      detection: 'DETECTED',
      ...(from || to ? { reportedDt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } : {}),
    };
    const rows = await this.prisma.molecularResult.findMany({ where, orderBy: { reportedDt: 'desc' }, take: 500 });
    // MolecularResult엔 specimen 관계가 없어(specimenNo 문자열만) 워크리스트가 환자명을 못 채웠다(항상 undefined).
    // 검체번호를 배치 조회해 환자ID/명을 붙인다(감염관리 후속엔 환자 식별이 필수).
    const specNos = [...new Set(rows.map((r) => r.specimenNo))];
    const specs = specNos.length
      ? await this.prisma.specimen.findMany({ where: { specimenNo: { in: specNos } }, include: { order: { include: { patient: true } } } })
      : [];
    const ptBySpec = new Map(specs.map((s) => [s.specimenNo, s.order?.patient]));
    // 이름은 원문으로 반환하고 마스킹은 웹에서(다른 목록 API와 동일 규약 — 웹이 maskName 적용).
    return rows.map((r) => {
      const pt = ptBySpec.get(r.specimenNo);
      return { ...r, patientId: pt?.patientId ?? null, patientName: pt?.name ?? null };
    });
  }
}
