/**
 * NgsService — ngs 도메인 서비스.
 *
 * 주요 진입점: `createRun()`, `runPatients()`, `deleteFinding()`, `completeRun()`, `ingestVcf()`, `suggestTier()`, `addFinding()`, `getRun()`…
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { evaluateNgsQc } from '../../domain/ngs-qc';
import { parseVcf } from '../../domain/genomic';
import { suggestSomaticTier } from '../../domain/somatic-tier';
import { geneKnowledge } from '../../domain/genomic-ai-interpret';
import { CatalogService } from '../catalog/catalog.service';

/** 패널 마스터 컬럼(q30Min…)을 QC 판정 입력(q30…)으로 맞춘다. */
function panelThresholds(p: { q30Min: number | null; meanCoverageMin: number | null; uniformityMin: number | null } | null) {
  return p ? { q30: p.q30Min, meanCoverage: p.meanCoverageMin, uniformityPct: p.uniformityMin } : null;
}

const CATEGORIES = ['VARIANT', 'FUSION', 'CNV', 'TMB', 'MSI'];
const TIERS = ['TIER_I', 'TIER_II', 'TIER_III', 'TIER_IV'];

/**
 * 종양(체세포) NGS Run/QC 파운데이션(D5, C-대) — 시퀀싱 런 QC + 체세포 소견(변이·융합·CNV·TMB·MSI·tier).
 * ⚠ **NGS 파이프라인 규격(VCF 파싱·tier 자동판정·therapy 매칭)은 대기(stub)** — 여기선 구조·QC·수기 등록만.
 * 생식세포(germline ACMG, genomic 모듈)와 분리 — somatic을 SF 이차소견으로 오분류 방지.
 */
@Injectable()
export class NgsService {
  constructor(private readonly prisma: PrismaService, private readonly catalog: CatalogService) {}

  /**
   * 런 생성 — 검체를 함께 받는다.
   * 검체가 없으면 소견이 **누구 것인지 알 수 없어** 환자 보고에 쓸 수 없다(다검체 pooling 런 포함).
   * 존재하지 않는 검체번호는 여기서 거른다(나중에 보고 단계에서 발견하면 재작업).
   */
  async createRun(dto: { runName: string; flowcell?: string; note?: string; panelCode?: string; specimenNos?: string[] }) {
    if (!dto.runName?.trim()) throw new BadRequestException('런 이름(runName) 필요');
    const list = (dto.specimenNos ?? []).map((x) => x.trim()).filter(Boolean);
    if (list.length) {
      const found = await this.prisma.specimen.findMany({ where: { specimenNo: { in: list } }, select: { specimenNo: true } });
      const missing = list.filter((x) => !found.some((f) => f.specimenNo === x));
      if (missing.length) throw new BadRequestException(`등록되지 않은 검체: ${missing.join(', ')}`);
    }
    return this.prisma.ngsRun.create({
      data: {
        runName: dto.runName.trim(),
        flowcell: dto.flowcell ?? null,
        note: dto.note ?? null,
        panelCode: dto.panelCode ?? null,
        specimenNos: list.length ? list.join(',') : null,
        primarySpecimenNo: list[0] ?? null,
      },
    });
  }

