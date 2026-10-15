/**
 * MicrobiologyService — microbiology 도메인 서비스.
 *
 * 주요 진입점: `listCultures()`, `getCulture()`, `getReport()`, `createCulture()`, `recordGram()`, `recordIsolate()`, `antibiogram()`, `rejectCulture()`…
 * 일부 경로는 트랜잭션으로 묶인다 — 부분 반영 시 임상 상태가 깨지는 구간.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { canRecordGram, canFinalize, preliminaryText } from '../../domain/microbiology';
import { classifyMdro } from '../../domain/mdro';
import { classifyNotifiable, classifyNotifiableFrom } from '../../domain/notifiable-disease';
import { validateAst } from '../../domain/ast-expert-rules';
import { interpretMic, STARTER_STANDARD } from '../../domain/ast-breakpoints';
import { CatalogService } from '../catalog/catalog.service';
import { selectiveAstReport } from '../../domain/ast-selective-report';
import { buildMicroEvidenceContext } from '../../domain/micro-evidence-context';
import { genId } from '../../common/id.util';

interface SusInput {
  antibiotic: string;
  mic: string;
  interpretation?: string; // S/I/R — 미제공 시 MIC 브레이크포인트로 도출(B6)
}
interface RecordIsolateInput {
  cultureId: string;
  organism: string;
  snomed?: string;
  susceptibilities: SusInput[];
  reporter?: string;
}
interface GramInput {
  cultureId: string;
  gramStain: string;
  reporter?: string;
}

@Injectable()
export class MicrobiologyService {
  private readonly logger = new Logger(MicrobiologyService.name);
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly catalog: CatalogService,
  ) {}

  /** 검체종류가 혈액이면 true — 혈액배양 양성은 생명위협 위험치(폐루프 통보 트리거). */
  private isBloodSpecimen(specimenType: string | null | undefined): boolean {
    return /혈액|blood|bld/i.test(specimenType ?? '');
  }

  /** 미생물 대기 워크리스트 — 최종보고 전 배양. */
  /**
   * 배양 목록. 기본은 **판독대기 워크리스트**(최종보고 전)지만, 완료된 배양은 목록에서
   * 사라져 나중에 조회할 방법이 없었다(동정·AST가 끝나면 antibiogram·line-list로만 보임).
   * scope로 완료·전체까지 볼 수 있게 한다 — 완료 배양은 동정 균명도 함께 보여준다.
   */
  async listCultures(scope: 'pending' | 'completed' | 'all' = 'pending') {
    const base = { rejectStatus: null }; // M1 반려는 항상 제외
    // 완료 = 최종(FINAL) 또는 개정(AMENDED). 개정은 '최종 후 정정'이라 완료 배양이다 —
    // 서비스의 다른 판정(isFinal = FINAL||AMENDED)과 일치시켜, 개정 배양이 대기 워크리스트에 되살아나지 않게 한다.
    const DONE = ['FINAL', 'AMENDED'];
    const where =
      scope === 'completed'
        ? { AND: [{ reportStatus: { in: DONE } }, base] }
        : scope === 'all'
          ? base
          : { AND: [{ OR: [{ reportStatus: null }, { reportStatus: { notIn: DONE } }] }, base] };
    const cultures = await this.prisma.culture.findMany({
      where,
      include: { specimen: { include: { order: { include: { patient: true } } } }, isolates: { select: { organism: true } } },
      orderBy: { cultureId: 'desc' },
      take: 200,
    });
    return cultures.map((c) => ({
      cultureId: c.cultureId,
      specimenNo: c.specimenNo,
      patientName: c.specimen?.order?.patient?.name ?? '',
      stage: c.stage ?? '접종',
      reportStatus: c.reportStatus ?? null,
      // 완료 배양 목록에서 무엇이 자랐는지 바로 보이게(동정 균명)
      organisms: c.isolates.map((i) => i.organism).filter(Boolean),
    }));
  }

  async getCulture(cultureId: string) {
    const culture = await this.prisma.culture.findUnique({
      where: { cultureId },
      include: { isolates: { include: { susceptibilities: true } }, reports: { orderBy: { reportedDt: 'asc' } } },
    });
    if (!culture) throw new NotFoundException(`배양 없음: ${cultureId}`);
    // MDRO 분류·AST expert-rule은 순수함수로 저장하지 않음 → 조회 시 재산출해 배지/경고 유지
    const isolates = culture.isolates.map((iso) => {
      const sus = iso.susceptibilities.map((s) => ({ antibiotic: s.antibiotic, interpretation: s.interpretation }));
      return { ...iso, mdro: classifyMdro(iso.organism, sus), astWarnings: validateAst(iso.organism, sus) };
    });
    return { ...culture, isolates };
  }

  /** 배양 단계보고 이력(그람 예비 → 최종 → 개정). */
  async getReport(cultureId: string) {
    const culture = await this.getCulture(cultureId);
    return {
      cultureId,
      stage: culture.stage,
      reportStatus: culture.reportStatus,
      gramStain: culture.gramStain,
      organisms: culture.isolates.map((i) => i.organism),
      reports: culture.reports,
    };
  }

  /**
   * 그람 염색 소견 기록 → 예비(중간)보고 생성. (단계보고 1단계)
   * 그람 결과는 최종 동정 전 임상의에게 조기 전달된다.
   */
  /**
   * 배양 등록 — 실오더로 미생물 워크리스트에 배양을 올리는 진입점. 검체 접수 후 배지에 접종하면 등록한다.
   * (이게 없으면 그람→동정→AST→신고→항생제감수성 전 사슬이 도달 불가였다. 자동 인터페이스가 없거나
   *  비협조 업체면 수기 등록이 정본 — [[lis-dual-result-entry]] 원칙.)
   */
  async createCulture(input: { specimenNo: string; medium?: string; source?: string }) {
    const specimenNo = input.specimenNo?.trim();
    if (!specimenNo) throw new BadRequestException('검체번호 필수');
    const spec = await this.prisma.specimen.findUnique({ where: { specimenNo } });
    if (!spec) throw new NotFoundException(`검체 없음: ${specimenNo}`);
    return this.prisma.culture.create({
      data: {
        cultureId: genId('CUL'),
        specimenNo,
        medium: input.medium?.trim() || input.source?.trim() || null,
        stage: 'INOCULATED',
        status: '진행',
      },
    });
  }

  async recordGram(input: GramInput) {
    const culture = await this.prisma.culture.findUnique({ where: { cultureId: input.cultureId } });
    if (!culture) throw new NotFoundException(`배양 없음: ${input.cultureId}`);
    if (!canRecordGram(culture.stage)) {
      throw new BadRequestException(`현재 단계(${culture.stage})에서는 그람 기록 불가`);
    }
    const content = preliminaryText(input.gramStain);
    const [, report] = await this.prisma.$transaction([
      this.prisma.culture.update({
        where: { cultureId: input.cultureId },
        data: { gramStain: input.gramStain, gramDt: new Date(), stage: 'GRAM', reportStatus: 'PRELIMINARY' },
      }),
      this.prisma.cultureReport.create({
        data: { cultureId: input.cultureId, stage: 'GRAM', status: 'PRELIMINARY', content, reporter: input.reporter ?? null },
      }),
    ]);
    return { cultureId: input.cultureId, stage: 'GRAM', reportStatus: 'PRELIMINARY', report };
  }

  /**
   * 균 동정 + 감수성(AST) 등록. 내성(R) 발견 시 감염관리팀 알림. (07 §9)
   */
  async recordIsolate(input: RecordIsolateInput) {
    const culture = await this.prisma.culture.findUnique({ where: { cultureId: input.cultureId } });
    if (!culture) throw new NotFoundException(`배양 없음: ${input.cultureId}`);
    if (!canFinalize(culture.stage)) {
      throw new BadRequestException(`그람 예비보고 후 동정·감수성 확정이 가능합니다(현재 ${culture.stage ?? '접종'})`);
    }

    // B6: MIC→S/I/R 판정엔진 — interpretation 미제공 시 브레이크포인트로 도출(검사법·기준 버전 기록).
    //   도출값은 MDRO 분류·expert rule에도 반영(effectiveSus).
    const effectiveSus = input.susceptibilities.map((s) => {
      const provided = (s.interpretation ?? '').trim();
      // 브레이크포인트는 활성 카탈로그(CLSI 개정판)를 따른다 — 없으면 코드 스타터셋
      const derived = provided ? null : interpretMic(input.organism, s.antibiotic, s.mic, this.catalog.activeAst());
      return {
        antibiotic: s.antibiotic,
        mic: s.mic,
        interpretation: provided || derived?.interpretation || '',
        method: s.mic ? 'MIC' : null,
        standard: !provided && derived?.interpretation ? derived.standard : null,
      };
    });

    const isolate = await this.prisma.isolate.create({
      data: {
        isolateId: genId('ISO'),
        cultureId: input.cultureId,
        organism: input.organism,
        snomed: input.snomed ?? null,
        susceptibilities: {
          create: effectiveSus.map((s) => ({
            susId: genId('SUS'),
            antibiotic: s.antibiotic,
            mic: s.mic,
            interpretation: s.interpretation,
            method: s.method,
            standard: s.standard,
          })),
        },
      },
      include: { susceptibilities: true },
    });

    // AST expert-rule 검증 — 고유내성·MRSA 표현형 불일치 감지(입력오류 예방). 도출 해석 포함.
    const astWarnings = validateAst(input.organism, effectiveSus);
    if (astWarnings.length > 0) {
      await this.prisma.notification
        .create({ data: { notifyId: `N-AST-${isolate.isolateId}`, ntype: 'AST검토', target: '미생물검사', message: `AST expert-rule 경고 ${astWarnings.length}건(${input.organism}): ${astWarnings.map((w) => w.antibiotic).join(', ')}`.slice(0, 500), createdDt: new Date() } })
        .catch(() => undefined);
    }

    // MDRO 분류(MRSA/VRE/CRE/ESBL/MDR) → 격리 판단 포함 감염관리 알림
    const mdro = classifyMdro(input.organism, effectiveSus);
    const resistant = effectiveSus.some((s) => s.interpretation === 'R');
    let alert = null;
    if (mdro.mdro || resistant) {
      const message = mdro.mdro
        ? `⚠ ${mdro.mdro} 검출 — ${input.organism}(배양 ${input.cultureId}) · ${mdro.reason}${mdro.isolation ? ' · 격리 필요' : ''}`
        : `${input.organism} 내성 검출(배양 ${input.cultureId})`;
      alert = await this.prisma.notification.create({
        data: {
          notifyId: `N-INF-${isolate.isolateId}`,
          ntype: mdro.mdro ? 'MDRO알림' : '내성균알림',
          target: '감염관리팀',
          message,
          createdDt: new Date(),
        },
      });
    }

    // 혈액배양 양성 → 폐루프 위험치 통보(확인응답·재발송 대상). 생명위협이라 fire-and-forget Notification이 아닌
    // CriticalNotify 폐루프(감염관리 알림과 별개로 담당의 확인 필요). 검체가 혈액이고 균이 동정되면 트리거.
    let criticalNotify = null;
    const spec = await this.prisma.specimen.findUnique({
      where: { specimenNo: culture.specimenNo },
      include: { order: { include: { patient: true } } },
    });
    if (this.isBloodSpecimen(spec?.specimenType)) {
      const pt = spec?.order?.patient;
      criticalNotify = await this.prisma.criticalNotify.create({
        data: {
          notifyId: genId('CN'),
          resultId: null,
          category: 'MICRO',
          sourceRef: isolate.isolateId,
          specimenNo: culture.specimenNo,
          patientId: pt?.patientId ?? null,
          patientName: pt?.name ?? null,
          label: '혈액배양 양성',
          value: input.organism,
          notifyTarget: '담당의',
          notifyMethod: '유선',
          dispatchStatus: 'PENDING',
        },
      });
      this.events.emit('critical.created', { notifyId: criticalNotify.notifyId });
    }

    // 법정감염병·의료관련감염 신고 대상(B3) — 검출 시 InfectiousReport(PENDING) + 감염관리 알림.
    // 신고 대상은 활성 카탈로그를 따른다(개정 시 화면에서 갈아 끼움) — 없으면 코드 스타터 규칙
    const nRules = this.catalog.notifiableRules();
    const notifiable = nRules ? classifyNotifiableFrom(input.organism, mdro.mdro, nRules) : classifyNotifiable(input.organism, mdro.mdro);
    let infectiousReport = null;
    if (notifiable.reportable) {
      const pt2 = spec?.order?.patient;
      infectiousReport = await this.prisma.infectiousReport.create({
        data: { isolateId: isolate.isolateId, patientId: pt2?.patientId ?? null, patientName: pt2?.name ?? null, organism: input.organism, disease: notifiable.disease as string, grade: notifiable.grade, specimenNo: culture.specimenNo, status: 'PENDING' },
      });
      // ★알림 PK를 **신고기록ID(reportId)** 기반으로 — 이전에는 `N-NOTIF-${isolateId}` 고정이라
      //   같은 균주 개정 입력 시 동일 PK가 unique 위반으로 던지고 `.catch(()=>undefined)`가 삼켜,
      //   첫 알림을 이미 확인했으면 **개정 시 감염관리팀에 알림이 안 갔다**(법정 신고 누락).
      //   reportId는 신고기록마다 고유(cuid)라 개정마다 새 알림이 뜬다. 실패는 삼키지 않고 로깅.
      await this.notifyInfectionControl(infectiousReport.reportId, notifiable.disease as string, notifiable.grade, input.organism, culture.specimenNo);
    }

    // 최종보고(이미 최종이면 개정) — 단계보고 최종 단계
    const isFinal = culture.reportStatus === 'FINAL' || culture.reportStatus === 'AMENDED';
    const status = isFinal ? 'AMENDED' : 'FINAL';
    // 도출값(effectiveSus) 사용 — 판정 생략 입력을 raw로 찍으면 "ceftriaxone undefined"가 보고서에 남는다
    const astSummary = effectiveSus.map((s) => `${s.antibiotic} ${s.interpretation ?? '판정보류'}`).join(', ');
    const content = `[${status === 'AMENDED' ? '개정' : '최종'}] ${input.organism} — AST: ${astSummary || '없음'}`;
    const [, report] = await this.prisma.$transaction([
      this.prisma.culture.update({
        where: { cultureId: input.cultureId },
        data: { stage: 'AST_FINAL', status: 'COMPLETED', reportStatus: status },
      }),
      this.prisma.cultureReport.create({
        data: { cultureId: input.cultureId, stage: status, status, content, reporter: input.reporter ?? null },
      }),
    ]);

    return { isolate, infectionAlert: alert, criticalNotify, infectiousReport, mdro, astWarnings, report, reportStatus: status };
  }

  /**
   * Antibiogram — 균종×항생제 감수성(%S) 누적 집계(기간 gramDt 기준).
   * CLSI 권고상 n<30이면 통계적 신뢰 낮음 → n 함께 반환해 UI에서 표기.
   */
  async antibiogram(from?: string, to?: string) {
    const fromD = from ? new Date(from) : null;
    const toD = to ? new Date(`${to}T23:59:59`) : null;
    // 기간 필터를 DB로 내린다(2026-07-30 성능 검토) — 종전에는 감수성 전 행을 4단 조인으로
    // 적재한 뒤 JS 루프에서 걸렀다(누적 테이블이라 해마다 단조 증가).
    // 필터 지정 시 gramDt null은 어차피 집계에서 제외되므로 조회 단계에서 함께 제외한다.
    const dateWhere = fromD || toD
      ? {
          isolate: {
            culture: {
              gramDt: { not: null, ...(fromD ? { gte: fromD } : {}), ...(toD ? { lte: toD } : {}) },
            },
          },
        }
      : {};
    const sus = await this.prisma.susceptibility.findMany({
      where: dateWhere,
      select: {
        isolateId: true, antibiotic: true, interpretation: true,
        isolate: { select: { organism: true, culture: { select: { gramDt: true, specimen: { select: { order: { select: { patientId: true } } } } } } } },
      },
    });
    // M3 first-isolate 중복제거(CLSI) — 환자·균종당 첫 균주만 집계. 최초(gramDt 최소) 균주의 isolateId 선정.
    const firstIsolate = new Map<string, { isolateId: string; dt: number }>(); // key=patient|organism
    for (const s of sus) {
      const org = s.isolate.organism; const patient = s.isolate.culture?.specimen?.order?.patientId ?? '?';
      if (!org || org.includes('무증식')) continue;
      const key = `${patient}|${org}`;
      const dt = s.isolate.culture?.gramDt?.getTime() ?? Number.MAX_SAFE_INTEGER;
      const cur = firstIsolate.get(key);
      if (!cur || dt < cur.dt) firstIsolate.set(key, { isolateId: s.isolateId, dt });
    }
    const keepIsolates = new Set([...firstIsolate.values()].map((v) => v.isolateId));
    // 균종 → 항생제 → {S, total}, 균종별 분리주 수(distinct isolate)
    const byOrg = new Map<string, { abx: Map<string, { S: number; total: number }>; isolates: Set<string> }>();
    const abxSet = new Set<string>();
    for (const s of sus) {
      const org = s.isolate.organism, abx = s.antibiotic, interp = s.interpretation;
      if (!org || !abx || !interp || org.includes('무증식')) continue;
      if (!keepIsolates.has(s.isolateId)) continue; // M3 first-isolate만
      const g = s.isolate.culture?.gramDt ?? null;
      // 기간 필터가 지정됐는데 일자 미상(gramDt null)이면 집계에서 제외(모든 기간 오집계 방지)
      if ((fromD || toD) && !g) continue;
      if (fromD && g && g < fromD) continue;
      if (toD && g && g > toD) continue;
      abxSet.add(abx);
      let o = byOrg.get(org);
      if (!o) { o = { abx: new Map(), isolates: new Set() }; byOrg.set(org, o); }
      o.isolates.add(s.isolateId);
      let c = o.abx.get(abx);
      if (!c) { c = { S: 0, total: 0 }; o.abx.set(abx, c); }
      c.total++;
      if (interp === 'S') c.S++;
    }
    const antibiotics = [...abxSet].sort();
    const organisms = [...byOrg.entries()]
      .map(([organism, o]) => ({
        organism,
        isolateCount: o.isolates.size,
        cells: antibiotics.map((a) => {
          const c = o.abx.get(a);
          return c ? { antibiotic: a, n: c.total, pctS: Math.round((c.S / c.total) * 100) } : { antibiotic: a, n: 0, pctS: null };
        }),
      }))
      .sort((a, b) => b.isolateCount - a.isolateCount);
    return { from: from ?? null, to: to ?? null, antibiotics, organisms, firstIsolateOnly: true };
  }

  /** M1 검체 부적합·반려 — 오염·부적절 채취·이송지연 등. 균 동정 후(isolate 존재)엔 반려 불가. */
  async rejectCulture(cultureId: string, dto: { reason: string; rejectedBy?: string }) {
    const c = await this.prisma.culture.findUnique({ where: { cultureId }, include: { isolates: true } });
    if (!c) throw new NotFoundException(`배양 없음: ${cultureId}`);
    if (!dto.reason?.trim()) throw new BadRequestException('반려 사유(reason) 필요');
    if (c.isolates.length > 0 || c.reportStatus === 'FINAL') throw new BadRequestException('동정/최종보고된 배양은 반려 불가');
    return this.prisma.culture.update({
      where: { cultureId },
      data: { rejectStatus: 'REJECTED', rejectReason: dto.reason.trim(), rejectedBy: dto.rejectedBy ?? null, rejectedDt: new Date(), status: '반려', reportStatus: 'REJECTED' },
    });
  }

  /** M2 선택적/cascade AST 보고 — 분리주별 감수성에 보고 여부(억제) 주석. 스타터 규칙(검사실 확정). */
  async selectiveAst(cultureId: string) {
    const c = await this.prisma.culture.findUnique({ where: { cultureId }, include: { isolates: { include: { susceptibilities: true } } } });
    if (!c) throw new NotFoundException(`배양 없음: ${cultureId}`);
    return {
      cultureId,
      isolates: c.isolates.map((iso) => {
        const sel = selectiveAstReport(iso.susceptibilities.map((s) => ({ antibiotic: s.antibiotic ?? '', interpretation: s.interpretation })));
        return { isolateId: iso.isolateId, organism: iso.organism, firstLineSusceptible: sel.firstLineSusceptible, ast: sel.items };
      }),
    };
  }

  /**
   * 무증식(No growth) 최종보고 — 균주를 생성하지 않고 배양을 종결.
   * 배양 음성은 그람 예비보고나 동정 없이도 확정 가능(48~72h 무증식). 가짜 균주 행을 만들지 않음.
   */
  async recordNoGrowth(input: { cultureId: string; reporter?: string }) {
    const culture = await this.prisma.culture.findUnique({ where: { cultureId: input.cultureId } });
    if (!culture) throw new NotFoundException(`배양 없음: ${input.cultureId}`);
    const isFinal = culture.reportStatus === 'FINAL' || culture.reportStatus === 'AMENDED';
    const status = isFinal ? 'AMENDED' : 'FINAL';
    const content = `[${status === 'AMENDED' ? '개정' : '최종'}] 무증식(No growth)`;
    const [, report] = await this.prisma.$transaction([
      this.prisma.culture.update({
        where: { cultureId: input.cultureId },
        data: { stage: 'AST_FINAL', status: 'COMPLETED', reportStatus: status },
      }),
      this.prisma.cultureReport.create({
        data: { cultureId: input.cultureId, stage: status, status, content, reporter: input.reporter ?? null },
      }),
    ]);
    return { noGrowth: true, report, reportStatus: status };
  }

  /**
   * 감염관리 MDRO line list(B3) — 최근 균주 중 MDRO/내성 검출 건을 환자·균·유형·검체·일자로 집계.
   * 감염관리팀 서베일런스·격리 대상 파악용.
   */
  async mdroLineList(from?: string, to?: string) {
    const where = from || to ? { culture: { gramDt: { ...(from ? { gte: new Date(from) } : {}), ...(to ? { lte: new Date(to) } : {}) } } } : {};
    const isolates = await this.prisma.isolate.findMany({
      where,
      include: { susceptibilities: true, culture: { include: { specimen: { include: { order: { include: { patient: { select: { patientId: true, name: true } } } } } } } } },
      orderBy: { isolateId: 'desc' },
      take: 500,
    });
    const rows = [];
    for (const iso of isolates) {
      const mdro = classifyMdro(iso.organism, iso.susceptibilities);
      const resistantAbx = iso.susceptibilities.filter((s) => s.interpretation === 'R').map((s) => s.antibiotic).filter((a): a is string => !!a);
      const resistant = resistantAbx.length > 0;
      if (!mdro.mdro && !resistant) continue;
      const pt = iso.culture.specimen.order.patient;
      rows.push({
        isolateId: iso.isolateId,
        patientId: pt.patientId,
        patientName: pt.name,
        specimenNo: iso.culture.specimenNo,
        organism: iso.organism,
        mdro: mdro.mdro,
        isolation: mdro.isolation,
        resistant,
        resistantAbx, // 내성 항생제 패턴(감염관리 라인리스트 — '내성' 여부만으론 부족)
        reportedDt: iso.culture.gramDt,
      });
    }
    return { total: rows.length, rows };
  }

  /**
   * 감염관리팀 알림 생성(법정감염병 신고 대상 검출·개정 공통).
   * 신고기록 1건당 알림 1건. 실패는 **삼키지 않고 로깅**한다 — 알림 누락은 법정 신고 누락으로 이어진다.
   */
  private async notifyInfectionControl(reportId: string, disease: string, grade: string | null | undefined, organism: string, specimenNo?: string | null): Promise<void> {
    try {
      await this.prisma.notification.create({
        data: {
          notifyId: `N-NOTIF-${reportId}`,
          ntype: '법정감염병신고',
          target: '감염관리팀',
          message: `⚠ 신고대상 ${disease}(${grade ?? '-'}) — ${organism}${specimenNo ? `(검체 ${specimenNo})` : ''}`.slice(0, 500),
          createdDt: new Date(),
        },
      });
    } catch (e) {
      this.logger.error(`감염관리팀 알림 생성 실패(신고기록 ${reportId}, ${disease}) — 신고 대기 목록으로 반드시 확인 필요: ${e instanceof Error ? e.message : e}`);
    }
  }

  /** 법정감염병 신고 대기 목록(B3) — 미신고(PENDING) 검출 건. */
  async listNotifiable(status = 'PENDING') {
    const rows = await this.prisma.infectiousReport.findMany({
      where: { status }, orderBy: { detectedDt: 'desc' }, take: 300,
      include: { _count: { select: { attachments: true } } },
    });
    return rows.map(({ _count, ...r }) => ({ ...r, attachmentCount: _count.attachments }));
  }

  /**
   * 분리주 근거 종합 번들 — 감수성 판정 근거를 한 곳에(균종·MIC→S/I/R·브레이크포인트·expert-rule·
   * MDRO·법정감염병·환자 과거 내성 이력). 판독 검토용이자 향후 원내 LLM(RAG) 컨텍스트. 외부 전송 없음.
   */
  async evidenceContext(isolateId: string) {
    const iso = await this.prisma.isolate.findUnique({
      where: { isolateId },
      include: { susceptibilities: true, culture: { include: { specimen: { include: { order: { include: { patient: true } } } } } } },
    });
    if (!iso) throw new NotFoundException(`분리주 없음: ${isolateId}`);
    const active = this.catalog.activeAst();
    const stdBasis = active?.standard ?? STARTER_STANDARD; // 활성 카탈로그 미반입 시 스타터 기준 명시
    const susIn = iso.susceptibilities.map((s) => ({ antibiotic: s.antibiotic, interpretation: s.interpretation }));

    // 감수성 — 저장된 확정 판정을 그대로 쓰고, 브레이크포인트 요약만 근거로 덧붙임(재판정 안 함)
    const susceptibilities = iso.susceptibilities.map((s) => {
      const bp = interpretMic(iso.organism, s.antibiotic ?? '', s.mic ?? '', active);
      const note = bp.breakpoint ? `S≤${bp.breakpoint.s} / R≥${bp.breakpoint.r}` : bp.note ?? null;
      return { antibiotic: s.antibiotic, mic: s.mic, interpretation: s.interpretation, method: s.method, standard: s.standard ?? stdBasis, breakpointNote: note };
    });

    const warnings = validateAst(iso.organism, susIn);
    const mdro = classifyMdro(iso.organism, iso.susceptibilities);
    const nRules = this.catalog.notifiableRules();
    const notifiable = nRules ? classifyNotifiableFrom(iso.organism, mdro.mdro, nRules) : classifyNotifiable(iso.organism, mdro.mdro);

    // 환자 과거 내성 이력 — 같은 환자의 다른 분리주에서 나온 R 결과(현재 분리주 제외)
    const patientId = iso.culture.specimen.order.patient?.patientId;
    let priorResistance: { organism: string | null; antibiotic: string | null; interpretation: string | null; specimenNo: string | null; reportedDate: string | null }[] = [];
    if (patientId) {
      const priors = await this.prisma.isolate.findMany({
        where: { isolateId: { not: isolateId }, culture: { specimen: { order: { patientId } } }, susceptibilities: { some: { interpretation: 'R' } } },
        include: { susceptibilities: { where: { interpretation: 'R' } }, culture: { select: { specimenNo: true, gramDt: true } } },
        orderBy: { isolateId: 'desc' }, take: 20,
      });
      priorResistance = priors.flatMap((p) =>
        p.susceptibilities.map((s) => ({ organism: p.organism, antibiotic: s.antibiotic, interpretation: s.interpretation, specimenNo: p.culture.specimenNo, reportedDate: p.culture.gramDt ? p.culture.gramDt.toISOString().slice(0, 10) : null })),
      );
    }

    return buildMicroEvidenceContext({
      organism: iso.organism,
      specimenType: iso.culture.specimen.specimenType,
      specimenNo: iso.culture.specimenNo,
      susceptibilities,
      warnings,
      mdro: { mdro: mdro.mdro, isolation: mdro.isolation },
      notifiable: { reportable: notifiable.reportable, disease: notifiable.disease, grade: notifiable.grade },
      priorResistance,
      standard: stdBasis,
    });
  }

  /** 법정감염병 신고 완료 처리(B3) — 신고 후 상태 NOTIFIED로. */
  async markNotified(reportId: string, notifiedBy?: string, note?: string, reportNo?: string) {
    const r = await this.prisma.infectiousReport.findUnique({ where: { reportId } });
    if (!r) throw new NotFoundException(`신고 기록 없음: ${reportId}`);
    // 완료 근거 강제 — 보건소 신고 서류(스캔/사진)를 최소 1건 첨부해야 완료 처리(감사·소명).
    const attachCount = await this.prisma.resultAttachment.count({ where: { reportId } });
    if (attachCount === 0) {
      throw new BadRequestException('신고 서류(스캔/사진)를 첨부한 뒤 완료하세요 — 법정 신고 완료 근거가 필요합니다');
    }
    if (!reportNo?.trim()) throw new BadRequestException('보건소 신고번호(접수번호)를 입력하세요');
    return this.prisma.infectiousReport.update({
      where: { reportId },
      data: { status: 'NOTIFIED', notifiedDt: new Date(), notifiedBy: notifiedBy ?? null, reportNo: reportNo.trim(), note: note ?? r.note },
    });
  }
}
