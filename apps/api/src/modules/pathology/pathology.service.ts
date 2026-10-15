/**
 * PathologyService — pathology 도메인 서비스.
 *
 * 주요 진입점: `raiseCriticalDiagnosis()`, `listCases()`, `getCase()`, `evidenceContext()`, `linkMolecular()`, `linkSomatic()`, `setStaging()`, `scanBlock()`…
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, NotFoundException, BadRequestException, ConflictException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { genId } from '../../common/id.util';
import { isUniqueViolation } from '../../common/prisma-error.util';
import { nextSuffixSeq } from '../../domain/numbering';
import { buildAccession, accessionOverflow } from '../../common/accession.util';
import { validateSynoptic, SYNOPTIC_PROTOCOLS } from '../../domain/synoptic-protocols';
import { buildPathologyEvidenceContext } from '../../domain/pathology-evidence-context';
import { CatalogService } from '../catalog/catalog.service';
import { isValidCytoSpecimen, isValidAdequacy, isValidCytoCategory, CYTO_SPECIMEN_TYPES, ADEQUACY } from '../../domain/cytology';
import { renderPathologyReportHtml } from '../../domain/pathology-report-html';
import { STAIN_ORDER_TYPES, WORK_ORDER_STATUSES, CONCORDANCE_VALUES, isOneOf, SIGNED_PATHOLOGY_STATUSES, isSignedPathologyStatus } from '../../domain/enums';

interface SignReportInput {
  spNo: string;
  findings: string;
  diagnosis: string;
  snomed?: string;
  signer: string; // Provider ID
  synoptic?: Record<string, string> | null; // 구조화 암 보고(선택)
  synopticProtocol?: string; // CAP 프로토콜 키(STOMACH 등) — 지정 시 필수요소 검증(B6)
}

/** 병리 중요·긴급 진단 유형(read-back 통보 대상) — CAP/인증 critical diagnosis 스타터셋. */
export const PATHOLOGY_CRITICAL_TYPES = ['예상외 악성', '진단 불일치', '감염(결핵/진균 등)', '즉각 처치 필요', '기타'];