  /** 런에 올린 검체의 환자 정보 — 소견을 누구에게 보고하는지 화면이 보여줘야 한다. */
  async runPatients(runId: string) {
    const run = await this.prisma.ngsRun.findUnique({ where: { runId } });
    if (!run) throw new NotFoundException(`런 없음: ${runId}`);
    const nos = (run.specimenNos ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    if (nos.length === 0) return [];
    const specs = await this.prisma.specimen.findMany({
      where: { specimenNo: { in: nos } },
      select: { specimenNo: true, order: { select: { patient: { select: { patientId: true, name: true } } } } },
    });
    return specs.map((sp) => ({ specimenNo: sp.specimenNo, patientId: sp.order.patient.patientId, patientName: sp.order.patient.name }));
  }

  /** 소견 삭제 — 오등록 정정(등록만 되고 지울 방법이 없었다). */
  async deleteFinding(findingId: string) {
    const f = await this.prisma.somaticFinding.findUnique({ where: { findingId } });
    if (!f) throw new NotFoundException(`소견 없음: ${findingId}`);
    await this.prisma.somaticFinding.delete({ where: { findingId } });
    return { deleted: findingId };
  }

  /** 런 QC 확정 — Q30·reads·커버리지·균일도 기록 후 COMPLETE(또는 FAILED). */
  async completeRun(runId: string, dto: { status?: string; q30?: number; totalReads?: number; meanCoverage?: number; uniformityPct?: number }) {
    const run = await this.prisma.ngsRun.findUnique({ where: { runId } });
    if (!run) throw new NotFoundException(`런 없음: ${runId}`);
    const status = dto.status === 'FAILED' ? 'FAILED' : 'COMPLETE';
    return this.prisma.ngsRun.update({
      where: { runId },
      data: { status, q30: dto.q30 ?? run.q30, totalReads: dto.totalReads ?? run.totalReads, meanCoverage: dto.meanCoverage ?? run.meanCoverage, uniformityPct: dto.uniformityPct ?? run.uniformityPct, completedDt: new Date() },
    });
  }

  /**
   * VCF 소견 자동 등록 — VCF의 GENE·AF로 체세포 VARIANT 소견을 생성(수기 입력 대체).
   * ⚠ 파이프라인 규격(HGVS·tier·therapy)은 대기 — 여기선 표준 VCF의 GENE·좌위·AF만 사용.
   *   HGVS·tier는 판독자가 tier 제안(근거 DB)으로 정련한다. 같은 런의 (gene+좌위) 중복은 건너뛴다.
   */
  async ingestVcf(runId: string, vcf: string) {
    const run = await this.prisma.ngsRun.findUnique({ where: { runId } });
    if (!run) throw new NotFoundException(`런 없음: ${runId}`);
    const parsed = parseVcf(vcf);
    const withGene = parsed.filter((v) => v.gene && v.gene.trim());
    const existing = new Set(
      (await this.prisma.somaticFinding.findMany({ where: { runId }, select: { gene: true, alteration: true } })).map((f) => `${f.gene}|${f.alteration}`),
    );
    const created: { findingId: string; gene: string; alteration: string; vaf: number | null }[] = [];
    let skipped = 0;
    for (const v of withGene) {
      const alteration = `${v.chrom}:${v.pos} ${v.refAllele}>${v.altAllele}`; // 유전체 표기(HGVS 미제공)
      const key = `${v.gene}|${alteration}`;
      if (existing.has(key)) { skipped += 1; continue; }
      existing.add(key);
      // VCF AF는 분율(0~1) — 저장은 백분율(0~100)
      const vafPct = v.vaf == null ? null : (v.vaf <= 1 ? Math.round(v.vaf * 1000) / 10 : v.vaf);
      const f = await this.prisma.somaticFinding.create({
        data: { runId, category: 'VARIANT', gene: v.gene, alteration, vaf: vafPct, note: 'VCF 자동 등록 — HGVS·tier는 판독자 정련(tier 제안 활용)' },
      });
      created.push({ findingId: f.findingId, gene: v.gene!, alteration, vaf: vafPct });
    }
    return { parsed: parsed.length, withGene: withGene.length, created: created.length, skipped, findings: created };
  }

  /** 체세포 변이 tier 제안(DRAFT·미기록) — 근거 DB(VARIANT_EVIDENCE·OncoKB)로 AMP/ASCO tier 초안. 확정은 판독자. */
  async suggestTier(gene?: string, alteration?: string) {
    const ev = this.catalog.variantEvidence();
    const hit = ev ? ev.lookup(gene, [alteration]) : null;
    const s = suggestSomaticTier(hit);
    const kb = geneKnowledge(gene);
    // Tier I/II이고 유전자 지식에 표적치료가 있으면 therapy 제안 동봉
    const therapy = s && (s.tier === 'TIER_I' || s.tier === 'TIER_II') ? (kb?.somaticTherapy ?? null) : null;
    return { suggestion: s ? { ...s, therapy } : null, evidenceFound: !!hit, catalogVersion: ev?.version ?? null };
  }

  /** 체세포 소견 등록 — 변이/융합/CNV/TMB/MSI를 category로. tier는 AMP/ASCO Tier I~IV. */
  async addFinding(dto: { runId?: string; genomicOrderId?: string; category: string; gene?: string; alteration?: string; vaf?: number; tier?: string; therapy?: string; note?: string }) {
    if (!CATEGORIES.includes(dto.category)) throw new BadRequestException(`category 오류: ${dto.category} (${CATEGORIES.join('/')})`);
    if (dto.tier && !TIERS.includes(dto.tier)) throw new BadRequestException(`tier 오류: ${dto.tier} (${TIERS.join('/')})`);
    if (!dto.alteration?.trim()) throw new BadRequestException('변경 내용(alteration) 필요');
    // 변이·융합·CNV는 유전자가 있어야 의미가 성립한다. TMB·MSI는 값 자체가 지표라 유전자가 없다.
    if (['VARIANT', 'FUSION', 'CNV'].includes(dto.category) && !dto.gene?.trim()) {
      throw new BadRequestException(`${dto.category}는 유전자(gene)가 필요합니다`);
    }
    if (dto.vaf != null && (dto.vaf < 0 || dto.vaf > 100)) throw new BadRequestException(`VAF는 0~100% 범위여야 합니다(입력: ${dto.vaf})`);
    let qcWarning: string | null = null;
    if (dto.runId) {
      const run = await this.prisma.ngsRun.findUnique({ where: { runId: dto.runId } });
      if (!run) throw new NotFoundException(`런 없음: ${dto.runId}`);
      // QC 미달·실패 런의 소견은 판독에 쓰면 안 된다 — 차단하지 않되 응답에 실어 화면이 경고한다
      if (run.status === 'FAILED') qcWarning = '이 런은 QC 실패로 종료됐습니다 — 소견을 판독에 사용하지 마세요';
      else {
        // 임계는 패널마다 다르다(타깃 패널과 WES는 요구 coverage가 자릿수로 다르다)
        const panel = run.panelCode ? await this.prisma.ngsPanel.findUnique({ where: { panelCode: run.panelCode } }) : null;
        const qc = evaluateNgsQc({ q30: run.q30, meanCoverage: run.meanCoverage, uniformityPct: run.uniformityPct }, panelThresholds(panel));
        if (qc.verdict === 'FAIL') qcWarning = `런 QC 임계 미달(${qc.failed.join(' · ')}) — 판독 시 감안하세요`;
      }
    }
    const finding = await this.prisma.somaticFinding.create({
      data: {
        runId: dto.runId ?? null,
        genomicOrderId: dto.genomicOrderId ?? null,
        category: dto.category,
        gene: dto.gene ?? null,
        alteration: dto.alteration.trim(),
        vaf: dto.vaf ?? null,
        tier: dto.tier ?? null,
        therapy: dto.therapy ?? null,
        note: dto.note ?? null,
        runQcFlag: qcWarning, // QC 경고를 소견에 지속 — 병리 보고서에서 QC-FAIL 런 소견에 주의 표기(전에는 토스트로만 뜨고 유실)
      },
    });
    return { finding, qcWarning };
  }

  async getRun(runId: string) {
    const run = await this.prisma.ngsRun.findUnique({ where: { runId }, include: { findings: { orderBy: { reportedDt: 'asc' } } } });
    if (!run) throw new NotFoundException(`런 없음: ${runId}`);
    // 어떤 임계로 판정했는지 함께 보여준다 — 기준을 모르면 PASS/FAIL이 해석되지 않는다
    const panel = run.panelCode ? await this.prisma.ngsPanel.findUnique({ where: { panelCode: run.panelCode } }) : null;
    const qc = evaluateNgsQc({ q30: run.q30, meanCoverage: run.meanCoverage, uniformityPct: run.uniformityPct }, panelThresholds(panel));
    return { ...run, qc, panel };
  }

  // ── 패널 마스터(QC 임계) ──
  listPanels() {
    return this.prisma.ngsPanel.findMany({ orderBy: { panelCode: 'asc' } });
  }

  async upsertPanel(dto: { panelCode: string; name: string; platform?: string; q30Min?: number | null; meanCoverageMin?: number | null; uniformityMin?: number | null; note?: string }, userId: string | null) {
    const code = dto.panelCode?.trim();
    if (!code) throw new BadRequestException('패널 코드 필요');
    if (!dto.name?.trim()) throw new BadRequestException('패널 이름 필요');
    // 임계는 비율·배수라 음수가 있을 수 없다. 0을 넣으면 사실상 QC를 끄는 것이라 막는다.
    for (const [k, v, unit] of [['Q30', dto.q30Min, '%'], ['평균 coverage', dto.meanCoverageMin, 'x'], ['uniformity', dto.uniformityMin, '%']] as const) {
      if (v != null && v <= 0) throw new BadRequestException(`${k} 임계는 양수여야 합니다(입력: ${v}${unit})`);
    }
    if (dto.q30Min != null && dto.q30Min > 100) throw new BadRequestException('Q30 임계는 100% 이하여야 합니다');
    if (dto.uniformityMin != null && dto.uniformityMin > 100) throw new BadRequestException('uniformity 임계는 100% 이하여야 합니다');
    const data = {
      name: dto.name.trim(),
      platform: dto.platform?.trim() || null,
      q30Min: dto.q30Min ?? null,
      meanCoverageMin: dto.meanCoverageMin ?? null,
      uniformityMin: dto.uniformityMin ?? null,
      note: dto.note?.trim() || null,
      updatedBy: userId,
    };
    return this.prisma.ngsPanel.upsert({ where: { panelCode: code }, create: { panelCode: code, ...data }, update: data });
  }

  /**
   * 런 목록 — 목록만 보고도 무엇을 판독해야 하는지 알 수 있게 요약을 얹는다.
   * 이전엔 이름·상태·날짜만 있어, 어느 런에 몇 개 소견이 있고 QC가 통과했는지 열어봐야 했다.
   */
  async listRuns() {
    const runs = await this.prisma.ngsRun.findMany({
      orderBy: { startedDt: 'desc' },
      take: 200,
      include: { _count: { select: { findings: true } } },
    });
    // 패널별 QC 임계로 verdict 산출(런마다 패널 조회는 소수라 개별). 대표검체 환자명 붙임.
    const panelCodes = [...new Set(runs.map((r) => r.panelCode).filter(Boolean) as string[])];
    const panels = panelCodes.length ? await this.prisma.ngsPanel.findMany({ where: { panelCode: { in: panelCodes } } }) : [];
    const panelBy = new Map(panels.map((p) => [p.panelCode, p]));
    const primNos = [...new Set(runs.map((r) => r.primarySpecimenNo).filter(Boolean) as string[])];
    const specs = primNos.length
      ? await this.prisma.specimen.findMany({ where: { specimenNo: { in: primNos } }, select: { specimenNo: true, order: { select: { patient: { select: { name: true } } } } } })
      : [];
    const patientBy = new Map(specs.map((s) => [s.specimenNo, s.order?.patient?.name ?? null]));

    return runs.map((r) => {
      const p = r.panelCode ? panelBy.get(r.panelCode) : null;
      const qc = evaluateNgsQc(
        { q30: r.q30, meanCoverage: r.meanCoverage, uniformityPct: r.uniformityPct },
        p ? { q30: p.q30Min, meanCoverage: p.meanCoverageMin, uniformityPct: p.uniformityMin } : null,
      );
      const specCount = (r.specimenNos ?? '').split(',').map((x) => x.trim()).filter(Boolean).length;
      return {
        runId: r.runId,
        runName: r.runName,
        flowcell: r.flowcell,
        panelCode: r.panelCode,
        status: r.status,
        startedDt: r.startedDt,
        completedDt: r.completedDt,
        specimenCount: specCount,
        primaryPatient: r.primarySpecimenNo ? (patientBy.get(r.primarySpecimenNo) ?? null) : null,
        findingCount: r._count.findings,
        // QC 지표가 있을 때만 verdict를 의미있게 — 미측정(RUNNING)은 표시 안 함
        qcVerdict: r.q30 != null || r.meanCoverage != null || r.uniformityPct != null ? qc.verdict : null,
      };
    });
  }
}