@Injectable()
export class PathologyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly catalog: CatalogService,
  ) {}

  /**
   * 중요·긴급 병리 진단 통보(A) — 예상외 악성·진단 불일치·감염 등 결정적 소견을 의뢰의에게
   * read-back 통보. CriticalNotify(category=PATHOLOGY) 재사용 → 기존 디스패치·복창·에스컬레이션 파이프라인 편입.
   */
  async raiseCriticalDiagnosis(spNo: string, dto: { diagnosisType: string; summary: string; notifyTarget?: string; notifyMethod?: string; raisedBy?: string }) {
    const c = await this.prisma.pathologyCase.findUnique({ where: { spNo }, include: { patient: true } });
    if (!c) throw new NotFoundException(`병리 검사 없음: ${spNo}`);
    if (!PATHOLOGY_CRITICAL_TYPES.includes(dto.diagnosisType)) throw new BadRequestException(`진단 유형은 ${PATHOLOGY_CRITICAL_TYPES.join('/')}: ${dto.diagnosisType}`);
    if (!dto.summary?.trim()) throw new BadRequestException('진단 요약(summary) 필요');
    const cn = await this.prisma.criticalNotify.create({
      data: {
        notifyId: genId('CN'), resultId: null, category: 'PATHOLOGY', sourceRef: spNo, specimenNo: spNo,
        patientId: c.patientId, patientName: c.patient?.name ?? null,
        label: `병리 중요진단: ${dto.diagnosisType}`, value: dto.summary.trim(),
        notifyTarget: dto.notifyTarget ?? c.requestingProvider ?? '의뢰의', notifyMethod: dto.notifyMethod ?? '유선',
        dispatchStatus: 'PENDING',
      },
    });
    this.events.emit('critical.created', { notifyId: cn.notifyId });
    return cn;
  }

  /**
   * 병리 워크리스트 — 미완료 기본(반려 제외), assignedTo 지정 시 해당 판독의 배정분만(C).
   * 완료 케이스는 기본 목록에서 빠지므로, 지난 건을 찾으려면 기간으로 조회해야 한다.
   */
  async listCases(status?: string, assignedTo?: string, from?: string, to?: string) {
    // receivedDate는 'YYYY-MM-DD' 문자열 — 사전순 비교가 날짜순과 일치한다
    const dateFilter = from || to ? { receivedDate: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {};
    const cases = await this.prisma.pathologyCase.findMany({
      where: {
        // 기간을 지정하면 완료분도 포함한다(지난 건 조회가 목적)
        ...(status ? { status } : from || to ? {} : { NOT: { status: '완료' } }),
        rejectStatus: null, // 반려 케이스 제외(E)
        ...(assignedTo ? { assignedTo } : {}),
        ...dateFilter,
      },
      include: { patient: true, report: true },
      orderBy: { spNo: 'desc' },
      take: 100,
    });
    return cases.map((c) => ({
      spNo: c.spNo,
      patientName: c.patient?.name ?? '',
      specimenSite: c.specimenSite,
      status: c.status ?? '접수',
      reportStatus: c.report?.status ?? null,
      assignedTo: c.assignedTo ?? null,
      // 기간 검색과 짝 — 접수일이 없는 케이스는 기간 조회에서 빠지므로 화면이 그 사실을 보여야 한다
      receivedDate: c.receivedDate ?? null,
    }));
  }

  async getCase(spNo: string) {
    const c = await this.prisma.pathologyCase.findUnique({
      where: { spNo },
      include: { report: { include: { addenda: { orderBy: { seq: 'asc' } } } }, patient: true, specimens: { orderBy: { partLabel: 'asc' } }, ihcResults: { orderBy: { reportedDt: 'asc' } }, cytology: true, stainOrders: { orderBy: { requestedDt: 'desc' } }, consults: { orderBy: { requestedDt: 'desc' } } },
    });
    if (!c) throw new NotFoundException(`병리 검사 없음: ${spNo}`);
    // PP5 결속된 분자병리·체세포(NGS) 소견 첨부(FK 아님 — caseSpNo로 조회)
    const [molecular, somatic] = await Promise.all([
      this.prisma.molecularResult.findMany({ where: { caseSpNo: spNo }, orderBy: { reportedDt: 'asc' } }),
      this.prisma.somaticFinding.findMany({ where: { caseSpNo: spNo }, orderBy: { reportedDt: 'asc' } }),
    ]);
    return { ...c, molecular, somatic };
  }

  /**
   * 병리 케이스 근거 종합 번들 — 진단 근거(IHC·병기·synoptic·세포병리·분자/체세포)를 한 곳에.
   * 판독 검토용이자 향후 원내 LLM(RAG) 컨텍스트. 외부 전송 없음.
   */
  async evidenceContext(spNo: string) {
    const c = await this.getCase(spNo); // report·ihcResults·cytology·molecular·somatic 포함
    const report = c.report;

    // synoptic은 JSON 문자열로 저장 — 안전 파싱
    let synopticValues: Record<string, string> | null = null;
    if (report?.synoptic) {
      try { const parsed = JSON.parse(report.synoptic); if (parsed && typeof parsed === 'object') synopticValues = parsed as Record<string, string>; } catch { synopticValues = null; }
    }
    const protoKey = report?.synopticProtocol ?? null;
    const protos = this.catalog.synopticProtocols();
    const protoLabel = protoKey ? (protos ?? SYNOPTIC_PROTOCOLS).find((p) => p.key === protoKey.toUpperCase())?.label ?? null : null;
    const protoRequired = protoKey ? ((protos ?? SYNOPTIC_PROTOCOLS).find((p) => p.key === protoKey.toUpperCase())?.required ?? []) : [];
    const synVal = validateSynoptic(protoKey, synopticValues, protos);

    const linked = [
      ...c.molecular.map((m) => ({ kind: 'molecular' as const, label: `${m.target}${m.detection ? `: ${m.detection}` : ''}` })),
      ...c.somatic.map((s) => ({ kind: 'somatic' as const, label: `${s.gene ?? ''} ${s.alteration ?? ''}${s.tier ? ` (${s.tier})` : ''}`.trim() || s.findingId })),
    ];

    return buildPathologyEvidenceContext({
      spNo,
      specimenSite: c.specimenSite,
      caseType: c.caseType,
      diagnosis: report?.diagnosis ?? null,
      findings: report?.findings ?? null,
      ihc: c.ihcResults.map((h) => ({ marker: h.marker, result: h.result, intensity: h.intensity, percentPos: h.percentPos, score: h.score, interpretation: h.interpretation })),
      staging: report ? { pT: report.pT, pN: report.pN, pM: report.pM, stageGroup: report.stageGroup, icdoTopo: report.icdoTopo, icdoMorph: report.icdoMorph } : null,
      synopticProtocol: protoKey,
      synopticProtocolLabel: protoLabel,
      synopticValues,
      synopticRequired: protoRequired,
      synopticMissing: synVal.missing,
      cytology: c.cytology ? { specimenType: c.cytology.specimenType, adequacy: c.cytology.adequacy, category: c.cytology.category } : null,
      linked,
    });
  }

  /** 분자검사 결과를 병리 케이스/블록에 결속(PP5). blockId 지정 시 케이스 소속 확인. */
  async linkMolecular(molId: string, dto: { caseSpNo: string; blockId?: string }) {
    await this.assertCase(dto.caseSpNo);
    if (!(await this.prisma.molecularResult.findUnique({ where: { molId } }))) throw new NotFoundException(`분자검사 결과 없음: ${molId}`);
    if (dto.blockId) await this.assertBlockInCase(dto.blockId, dto.caseSpNo);
    return this.prisma.molecularResult.update({ where: { molId }, data: { caseSpNo: dto.caseSpNo, blockId: dto.blockId ?? null } });
  }

  /** 체세포(NGS) 소견을 병리 케이스/블록에 결속(PP5). */
  async linkSomatic(findingId: string, dto: { caseSpNo: string; blockId?: string }) {
    await this.assertCase(dto.caseSpNo);
    if (!(await this.prisma.somaticFinding.findUnique({ where: { findingId } }))) throw new NotFoundException(`체세포 소견 없음: ${findingId}`);
    if (dto.blockId) await this.assertBlockInCase(dto.blockId, dto.caseSpNo);
    return this.prisma.somaticFinding.update({ where: { findingId }, data: { caseSpNo: dto.caseSpNo, blockId: dto.blockId ?? null } });
  }

  /**
   * 구조화 병기(TNM)·ICD-O 등록(PP7). 보고서 존재 시 갱신, 없으면 생성.
   * ICD-O 형태코드는 NNNN/N(행태) 형식·TNM 접두(c/p/y/r) 형식만 경검증(코드 카탈로그는 검사실 확정).
   */
  async setStaging(spNo: string, dto: { pT?: string; pN?: string; pM?: string; stageGroup?: string; icdoTopo?: string; icdoMorph?: string }) {
    await this.assertCase(spNo);
    if (dto.icdoMorph && !/^\d{4}\/\d$/.test(dto.icdoMorph)) throw new BadRequestException(`ICD-O 형태코드는 NNNN/N 형식: ${dto.icdoMorph}`);
    if (dto.icdoTopo && !/^C\d{2}(\.\d)?$/.test(dto.icdoTopo)) throw new BadRequestException(`ICD-O 국소부위는 Cnn(.n) 형식: ${dto.icdoTopo}`);
    // 활성 ICD-O 카탈로그가 있으면 형식뿐 아니라 실재 코드인지까지 본다(형식만 맞는 오타 차단)
    const icdo = this.catalog.icdoCodes();
    if (icdo) {
      if (dto.icdoMorph && !icdo.has('MORPHOLOGY', dto.icdoMorph)) throw new BadRequestException(`ICD-O 형태코드가 코드북에 없습니다: ${dto.icdoMorph}`);
      if (dto.icdoTopo && !icdo.has('TOPOGRAPHY', dto.icdoTopo)) throw new BadRequestException(`ICD-O 국소부위가 코드북에 없습니다: ${dto.icdoTopo}`);
    }
    for (const [k, v] of [['pT', dto.pT], ['pN', dto.pN], ['pM', dto.pM]] as const) {
      if (v && !/^(c|p|yp|yc|r|a)?[TNM]/i.test(v)) throw new BadRequestException(`${k}는 TNM 표기(예: pT3/pN1/M0): ${v}`);
    }
    const data = {
      ...(dto.pT != null ? { pT: dto.pT } : {}), ...(dto.pN != null ? { pN: dto.pN } : {}), ...(dto.pM != null ? { pM: dto.pM } : {}),
      ...(dto.stageGroup != null ? { stageGroup: dto.stageGroup } : {}), ...(dto.icdoTopo != null ? { icdoTopo: dto.icdoTopo } : {}), ...(dto.icdoMorph != null ? { icdoMorph: dto.icdoMorph } : {}),
    };
    return this.prisma.pathologyReport.upsert({ where: { spNo }, create: { spNo, status: '예비', ...data }, update: data });
  }

  /**
   * 블록 바코드 스캔 이벤트(PP8) — EMBED/CUT 등 상태 전이 + 관리연속성 로그.
   * 바코드로 조회(미지정 라벨은 blockId). 실물↔데이터 결속.
   */
  async scanBlock(barcodeOrId: string, dto: { event: string; location?: string; scannedBy?: string }) {
    const b = (await this.prisma.pathologyBlock.findFirst({ where: { OR: [{ barcode: barcodeOrId }, { blockId: barcodeOrId }] } }));
    if (!b) throw new NotFoundException(`블록 없음(바코드/ID): ${barcodeOrId}`);
    const EV = ['CREATE', 'EMBED', 'CUT', 'DELIVER'];
    if (!EV.includes(dto.event)) throw new BadRequestException(`블록 이벤트는 ${EV.join('/')}: ${dto.event}`);
    const nextStatus = dto.event === 'EMBED' ? 'EMBEDDED' : dto.event === 'CUT' ? 'CUT' : b.status;
    await this.prisma.pathologyBlock.update({ where: { blockId: b.blockId }, data: { status: nextStatus, ...(b.barcode ? {} : { barcode: barcodeOrId !== b.blockId ? barcodeOrId : null }) } });
    return this.prisma.pathologyScanEvent.create({ data: { targetType: 'BLOCK', targetId: b.blockId, spNo: b.spNo, event: dto.event, location: dto.location ?? null, scannedBy: dto.scannedBy ?? null } });
  }

  /**
   * 슬라이드 바코드 스캔 이벤트(PP8) — SCAN(성공→WSI 결속)/SCAN_FAIL 상태 전이 + 로그.
   */
  async scanSlide(barcodeOrId: string, dto: { event: string; location?: string; scannedBy?: string; wsiRef?: string }) {
    const s = (await this.prisma.pathologySlide.findFirst({ where: { OR: [{ barcode: barcodeOrId }, { slideId: barcodeOrId }] } }));
    if (!s) throw new NotFoundException(`슬라이드 없음(바코드/ID): ${barcodeOrId}`);
    const EV = ['STAIN', 'SCAN', 'SCAN_FAIL', 'DELIVER'];
    if (!EV.includes(dto.event)) throw new BadRequestException(`슬라이드 이벤트는 ${EV.join('/')}: ${dto.event}`);
    const patch: { scanStatus?: string; scannedDt?: Date; wsiRef?: string | null } = {};
    if (dto.event === 'SCAN') { patch.scanStatus = 'SCANNED'; patch.scannedDt = new Date(); patch.wsiRef = dto.wsiRef ?? s.wsiRef; }
    if (dto.event === 'SCAN_FAIL') patch.scanStatus = 'FAILED';
    await this.prisma.pathologySlide.update({ where: { slideId: s.slideId }, data: { ...patch, ...(s.barcode ? {} : { barcode: barcodeOrId !== s.slideId ? barcodeOrId : null }) } });
    return this.prisma.pathologyScanEvent.create({ data: { targetType: 'SLIDE', targetId: s.slideId, spNo: s.spNo, event: dto.event, location: dto.location ?? null, scannedBy: dto.scannedBy ?? null } });
  }

  /** 케이스 관리연속성(chain-of-custody) 조회(PP8) — 블록·슬라이드 스캔 이벤트 시계열. */
  async custody(spNo: string) {
    await this.assertCase(spNo);
    const [events, blocks, slides] = await Promise.all([
      this.prisma.pathologyScanEvent.findMany({ where: { spNo }, orderBy: { scannedDt: 'asc' } }),
      this.prisma.pathologyBlock.findMany({ where: { spNo }, orderBy: { label: 'asc' } }),
      this.prisma.pathologySlide.findMany({ where: { spNo }, orderBy: { createdDt: 'asc' } }),
    ]);
    return { spNo, blocks, slides, events };
  }

  private async assertBlockInCase(blockId: string, spNo: string) {
    const b = await this.prisma.pathologyBlock.findUnique({ where: { blockId } });
    if (!b) throw new NotFoundException(`블록 없음: ${blockId}`);
    if (b.spNo !== spNo) throw new BadRequestException(`블록 ${blockId}는 케이스 ${spNo} 소속 아님(${b.spNo})`);
  }

  /** 케이스 임상정보·의뢰의 갱신(PP1). */
  async updateCaseInfo(spNo: string, dto: { clinicalInfo?: string; requestingProvider?: string; specimenSite?: string; caseType?: string }) {
    await this.assertCase(spNo);
    return this.prisma.pathologyCase.update({
      where: { spNo },
      data: {
        ...(dto.clinicalInfo != null ? { clinicalInfo: dto.clinicalInfo } : {}),
        ...(dto.requestingProvider != null ? { requestingProvider: dto.requestingProvider } : {}),
        ...(dto.specimenSite != null ? { specimenSite: dto.specimenSite } : {}),
        ...(dto.caseType && ['SURGICAL', 'CYTOLOGY', 'FROZEN'].includes(dto.caseType) ? { caseType: dto.caseType } : {}),
      },
    });
  }

  /** IHC/특수염색 결과 등록(PP2) — marker별 결과·강도·양성%·score. */
  async addIhcResult(spNo: string, dto: { marker: string; slideId?: string; result?: string; intensity?: string; percentPos?: number; score?: string; interpretation?: string; reportedBy?: string }) {
    await this.assertCase(spNo);
    if (!dto.marker?.trim()) throw new BadRequestException('marker 필요(예: ER/PR/HER2/Ki-67)');
    if (dto.result && !['POS', 'NEG', 'EQUIVOCAL'].includes(dto.result)) throw new BadRequestException(`result는 POS/NEG/EQUIVOCAL: ${dto.result}`);
    return this.prisma.ihcResult.create({
      data: {
        spNo, slideId: dto.slideId ?? null, marker: dto.marker.trim(), result: dto.result ?? null,
        intensity: dto.intensity ?? null, percentPos: dto.percentPos ?? null, score: dto.score ?? null,
        interpretation: dto.interpretation ?? null, reportedBy: dto.reportedBy ?? null,
      },
    });
  }

  /** 다부위 검체 part 추가(PP1) — A/B/C… part별 검체종류·부위. */
  async addSpecimen(spNo: string, dto: { partLabel: string; specimenType?: string; site?: string; description?: string }) {
    await this.assertCase(spNo);
    if (!dto.partLabel?.trim()) throw new BadRequestException('part 라벨 필요(A/B/C…)');
    const dup = await this.prisma.pathologySpecimen.findUnique({ where: { spNo_partLabel: { spNo, partLabel: dto.partLabel } } });
    if (dup) throw new BadRequestException(`이미 등록된 part: ${dto.partLabel}`);
    return this.prisma.pathologySpecimen.create({
      data: { spNo, partLabel: dto.partLabel.trim(), specimenType: dto.specimenType ?? null, site: dto.site ?? null, description: dto.description ?? null },
    });
  }

  /**
   * 세포병리 보고 등록·갱신(PP3) — 케이스당 1건. Pap/FNA·검체 적정성·Bethesda 분류.
   * ★외과 보고서와 동일 보호(이전엔 무방비): (1) 서명(Provider 결속)은 controller의 signerOf로 강제,
   *   (2) 이미 서명된(최종/개정) 보고는 재저장으로 **조용히 덮어쓰지 못하게** 막고 명시적 개정(amend)만 허용
   *   — 악성 Pap이 재POST로 양성으로 교체되던 경로 차단. 개정은 감사로그(전역 인터셉터)에 기입자와 함께 남는다.
   */
  async upsertCytology(spNo: string, dto: { specimenType: string; adequacy?: string; adequacyNote?: string; category?: string; diagnosis?: string; signer?: string; status?: string; amend?: boolean }) {
    await this.assertCase(spNo);
    if (!dto.specimenType?.trim() || !isValidCytoSpecimen(dto.specimenType)) throw new BadRequestException(`specimenType는 ${CYTO_SPECIMEN_TYPES.join('/')} 중: ${dto.specimenType}`);
    if (dto.adequacy && !isValidAdequacy(dto.adequacy)) throw new BadRequestException(`adequacy는 ${ADEQUACY.join('/')}: ${dto.adequacy}`);
    if (dto.category && !isValidCytoCategory(dto.category, this.catalog.cytoCategories())) {
      throw new BadRequestException(`category 부적합(Bethesda/일반 분류): ${dto.category} — 세포병리 분류 카탈로그에 없는 코드입니다`);
    }
    const existing = await this.prisma.cytologyReport.findUnique({ where: { spNo } });
    if (existing && isSignedPathologyStatus(existing.status) && !dto.amend) {
      throw new BadRequestException(`이미 서명된 세포병리 보고입니다(현재 ${existing.status}) — 재저장으로 덮어쓸 수 없습니다. 수정은 개정(amend)으로 진행하세요`);
    }
    // 빈 판독(분류·진단 모두 없음)은 최종으로 굳히지 않는다(예비). 개정은 '개정', 실판독 저장은 '최종'.
    const hasDx = !!(dto.category?.trim() || dto.diagnosis?.trim());
    const status = dto.status ?? (existing && isSignedPathologyStatus(existing.status) && dto.amend ? '개정' : hasDx ? '최종' : '예비');
    const signed = dto.signer && status !== '예비' ? { signer: dto.signer, signedDt: new Date() } : {};
    const data = {
      specimenType: dto.specimenType.trim(), adequacy: dto.adequacy ?? null, adequacyNote: dto.adequacyNote ?? null,
      category: dto.category ?? null, diagnosis: dto.diagnosis ?? null, status, ...signed,
    };
    if (existing && isSignedPathologyStatus(existing.status)) {
      // 개정: 그사이 상태가 바뀌지 않았을 때만 원자적 갱신
      const claim = await this.prisma.cytologyReport.updateMany({ where: { spNo, status: existing.status }, data });
      if (claim.count === 0) throw new ConflictException('그사이 보고 상태가 바뀌었습니다 — 새로고침하세요');
      return this.prisma.cytologyReport.findUnique({ where: { spNo } });
    }
    return this.prisma.cytologyReport.upsert({ where: { spNo }, create: { spNo, ...data }, update: data });
  }

  /** 병리 보고서 HTML 렌더(PP4) — getCase 전체 include를 렌더러로. */
  async renderReport(spNo: string): Promise<string> {
    const c = await this.getCase(spNo);
    return renderPathologyReportHtml(c as Parameters<typeof renderPathologyReportHtml>[0]);
  }

  /** 병리 보고서 배포 기록(PP4) — ReportDelivery 재사용(specimenNo=spNo). 최종/개정 보고서만. */
  async deliverReport(spNo: string, dto: { channel: string; recipient?: string; deliveredBy?: string; note?: string }) {
    const c = await this.assertCase(spNo);
    const rep = await this.prisma.pathologyReport.findUnique({ where: { spNo } });
    const cyto = await this.prisma.cytologyReport.findUnique({ where: { spNo } });
    const status = rep?.status ?? cyto?.status ?? null;
    if (status !== '최종' && status !== '개정') throw new BadRequestException(`서명 완료(최종/개정) 보고서만 배포 가능: 현재 ${status ?? '작성중'}`);
    const CH = ['PRINT', 'PORTAL', 'PROVIDER', 'FAX'];
    if (!CH.includes(dto.channel)) throw new BadRequestException(`channel은 ${CH.join('/')}: ${dto.channel}`);
    void c;
    return this.prisma.reportDelivery.create({
      data: { specimenNo: spNo, channel: dto.channel, recipient: dto.recipient ?? null, deliveredBy: dto.deliveredBy ?? null, note: dto.note ?? null },
    });
  }

  async listDeliveries(spNo: string) {
    return this.prisma.reportDelivery.findMany({ where: { specimenNo: spNo }, orderBy: { deliveredDt: 'desc' } });
  }

  // ── 추가 특수염색/재검 오더 추적(B) ──
  async requestStainOrder(spNo: string, dto: { orderType: string; blockId?: string; detail?: string; requestedBy?: string; note?: string }) {
    await this.assertCase(spNo);
    if (!isOneOf(STAIN_ORDER_TYPES, dto.orderType)) {
      throw new BadRequestException(`orderType은 ${STAIN_ORDER_TYPES.join('/')}: ${dto.orderType}`);
    }
    if (dto.blockId) await this.assertBlockInCase(dto.blockId, spNo);
    return this.prisma.pathologyStainOrder.create({
      data: { spNo, orderType: dto.orderType, blockId: dto.blockId ?? null, detail: dto.detail ?? null, requestedBy: dto.requestedBy ?? null, note: dto.note ?? null },
    });
  }
  async updateStainOrder(orderId: string, dto: { status: string; completedBy?: string }) {
    const o = await this.prisma.pathologyStainOrder.findUnique({ where: { orderId } });
    if (!o) throw new NotFoundException(`염색 오더 없음: ${orderId}`);
    if (!isOneOf(WORK_ORDER_STATUSES, dto.status)) {
      throw new BadRequestException(`status는 ${WORK_ORDER_STATUSES.join('/')}: ${dto.status}`);
    }
    return this.prisma.pathologyStainOrder.update({
      where: { orderId },
      data: { status: dto.status, ...(dto.status === 'COMPLETED' ? { completedBy: dto.completedBy ?? null, completedDt: new Date() } : {}) },
    });
  }

  // ── 판독의 배정(C) ──
  async assignCase(spNo: string, assignedTo: string) {
    await this.assertCase(spNo);
    if (!assignedTo?.trim()) throw new BadRequestException('배정 판독의(assignedTo) 필요');
    return this.prisma.pathologyCase.update({ where: { spNo }, data: { assignedTo: assignedTo.trim(), assignedDt: new Date() } });
  }

  // ── 컨설테이션·2차 소견(D) ──
  async requestConsult(spNo: string, dto: { consultType: string; consultant?: string; question?: string; requestedBy?: string }) {
    await this.assertCase(spNo);
    if (!['INTERNAL', 'EXTERNAL'].includes(dto.consultType)) throw new BadRequestException(`consultType은 INTERNAL/EXTERNAL: ${dto.consultType}`);
    return this.prisma.pathologyConsult.create({
      data: { spNo, consultType: dto.consultType, consultant: dto.consultant ?? null, question: dto.question ?? null, requestedBy: dto.requestedBy ?? null },
    });
  }
  async respondConsult(consultId: string, dto: { opinion: string }) {
    const c = await this.prisma.pathologyConsult.findUnique({ where: { consultId } });
    if (!c) throw new NotFoundException(`컨설트 없음: ${consultId}`);
    if (!dto.opinion?.trim()) throw new BadRequestException('회신 소견(opinion) 필요');
    return this.prisma.pathologyConsult.update({ where: { consultId }, data: { opinion: dto.opinion.trim(), status: 'RESPONDED', respondedDt: new Date() } });
  }

  // ── 접수 검체 부적합·반려(E) ──
  async rejectCase(spNo: string, dto: { reason: string; rejectedBy?: string }) {
    await this.assertCase(spNo);
    const rep = await this.prisma.pathologyReport.findUnique({ where: { spNo } });
    if (rep) throw new BadRequestException('이미 보고된 케이스는 반려할 수 없습니다');
    if (!dto.reason?.trim()) throw new BadRequestException('반려 사유(reason) 필요');
    return this.prisma.pathologyCase.update({
      where: { spNo },
      data: { rejectStatus: 'REJECTED', rejectReason: dto.reason.trim(), rejectedBy: dto.rejectedBy ?? null, rejectedDt: new Date(), status: '반려' },
    });
  }

  private async assertCase(spNo: string) {
    const c = await this.prisma.pathologyCase.findUnique({ where: { spNo } });
    if (!c) throw new NotFoundException(`병리 검사 없음: ${spNo}`);
    return c;
  }

  /** 그로싱(육안 검사) 기록 — 표본추적 1단계. */
  async recordGrossing(spNo: string, dto: { grossDesc: string; grossedBy?: string }) {
    await this.assertCase(spNo);
    return this.prisma.pathologyCase.update({
      where: { spNo },
      data: { grossDesc: dto.grossDesc, grossedBy: dto.grossedBy ?? null, grossedDt: new Date(), status: '그로싱' },
    });
  }

  /**
   * 블록(포매) 생성 — 블록ID = {검체}-B{n}.
   * n은 count+1이 아닌 **기존 최대값+1** — 중간 블록 삭제 후 count+1은 항상 기존 ID와
   * 충돌해 채번이 영구 고장났다(재검토 P2). 동시 생성 경합은 P2002 재채번으로 흡수.
   */
  async createBlock(spNo: string, dto: { label: string; tissue?: string }) {
    await this.assertCase(spNo);
    for (let attempt = 0; ; attempt++) {
      const ids = await this.prisma.pathologyBlock.findMany({ where: { spNo }, select: { blockId: true } });
      const blockId = `${spNo}-B${nextSuffixSeq(ids.map((b) => b.blockId), `${spNo}-B`)}`;
      try {
        const block = await this.prisma.pathologyBlock.create({
          data: { blockId, spNo, label: dto.label, tissue: dto.tissue ?? null },
        });
        await this.prisma.pathologyCase.update({ where: { spNo }, data: { status: '포매' } });
        return block;
      } catch (e) {
        if (!isUniqueViolation(e) || attempt >= 2) throw e;
      }
    }
  }

  /** 슬라이드 제작 — 블록에서 염색(H&E/특수/면역). 채번은 블록과 동일하게 최대값+1. */
  async createSlide(blockId: string, dto: { stain: string; stainDetail?: string }) {
    const block = await this.prisma.pathologyBlock.findUnique({ where: { blockId } });
    if (!block) throw new NotFoundException(`블록 없음: ${blockId}`);
    for (let attempt = 0; ; attempt++) {
      const ids = await this.prisma.pathologySlide.findMany({ where: { blockId }, select: { slideId: true } });
      const slideId = `${blockId}-S${nextSuffixSeq(ids.map((s) => s.slideId), `${blockId}-S`)}`;
      try {
        return await this.prisma.pathologySlide.create({
          data: { slideId, spNo: block.spNo, blockId, stain: dto.stain, stainDetail: dto.stainDetail ?? null },
        });
      } catch (e) {
        if (!isUniqueViolation(e) || attempt >= 2) throw e;
      }
    }
  }

  /** 슬라이드 삭제 — 오생성 정리(빈 상세 IHC 등). */
  async deleteSlide(slideId: string) {
    const s = await this.prisma.pathologySlide.findUnique({ where: { slideId } });
    if (!s) throw new NotFoundException(`슬라이드 없음: ${slideId}`);
    await this.prisma.pathologySlide.delete({ where: { slideId } });
    return { deleted: slideId };
  }

  /** 블록 삭제 — 슬라이드가 없을 때만(제작 이력 보호). */
  async deleteBlock(blockId: string) {
    const b = await this.prisma.pathologyBlock.findUnique({ where: { blockId } });
    if (!b) throw new NotFoundException(`블록 없음: ${blockId}`);
    const slideCount = await this.prisma.pathologySlide.count({ where: { blockId } });
    if (slideCount > 0) throw new BadRequestException(`슬라이드 ${slideCount}건이 있어 삭제 불가 — 슬라이드 먼저 삭제`);
    await this.prisma.pathologyBlock.delete({ where: { blockId } });
    return { deleted: blockId };
  }

  /** 표본 추적 — 그로싱→블록→슬라이드→보고서 전체 조회. */
  async tracking(spNo: string) {
    const c = await this.assertCase(spNo);
    const [blocks, slides, report] = await Promise.all([
      this.prisma.pathologyBlock.findMany({ where: { spNo }, orderBy: { blockId: 'asc' } }),
      this.prisma.pathologySlide.findMany({ where: { spNo }, orderBy: { slideId: 'asc' } }),
      this.prisma.pathologyReport.findUnique({ where: { spNo } }),
    ]);
    return {
      spNo, status: c.status, grossDesc: c.grossDesc,
      blocks: blocks.map((b) => ({ ...b, slides: slides.filter((s) => s.blockId === b.blockId) })),
      report,
    };
  }

  /** 보고서 개정 — 최종 보고서만 개정 가능. 버전 증가·사유 기록. */
  async amendReport(spNo: string, dto: { findings: string; diagnosis: string; reason: string; signer: string; baseVersion?: number }) {
    const report = await this.prisma.pathologyReport.findUnique({ where: { spNo } });
    if (!report) throw new NotFoundException(`보고서 없음: ${spNo}`);
    if (report.status !== '최종' && report.status !== '개정') {
      throw new BadRequestException(`최종 보고서만 개정 가능(현재 ${report.status})`);
    }
    // ★버전을 읽어서 +1로 쓰면 동시 개정 2건이 같은 값을 써서 한쪽이 사라진다(lost update).
    //   기대 버전을 술어에 넣고 increment로 올린다.
    //   baseVersion(클라이언트가 편집 기준으로 삼은 버전)을 주면 그 값으로 술어를 잡는다 — 서버 재조회에
    //   의존하지 않아 동시 개정이 확정적으로 한쪽만 반영된다(TOCTOU 제거). 미지정 시 현재 버전 폴백.
    const expectedVersion = dto.baseVersion ?? report.version;
    const claim = await this.prisma.pathologyReport.updateMany({
      where: { spNo, version: expectedVersion },
      data: {
        findings: dto.findings, diagnosis: dto.diagnosis, status: '개정',
        version: { increment: 1 }, amendReason: dto.reason, signer: dto.signer, signedDt: new Date(),
      },
    });
    // 409 — 입력 오류(400)가 아니라 경합. 클라이언트가 "새로고침 후 재시도"를 구별할 수 있게(Q8)
    if (claim.count === 0) throw new ConflictException('그사이 다른 개정이 반영되었습니다 — 화면을 새로고침한 뒤 다시 시도하세요');
    // P3: 이미 배포된 보고서의 개정은 임상의가 이전 진단으로 진료 중일 수 있으므로 폐루프로 재통보한다
    //   (수기 재배포에만 의존하면 개정 통보가 누락돼 상급 진단이 전달 안 되는 위험). 미배포면 통보 불필요.
    const delivered = await this.prisma.reportDelivery.count({ where: { specimenNo: spNo } });
    if (delivered > 0) {
      const c = await this.prisma.pathologyCase.findUnique({ where: { spNo }, include: { patient: true } });
      const cn = await this.prisma.criticalNotify.create({
        data: {
          notifyId: genId('CN'), resultId: null, category: 'PATHOLOGY', sourceRef: spNo, specimenNo: spNo,
          patientId: c?.patientId ?? null, patientName: c?.patient?.name ?? null,
          label: '병리 보고서 개정 — 재확인 필요', value: `${dto.diagnosis} (사유: ${dto.reason})`.slice(0, 200),
          notifyTarget: c?.requestingProvider ?? '의뢰의', notifyMethod: '유선', dispatchStatus: 'PENDING',
        },
      });
      this.events.emit('critical.created', { notifyId: cn.notifyId });
    }
    return this.prisma.pathologyReport.findUnique({ where: { spNo } });
  }

  /**
   * 2단계 사인아웃(B4) 1단계 — 전공의 초안 작성. 상태 '초안', accession 미부여(최종 아님).
   * 이후 판독전문의가 signReport로 확정. 초안 없이 바로 signReport도 허용(하위호환).
   */
  async draftReport(input: SignReportInput) {
    const c = await this.prisma.pathologyCase.findUnique({ where: { spNo: input.spNo } });
    if (!c) throw new NotFoundException(`병리 검사 없음: ${input.spNo}`);
    // ★서명 완료본을 초안으로 되돌리지 않는다. 이전에는 무조건 upsert라, 전공의가 교수 서명이
    //   끝난 케이스를 열어 초안 저장하면 **확정 진단문이 지워지고 미서명 상태로 회귀**했다.
    //   (이미 배포된 보고서는 그대로 남아 있어 불일치가 생긴다)
    const existing = await this.prisma.pathologyReport.findUnique({ where: { spNo: input.spNo } });
    if (existing && isSignedPathologyStatus(existing.status)) {
      throw new BadRequestException(
        `이미 서명된 보고서입니다(현재 ${existing.status}) — 초안으로 되돌릴 수 없습니다. 수정은 개정(amend)으로 진행하세요`,
      );
    }
    const synoptic = input.synoptic && Object.values(input.synoptic).some((v) => (v ?? '').trim())
      ? JSON.stringify(Object.fromEntries(Object.entries(input.synoptic).filter(([, v]) => (v ?? '').trim())))
      : null;
    const data = { findings: input.findings, diagnosis: input.diagnosis, snomed: input.snomed ?? null, synoptic, synopticProtocol: input.synopticProtocol ?? null, status: '초안', draftBy: input.signer, draftDt: new Date() };
    let report;
    if (existing) {
      // 원자적 전이: 읽은 뒤 다른 사용자가 서명했다면 덮어쓰지 않는다.
      const claim = await this.prisma.pathologyReport.updateMany({
        where: { spNo: input.spNo, status: { notIn: [...SIGNED_PATHOLOGY_STATUSES] } },
        data,
      });
      if (claim.count === 0) throw new ConflictException('그사이 다른 사용자가 서명했습니다 — 화면을 새로고침하세요');
      report = await this.prisma.pathologyReport.findUnique({ where: { spNo: input.spNo } });
    } else {
      report = await this.prisma.pathologyReport.create({ data: { spNo: input.spNo, ...data } });
    }
    await this.prisma.pathologyCase.update({ where: { spNo: input.spNo }, data: { status: '판독' } });
    return report;
  }

  /**
   * 추가보고(addendum, B4) — 최종 보고에 진단 변경 없이 추후 결과(IHC·분자 등) 덧붙임.
   * 개정(amendment, 진단 변경·버전업)과 법적·임상적으로 구분. 상태는 '최종' 유지.
   */
  async addAddendum(spNo: string, dto: { content: string; addedBy?: string }) {
    const report = await this.prisma.pathologyReport.findUnique({ where: { spNo }, include: { addenda: true } });
    if (!report) throw new NotFoundException(`보고서 없음: ${spNo}`);
    if (report.status !== '최종' && report.status !== '개정') {
      throw new BadRequestException(`최종 보고서에만 추가보고 가능(현재 ${report.status})`);
    }
    // seq는 length+1이 아닌 최대값+1(중간 삭제·경합에도 역행 없음), 유니크 경합 시 재채번
    for (let attempt = 0; ; attempt++) {
      const agg = await this.prisma.pathologyAddendum.aggregate({ where: { spNo }, _max: { seq: true } });
      const seq = (agg._max.seq ?? 0) + 1;
      try {
        return await this.prisma.pathologyAddendum.create({
          data: { spNo, seq, content: dto.content, addedBy: dto.addedBy ?? null },
        });
      } catch (e) {
        if (!isUniqueViolation(e) || attempt >= 2) throw e;
      }
    }
  }

  /** 동결절편(B4) — 수술중 동결 진단 기록. 이후 영구절편 확정 시 concordance 기록. */
  async recordFrozen(spNo: string, dto: { frozenDx: string; frozenBy?: string; concordance?: string }) {
    const c = await this.prisma.pathologyCase.findUnique({ where: { spNo } });
    if (!c) throw new NotFoundException(`병리 검사 없음: ${spNo}`);
    if (dto.concordance && !isOneOf(CONCORDANCE_VALUES, dto.concordance)) {
      throw new BadRequestException(`concordance는 CONCORDANT/DISCORDANT: ${dto.concordance}`);
    }
    return this.prisma.pathologyReport.upsert({
      where: { spNo },
      update: { frozenDx: dto.frozenDx, frozenBy: dto.frozenBy ?? null, frozenDt: new Date(), ...(dto.concordance ? { frozenConcordance: dto.concordance } : {}) },
      create: { spNo, frozenDx: dto.frozenDx, frozenBy: dto.frozenBy ?? null, frozenDt: new Date(), frozenConcordance: dto.concordance ?? null, status: '동결' },
    });
  }

  /**
   * 판독 보고서 전자서명 확정 — 상태 '최종', PACS Accession 부여. (07 §10)
   * 2단계 사인아웃(B4): 초안(draftBy)이 있으면 판독전문의(signer)가 최종 확정 — draftBy 보존.
   */
  async signReport(input: SignReportInput) {
    const c = await this.prisma.pathologyCase.findUnique({ where: { spNo: input.spNo } });
    if (!c) throw new NotFoundException(`병리 검사 없음: ${input.spNo}`);

    const accessionNo = buildAccession(input.spNo); // ACC-{prefix}-YY-{seq} (2자리 연도)
    const overflow = accessionOverflow(accessionNo);
    if (overflow) throw new BadRequestException(overflow);
    // B6: CAP 프로토콜 지정 시 최종 확정 전 필수요소 검증(누락이면 차단).
    if (input.synopticProtocol) {
      const v = validateSynoptic(input.synopticProtocol, input.synoptic ?? {}, this.catalog.synopticProtocols());
      if (!v.valid) throw new BadRequestException(`synoptic 필수요소 누락(${input.synopticProtocol}): ${v.missing.join(', ')}`);
    }
    // 구조화 암 보고(synoptic) — 빈 값 필드는 제외하고 JSON 직렬화
    const synoptic = input.synoptic && Object.values(input.synoptic).some((v) => (v ?? '').trim())
      ? JSON.stringify(Object.fromEntries(Object.entries(input.synoptic).filter(([, v]) => (v ?? '').trim())))
      : null;
    // ★이미 서명된 보고서는 **제자리에서 덮어쓰지 않는다.**
    //   이전에는 무조건 upsert라 더블클릭·타임아웃 후 재시도·타 판독의 서명 어느 경우든
    //   법적 확정 진단문이 조용히 교체됐고, 이력 테이블이 없어 복구가 불가능했다.
    //   수정은 개정(amendReport)으로만 — 버전 증가와 사유 기록이 강제된다.
    const existing = await this.prisma.pathologyReport.findUnique({ where: { spNo: input.spNo } });
    if (existing && isSignedPathologyStatus(existing.status)) {
      throw new BadRequestException(
        `이미 서명된 보고서입니다(현재 ${existing.status}, 버전 ${existing.version}) — ` +
        `수정은 개정으로 진행하세요: POST /api/v1/pathology/reports/${input.spNo}/amend`,
      );
    }
    const signData = {
      findings: input.findings,
      diagnosis: input.diagnosis,
      snomed: input.snomed ?? null,
      synoptic,
      synopticProtocol: input.synopticProtocol ?? null,
      status: '최종',
      signer: input.signer,
      signedDt: new Date(),
      accessionNo,
    };
    let report;
    if (existing) {
      // 초안 → 최종 원자적 전이(동시 서명 경합 차단)
      const claim = await this.prisma.pathologyReport.updateMany({
        where: { spNo: input.spNo, status: { notIn: [...SIGNED_PATHOLOGY_STATUSES] } },
        data: signData,
      });
      if (claim.count === 0) throw new ConflictException('그사이 다른 사용자가 서명했습니다 — 화면을 새로고침하세요');
      report = await this.prisma.pathologyReport.findUnique({ where: { spNo: input.spNo } });
    } else {
      report = await this.prisma.pathologyReport.create({ data: { spNo: input.spNo, ...signData } });
    }
    await this.prisma.pathologyCase.update({
      where: { spNo: input.spNo },
      data: { status: '완료' },
    });
    return report;
  }

  /** CAP synoptic 프로토콜 목록(B6) — 활성 카탈로그가 있으면 그것을, 없으면 스타터셋. */
  listSynopticProtocols() {
    return this.catalog.synopticProtocols() ?? SYNOPTIC_PROTOCOLS;
  }
}
