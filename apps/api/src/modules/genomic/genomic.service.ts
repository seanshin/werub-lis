/**
 * GenomicService — genomic 도메인 서비스.
 *
 * 주요 진입점: `recordConsent()`, `withdrawConsent()`, `requestSendout()`, `listOrders()`, `getVariants()`, `generateReport()`, `addManualVariant()`, `importVcf()`…
 * 일부 경로는 트랜잭션으로 묶인다 — 부분 반영 시 임상 상태가 깨지는 구간.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { canSendout } from '../../domain/genomic-consent';
import { parseVcf, acmgClassify, isValidClassification, needsRecontact, AcmgEvidence } from '../../domain/genomic';
import { aiInterpret, geneKnowledge, type AiInterpretInput } from '../../domain/genomic-ai-interpret';
import { buildEvidenceContext } from '../../domain/genomic-evidence-context';

import { findingBucket, normalizeGeneSymbol } from '../../domain/genomic-report';
import { evaluateNgsQc } from '../../domain/ngs-qc';
import { genId } from '../../common/id.util';
import { CatalogService } from '../catalog/catalog.service';

interface RecordConsentInput {
  genomicOrderId: string;
  consentType: string;
  secondaryFindingsOptin: boolean;
  signedDate: string;
}

@Injectable()
export class GenomicService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly catalog: CatalogService,
  ) {}

  async recordConsent(input: RecordConsentInput) {
    const order = await this.prisma.genomicOrder.findUnique({
      where: { genomicOrderId: input.genomicOrderId },
    });
    if (!order) throw new NotFoundException(`유전체 오더 없음: ${input.genomicOrderId}`);

    return this.prisma.consent.create({
      data: {
        consentId: genId('CONS'),
        genomicOrderId: input.genomicOrderId,
        consentType: input.consentType,
        secondaryFindingsOptin: input.secondaryFindingsOptin,
        signedDate: input.signedDate,
        withdrawn: false,
      },
    });
  }

  /**
   * 동의 철회 — 환자 권리(05 §3). 최신 활성 동의를 withdrawn 처리.
   * 철회 시 이후 수탁발송 게이트가 차단됨(canSendout). 발송 이후 철회는 기록·알림만(회수는 정책·수탁기관 협의).
   */
  async withdrawConsent(genomicOrderId: string, dto: { reason?: string; actor: string }) {
    const exists = await this.prisma.genomicOrder.findUnique({ where: { genomicOrderId } });
    if (!exists) throw new NotFoundException(`유전체 오더 없음: ${genomicOrderId}`);

    const { count, status } = await this.prisma.$transaction(async (tx) => {
      // G1: 오더당 활성 동의가 여러 건일 수 있음 → **전부** 철회해야 발송 게이트 우회 방지.
      // 이 UPDATE는 동시 발송이 잡은 FOR UPDATE 잠금에 걸려 대기한다(발송이 먼저면 그 뒤에 반영).
      const result = await tx.consent.updateMany({
        where: { genomicOrderId, withdrawn: false },
        data: {
          withdrawn: true,
          withdrawnDate: new Date().toISOString().slice(0, 10),
          withdrawnReason: dto.reason ?? null,
          withdrawnBy: dto.actor,
        },
      });
      if (result.count === 0) throw new BadRequestException('철회할 활성 동의가 없습니다');
      // ★오더 상태는 철회를 반영한 **뒤에** 다시 읽는다. 이전에는 맨 앞에서 한 번 읽어서,
      //   경합 중이던 발송이 그 사이 커밋되면 '접수'로 판단해 회수 알림을 만들지 않았다.
      const fresh = await tx.genomicOrder.findUnique({ where: { genomicOrderId }, select: { status: true } });
      return { count: result.count, status: fresh?.status ?? null };
    });

    // 이미 수탁발송·결과수신 이후면 회수 판단 필요 → 알림(사람 판단, 자동 취소 아님)
    const postSendout = ['수탁발송', '결과수신', '해석확정'].includes(status ?? '');
    if (postSendout) {
      await this.prisma.notification
        .create({
          data: {
            notifyId: genId('NTF'),
            ntype: '동의철회',
            target: genomicOrderId,
            message: `발송 이후 동의 철회(${status}): ${genomicOrderId} — 수탁기관 회수·2차소견 중단 확인 필요`,
            createdDt: new Date(),
          },
        })
        .catch(() => undefined);
    }
    return { withdrawnCount: count, withdrawn: true, orderStatus: status, postSendout };
  }

  /**
   * 수탁 발송 요청 — 동의 게이트(05 §3) 통과 시에만 진행.
   */
  async requestSendout(genomicOrderId: string) {
    return this.prisma.$transaction(async (tx) => {
      // ★동의 행을 **잠근다**(SELECT ... FOR UPDATE).
      //   이전에는 "트랜잭션 안에서 재조회"만 했는데, Postgres 기본 격리수준(READ COMMITTED)에서는
      //   읽기가 아무 잠금도 잡지 않아 TOCTOU가 그대로 성립했다:
      //     ① 발송이 동의를 읽어 게이트 통과 → ② 환자가 철회(커밋) → ③ 발송이 '수탁발송'으로 커밋
      //   결과: **동의를 철회한 환자의 검체가 외부 수탁기관으로 나간다.** 게다가 철회 쪽은 ②시점에
      //   오더 상태를 '접수'로 읽어 발송 이후 알림도 만들지 않아, 아무도 모른 채 지나간다.
      //   잠금을 잡으면 ②가 커밋될 때까지 대기하고, 반대 순서면 발송이 철회를 보고 차단된다.
      const rows = await tx.$queryRaw<{ signed_date: string | null; withdrawn: boolean }[]>`
        SELECT signed_date, withdrawn FROM consent
        WHERE genomic_order_id = ${genomicOrderId}
        FOR UPDATE
      `;
      // 잠근 행들 중 최신 활성 동의 — findFirst(withdrawn:false, signedDate desc)와 동일 규칙.
      const consent = rows
        .filter((r) => !r.withdrawn)
        .sort((a, b) => (b.signed_date ?? '').localeCompare(a.signed_date ?? ''))[0];

      const gate = canSendout({
        exists: !!consent,
        signedDate: consent?.signed_date ?? null,
        withdrawn: consent?.withdrawn ?? false,
      });
      if (!gate.allowed) {
        throw new BadRequestException({ message: '수탁 발송 불가', reason: gate.reason });
      }

      return tx.genomicOrder.update({
        where: { genomicOrderId },
        data: { status: '수탁발송' },
      });
    });
  }

  /** 유전체 대기 워크리스트 — 미완료(결과수신·미해석) 오더. */
  async listOrders() {
    const orders = await this.prisma.genomicOrder.findMany({
      include: { order: { include: { patient: true } } },
      orderBy: { genomicOrderId: 'desc' },
      take: 100,
    });
    // 변이 건수·미해결 건수는 집계로 센다(2026-07-30 성능 검토) — 종전에는 오더 100건의
    // 전 변이와 그 전 해석을 적재해 JS로 셌다. NGS는 오더 하나에 변이가 수백~수천이다.
    const ids = orders.map((o) => o.genomicOrderId);
    const [countAll, countUnresolved] = ids.length
      ? await Promise.all([
          this.prisma.variant.groupBy({ by: ['genomicOrderId'], where: { genomicOrderId: { in: ids } }, _count: { _all: true } }),
          this.prisma.variant.groupBy({
            by: ['genomicOrderId'],
            where: { genomicOrderId: { in: ids }, interpretations: { none: { status: 'FINAL' } } },
            _count: { _all: true },
          }),
        ])
      : [[], []];
    const totalBy = new Map(countAll.map((g) => [g.genomicOrderId, g._count._all]));
    const unresolvedBy = new Map(countUnresolved.map((g) => [g.genomicOrderId, g._count._all]));
    return orders.map((o) => {
      const variantCount = totalBy.get(o.genomicOrderId) ?? 0;
      const unresolved = unresolvedBy.get(o.genomicOrderId) ?? 0;
      return {
        genomicOrderId: o.genomicOrderId,
        patientName: o.order?.patient?.name ?? '',
        patientId: o.order?.patient?.patientId ?? null,
        panelCode: o.panelCode,
        testType: o.testType,
        status: o.status ?? '접수',
        // 수탁 워크리스트에 필요한 정보 — 어디로 보냈고(수탁기관) 언제까지(TAT)·보고서 상태
        sendoutCenter: o.sendoutCenter ?? null,
        tatTarget: o.tatTarget ?? null,
        reportStatus: o.reportStatus ?? null,
        variantCount,
        unresolved,
      };
    });
  }

  async getVariants(genomicOrderId: string) {
    return this.prisma.variant.findMany({
      where: { genomicOrderId },
      include: { interpretations: { orderBy: { classifiedDate: 'asc' } } },
    });
  }

  /**
   * 유전체 임상 보고서 조립 — 변이별 최신 FINAL 해석을 1차/이차 소견으로 분류.
   * 이차소견(ACMG SF 유전자 P/LP)은 환자 동의(secondaryFindingsOptin) 시에만 보고.
   * 미확정(FINAL 없음) 변이는 보고서에서 제외(unresolved로 집계).
   */
  async generateReport(genomicOrderId: string) {
    const order = await this.prisma.genomicOrder.findUnique({
      where: { genomicOrderId },
      include: { order: { include: { patient: true } }, variants: { include: { interpretations: true } } },
    });
    if (!order) throw new NotFoundException(`유전체 오더 없음: ${genomicOrderId}`);

    const consent = await this.prisma.consent.findFirst({
      where: { genomicOrderId, withdrawn: false },
      orderBy: { signedDate: 'desc' },
    });
    const sfOptin = consent?.secondaryFindingsOptin ?? false;
    // 철회된 동의도 별도 조회 — 활성 동의가 없을 때 '철회됨'을 화면에 지속 표시(빈 상태와 구분).
    const withdrawnConsent = consent ? null : await this.prisma.consent.findFirst({
      where: { genomicOrderId, withdrawn: true },
      orderBy: { withdrawnDate: 'desc' },
    });

    const findings: { variantId: string; gene: string | null; hgvsC: string | null; hgvsP: string | null; zygosity: string | null; classification: string | null; evidence: string | null; bucket: 'secondary' | 'primary' | 'review' }[] = [];
    for (const v of order.variants) {
      const latest = v.interpretations
        .filter((i) => i.status === 'FINAL')
        .sort((a, b) => (a.classifiedDate ?? '').localeCompare(b.classifiedDate ?? ''))
        .pop();
      if (!latest) continue; // 미확정 변이 제외
      findings.push({
        variantId: v.variantId, gene: v.gene, hgvsC: v.hgvsC, hgvsP: v.hgvsP, zygosity: v.zygosity,
        classification: latest.classification, evidence: latest.evidence,
        bucket: findingBucket(v.gene, latest.classification),
      });
    }

    const primary = findings.filter((f) => f.bucket === 'primary');
    const secondaryAll = findings.filter((f) => f.bucket === 'secondary');
    // 유전자 심볼 미확정 P/LP — 자동 보고 금지, 큐레이션 보류(누출 방지)
    const reviewCount = findings.filter((f) => f.bucket === 'review').length;
    return {
      genomicOrderId,
      patient: { patientId: order.order?.patient?.patientId ?? null, name: order.order?.patient?.name ?? null },
      panelCode: order.panelCode,
      status: order.status,
      reportStatus: order.reportStatus ?? null,
      reportSignedBy: order.reportSignedBy ?? null,
      reportSignedDt: order.reportSignedDt ? order.reportSignedDt.toISOString() : null,
      consent: {
        present: !!consent, secondaryFindingsOptin: sfOptin,
        consentType: consent?.consentType ?? null, signedDate: consent?.signedDate ?? null,
        withdrawn: !!withdrawnConsent,
        withdrawnDate: withdrawnConsent?.withdrawnDate ?? null,
        withdrawnReason: withdrawnConsent?.withdrawnReason ?? null,
      },
      primary,
      secondary: sfOptin ? secondaryAll : [], // 미동의 시 이차소견 제외
      // 미동의 시 억제 '건수'조차 SF 존재를 누설하므로 비공개(0). 동의 시에만 노출.
      secondarySuppressed: sfOptin ? 0 : (secondaryAll.length > 0 ? null : 0),
      reviewCount, // 유전자 심볼 미확정으로 보류된 P/LP 건수(임상 큐레이션 필요)
      // ★건수만으로는 어느 변이인지 알 수 없어 보류가 방치된다 — 보정 대상을 식별해서 준다.
      //   심볼을 판정할 수 없었으므로 SF 여부도 미상이고, 보정은 어차피 큐레이터의 몫이다.
      review: findings.filter((f) => f.bucket === 'review'),
      unresolved: order.variants.length - findings.length,
    };
  }

  /** 수탁 VCF 결과 수신 → 변이 등록. 유전체 오더는 수탁발송 상태여야. */
  /**
   * 수기 변이 단건 입력 — 수탁이 PDF 등 비구조화 결과지로만 보낼 때(VCF 부재).
   * 판독자가 결과지를 읽고 유전자·HGVS·VAF를 직접 등록 → 이후 ACMG 큐레이션·보고서 흐름 동일.
   */
  async addManualVariant(genomicOrderId: string, dto: { gene?: string; hgvsC?: string; hgvsP?: string; vaf?: number; zygosity?: string; chrom?: string; pos?: number; refAllele?: string; altAllele?: string }) {
    const order = await this.prisma.genomicOrder.findUnique({ where: { genomicOrderId } });
    if (!order) throw new NotFoundException(`유전체 오더 없음: ${genomicOrderId}`);
    // 완료 근거 강제 — 수기 전사(외부 수탁 결과지 PDF→변이 입력)는 원본 결과지를 오더에 첨부해야 한다.
    // 전사한 변이가 ACMG 판정·보고서로 흐르는데 원본이 없으면 대사·감사가 불가. (VCF 반입은 구조화 원본이라 별도.)
    const attachCount = await this.prisma.resultAttachment.count({ where: { genomicOrderId } });
    if (attachCount === 0) {
      throw new BadRequestException('수탁 회신 원본 결과지(스캔·PDF)를 이 오더에 첨부한 뒤 변이를 입력하세요 — 전사 근거가 필요합니다');
    }
    if (!dto.gene?.trim() && !dto.hgvsC?.trim() && !dto.hgvsP?.trim()) throw new BadRequestException('유전자 또는 HGVS(c./p.) 중 하나는 필요합니다');
    if (dto.vaf != null && (dto.vaf < 0 || dto.vaf > 100)) throw new BadRequestException(`VAF는 0~100 범위: ${dto.vaf}`);
    const created = await this.prisma.variant.create({
      data: {
        variantId: genId('VAR'),
        genomicOrderId,
        gene: dto.gene?.trim() || null,
        hgvsC: dto.hgvsC?.trim() || null,
        hgvsP: dto.hgvsP?.trim() || null,
        vaf: dto.vaf ?? null,
        zygosity: dto.zygosity?.trim() || null,
        chrom: dto.chrom?.trim() || null,
        pos: dto.pos ?? null,
        refAllele: dto.refAllele?.trim() || null,
        altAllele: dto.altAllele?.trim() || null,
      },
    });
    if (order.status !== '결과수신') await this.prisma.genomicOrder.update({ where: { genomicOrderId }, data: { status: '결과수신' } });
    return created;
  }

  async importVcf(genomicOrderId: string, vcf: string) {
    const order = await this.prisma.genomicOrder.findUnique({ where: { genomicOrderId } });
    if (!order) throw new NotFoundException(`유전체 오더 없음: ${genomicOrderId}`);
    const parsed = parseVcf(vcf);
    if (parsed.length === 0) throw new BadRequestException('VCF에서 변이를 찾을 수 없습니다');

    const created = [];
    for (const v of parsed) {
      // VCF AF는 분율(0~1) — 저장은 백분율(0~100)로 통일(수기 입력·NGS 소견과 같은 스케일, 표시 혼란 방지).
      const vafPct = v.vaf == null ? null : v.vaf <= 1 ? Math.round(v.vaf * 1000) / 10 : v.vaf;
      created.push(
        await this.prisma.variant.create({
          data: {
            variantId: genId('VAR'),
            genomicOrderId,
            chrom: v.chrom,
            pos: v.pos,
            refAllele: v.refAllele,
            altAllele: v.altAllele,
            gene: v.gene,
            vaf: vafPct,
            zygosity: v.zygosity,
          },
        }),
      );
    }
    await this.prisma.genomicOrder.update({ where: { genomicOrderId }, data: { status: '결과수신' } });
    return { genomicOrderId, imported: created.length, variants: created };
  }

  /** ACMG 근거 → 분류 제안(큐레이션 보조). */
  acmgSuggest(evidence: AcmgEvidence) {
    return { classification: acmgClassify(evidence) };
  }

  /**
   * AI 해석 초안 — 로컬 지식기반. 판단을 대체하지 않고 근거·표적치료 시사점 정리를 돕는다.
   * ★환자 데이터는 시스템 밖으로 나가지 않는다(외부 LLM 호출 없음).
   */
  aiInterpret(input: AiInterpretInput) {
    // 활성 변이근거 DB(ClinVar/gnomAD/OncoKB)에서 gene+HGVS로 인용을 찾아 해석에 그라운딩한다.
    // 없으면 근거 없이(지식기반+ACMG만) 해석한다.
    const ev = this.catalog.variantEvidence();
    const hit = ev ? ev.lookup(input.gene, [input.hgvsP, input.hgvsC]) : null;
    const cited = hit
      ? {
          significance: hit.significance || undefined,
          stars: hit.stars,
          gnomadAf: hit.gnomad_af,
          condition: hit.condition || undefined,
          source: hit.source || undefined,
          citation: hit.citation || undefined,
          oncokbLevel: hit.oncokb_level || undefined,
          catalogVersion: ev?.version,
        }
      : null;
    return aiInterpret(input, cited);
  }

  /** 변이 큐레이션 — 해석(초안 DRAFT) 등록. */
  async curateVariant(variantId: string, dto: { classification: string; evidence?: string; classifier: string }) {
    const variant = await this.prisma.variant.findUnique({ where: { variantId } });
    if (!variant) throw new NotFoundException(`변이 없음: ${variantId}`);
    if (!isValidClassification(dto.classification)) {
      throw new BadRequestException(`분류 오류: ${dto.classification}`);
    }
    return this.prisma.interpretation.create({
      data: {
        interpId: genId('INT'),
        variantId,
        classification: dto.classification,
        evidence: dto.evidence ?? null,
        classifier: dto.classifier,
        classifiedDate: new Date().toISOString().slice(0, 10),
        status: 'DRAFT',
      },
    });
  }

  /**
   * 유전자 심볼 보정(P4) — 심볼이 비어 있거나 기호뿐이라 **정규화 불가**한 변이만 대상.
   *
   * 그런 변이의 P/LP는 SF 여부를 판정할 수 없어 review 버킷에 갇히고(무동의 이차소견 누출 방지)
   * 보고서 primary/secondary 어디에도 들어가지 않는다. 수정 경로가 없으면 확정된 P/LP가 영영 보고되지 않는다.
   *
   * 대상을 '정규화 불가'로 한정하는 이유: 이미 심볼이 확정된 변이의 유전자를 갈아끼우면
   * SF 판정(=동의 게이트)이 조용히 뒤집힌다. 그런 변경은 이 경로로 허용하지 않는다.
   * 보정 후 SF 유전자로 판명되면 자동으로 secondary 버킷 = 동의 게이트가 적용된다.
   */
  async correctVariantGene(variantId: string, dto: { gene: string; reason: string; corrector: string }) {
    const variant = await this.prisma.variant.findUnique({ where: { variantId } });
    if (!variant) throw new NotFoundException(`변이 없음: ${variantId}`);
    if (normalizeGeneSymbol(variant.gene)) {
      throw new BadRequestException(`이미 유전자 심볼이 확정된 변이입니다(${variant.gene}) — 보정 대상이 아닙니다(재분류 경로 사용)`);
    }
    const gene = dto.gene.trim();
    const normalized = normalizeGeneSymbol(gene);
    if (!normalized) throw new BadRequestException(`유효한 유전자 심볼이 아닙니다: ${dto.gene}`);
    if (!dto.reason?.trim()) throw new BadRequestException('보정 근거(reason)는 필수입니다');
    const updated = await this.prisma.variant.update({ where: { variantId }, data: { gene } });
    // 변경 전후·주체·사유는 감사 인터셉터가 요청 단위로 남긴다(부인방지).
    return { variantId, gene: updated.gene, normalized, reason: dto.reason.trim(), correctedBy: dto.corrector };
  }

  /** 해석 확정 — DRAFT → FINAL. */
  async finalizeInterpretation(interpId: string) {
    const interp = await this.prisma.interpretation.findUnique({ where: { interpId } });
    if (!interp) throw new NotFoundException(`해석 없음: ${interpId}`);
    if (interp.status !== 'DRAFT') throw new BadRequestException(`확정 대상 아님(현재 ${interp.status})`);
    return this.prisma.interpretation.update({ where: { interpId }, data: { status: 'FINAL' } });
  }

  /**
   * 변이 재분류 — 기존 FINAL 해석을 SUPERSEDED 처리하고 신규 FINAL 생성.
   * VUS→Pathogenic 등 시간 경과에 따른 재해석·재연락 근거.
   */
  async reclassify(variantId: string, dto: { classification: string; evidence?: string; classifier: string; reason: string }) {
    const variant = await this.prisma.variant.findUnique({ where: { variantId } });
    if (!variant) throw new NotFoundException(`변이 없음: ${variantId}`);
    if (!isValidClassification(dto.classification)) throw new BadRequestException(`분류 오류: ${dto.classification}`);

    const prev = await this.prisma.interpretation.findFirst({ where: { variantId, status: 'FINAL' }, orderBy: { classifiedDate: 'desc' } });
    await this.prisma.interpretation.updateMany({
      where: { variantId, status: 'FINAL' },
      data: { status: 'SUPERSEDED' },
    });
    const created = await this.prisma.interpretation.create({
      data: {
        interpId: genId('INT'),
        variantId,
        classification: dto.classification,
        evidence: dto.evidence ?? null,
        classifier: dto.classifier,
        classifiedDate: new Date().toISOString().slice(0, 10),
        status: 'FINAL',
        reason: dto.reason,
      },
    });
    // G1 재접촉(recontact) 통보 — P/LP 소속이 바뀌는 임상적 유의 재분류 시 의뢰의 통보(환자 재접촉).
    let recontact: { notifyId: string } | null = null;
    if (needsRecontact(prev?.classification, dto.classification)) {
      const order = await this.prisma.genomicOrder.findUnique({ where: { genomicOrderId: variant.genomicOrderId }, include: { order: { include: { patient: true } } } });
      const pt = order?.order?.patient;
      const label = `${variant.gene ?? ''} ${variant.hgvsC ?? variant.hgvsP ?? ''}`.trim() || variant.variantId;
      const cn = await this.prisma.criticalNotify.create({
        data: {
          notifyId: genId('CN'), resultId: null, category: 'GENOMIC', sourceRef: variantId, specimenNo: variant.genomicOrderId,
          patientId: pt?.patientId ?? null, patientName: pt?.name ?? null,
          label: `유전체 변이 재분류(재접촉): ${label}`, value: `${prev?.classification ?? '미상'} → ${dto.classification}`,
          notifyTarget: '의뢰의', notifyMethod: '유선', dispatchStatus: 'PENDING',
        },
      });
      this.events.emit('critical.created', { notifyId: cn.notifyId });
      recontact = { notifyId: cn.notifyId };
    }
    return { ...created, recontact };
  }

  /**
   * 근거 종합 번들 — 한 변이의 모든 로컬 근거(유전자 지식·인용 근거·이전 해석)를 한 곳에.
   * 판독 검토용이자 향후 온프레미스 LLM(RAG)의 컨텍스트. 외부 전송 없음.
   */
  async evidenceContext(variantId: string) {
    const v = await this.prisma.variant.findUnique({
      where: { variantId },
      include: { interpretations: { orderBy: { classifiedDate: 'desc' } } },
    });
    if (!v) throw new NotFoundException(`변이 없음: ${variantId}`);
    const order = await this.prisma.genomicOrder.findUnique({ where: { genomicOrderId: v.genomicOrderId }, select: { testType: true } });
    const ev = this.catalog.variantEvidence();
    const hit = ev ? ev.lookup(v.gene, [v.hgvsP, v.hgvsC]) : null;
    const cited = hit?.significance
      ? { significance: hit.significance, stars: hit.stars, gnomadAf: hit.gnomad_af, condition: hit.condition || undefined, source: hit.source || undefined, citation: hit.citation || undefined, oncokbLevel: hit.oncokb_level || undefined, catalogVersion: ev?.version }
      : null;
    const prior = v.interpretations.map((i) => ({ classification: i.classification, evidence: i.evidence, classifier: i.classifier, classifiedDate: i.classifiedDate, status: i.status }));
    return buildEvidenceContext(
      { gene: v.gene, hgvsC: v.hgvsC, hgvsP: v.hgvsP, vaf: v.vaf, zygosity: v.zygosity, chrom: v.chrom, pos: v.pos, testType: order?.testType ?? null },
      geneKnowledge(v.gene),
      cited,
      null, // ACMG 카운트는 구조화 저장 안 함(해석 근거는 자유텍스트) — 번들엔 미포함
      prior,
    );
  }

  /**
   * ★근거 drift 재해석 검토 — 확정(FINAL)된 해석이 **현재 활성 근거 DB와 어긋나는** 변이를 찾는다.
   *
   * 왜 필요한가: ClinVar 등이 개정되면(예: VUS→Pathogenic) 이미 보고된 환자의 해석이 낡는다.
   * 사람이 매번 대조하지 않으면 재접촉이 필요한 환자를 놓친다. 근거 DB를 반입·활성화한 지금,
   * 확정 해석과 현재 근거를 자동 대조해 **P/LP 소속이 바뀌는(재접촉 필요) 건을 최우선**으로 올린다.
   * 탐지만 하고 재분류는 사람이 판단한다(자동 변경 아님).
   */
  async reinterpretReview() {
    const ev = this.catalog.variantEvidence();
    if (!ev) return { evidenceActive: false, catalogVersion: null, drifted: [] as unknown[] };

    // 확정 해석이 있는 변이만 대상.
    // ★필요한 필드만 + 커서 배치(2026-07-30 성능 검토): 해석은 누적만 되므로 전 행을
    //   4단 조인으로 통째 적재하면 해마다 무거워진다. 판정에 쓰는 8개 필드만 읽는다.
    const CHUNK = 10_000;
    const latestByVariant = new Map<string, {
      variantId: string; classification: string | null;
      variant: { variantId: string; genomicOrderId: string; gene: string | null; hgvsP: string | null; hgvsC: string | null;
        genomicOrder: { order: { patient: { patientId: string; name: string | null } | null } | null } | null };
    }>();
    let cursor: string | undefined;
    for (;;) {
      const finals = await this.prisma.interpretation.findMany({
        where: { status: 'FINAL' },
        select: {
          interpId: true, variantId: true, classification: true,
          variant: {
            select: {
              variantId: true, genomicOrderId: true, gene: true, hgvsP: true, hgvsC: true,
              genomicOrder: { select: { order: { select: { patient: { select: { patientId: true, name: true } } } } } },
            },
          },
        },
        // 변이별 최신 1건 선별을 위해 확정일 내림차순 — 동일 확정일은 interpId로 안정 정렬(커서 기준).
        orderBy: [{ classifiedDate: 'desc' }, { interpId: 'desc' }],
        take: CHUNK,
        ...(cursor ? { cursor: { interpId: cursor }, skip: 1 } : {}),
      });
      if (finals.length === 0) break;
      for (const f of finals) if (!latestByVariant.has(f.variantId)) latestByVariant.set(f.variantId, f);
      cursor = finals[finals.length - 1].interpId;
      if (finals.length < CHUNK) break;
    }

    const drifted: {
      variantId: string; genomicOrderId: string; gene: string | null; hgvs: string | null;
      patientId: string | null; patientName: string | null;
      finalizedClass: string | null; evidenceClass: string; source: string | null; stars: number | string | null;
      citation: string | null; needsRecontact: boolean;
    }[] = [];
    for (const f of latestByVariant.values()) {
      const v = f.variant;
      const hit = ev.lookup(v.gene, [v.hgvsP, v.hgvsC]);
      if (!hit?.significance) continue; // 근거 DB에 없으면 판단 보류
      if (hit.significance === f.classification) continue; // 일치 — drift 아님
      const pt = v.genomicOrder?.order?.patient;
      drifted.push({
        variantId: v.variantId, genomicOrderId: v.genomicOrderId,
        gene: v.gene, hgvs: v.hgvsP ?? v.hgvsC ?? null,
        patientId: pt?.patientId ?? null, patientName: pt?.name ?? null,
        finalizedClass: f.classification, evidenceClass: hit.significance,
        source: hit.source || null, stars: hit.stars ?? null, citation: hit.citation || null,
        // P/LP 소속이 바뀌면 재접촉 필요 — 최우선
        needsRecontact: needsRecontact(f.classification, hit.significance),
      });
    }
    // 재접촉 필요 건을 위로
    drifted.sort((a, b) => Number(b.needsRecontact) - Number(a.needsRecontact));
    return { evidenceActive: true, catalogVersion: ev.version, drifted };
  }

  /** G2 NGS 런 QC 게이트 — Q30·coverage·uniformity 임계 판정(PASS/WARN/FAIL). */
  async evaluateRunQc(runId: string) {
    const run = await this.prisma.ngsRun.findUnique({ where: { runId } });
    if (!run) throw new NotFoundException(`NGS 런 없음: ${runId}`);
    // ★패널 임계로 판정한다 — 미적용 시 타깃 패널(coverage 수백x 요구)이 기본 100x로 PASS 오표시돼
    //   NGS 목록 배지(패널 임계 적용)와 상세 카드가 어긋나고, QC 미달 런을 통과로 오인해 소견이 배포된다.
    const panel = run.panelCode ? await this.prisma.ngsPanel.findUnique({ where: { panelCode: run.panelCode } }) : null;
    const th = panel ? { q30: panel.q30Min, meanCoverage: panel.meanCoverageMin, uniformityPct: panel.uniformityMin } : null;
    const qc = evaluateNgsQc({ q30: run.q30, meanCoverage: run.meanCoverage, uniformityPct: run.uniformityPct }, th);
    return { runId, runName: run.runName, status: run.status, metrics: { q30: run.q30, meanCoverage: run.meanCoverage, uniformityPct: run.uniformityPct }, ...qc };
  }

  /** G3 유전체 보고서 서명 — 판독 확정. 변이 해석(FINAL) 존재 확인 후 reportStatus 최종/개정. */
  async signGenomicReport(genomicOrderId: string, dto: { signer: string }) {
    const order = await this.prisma.genomicOrder.findUnique({ where: { genomicOrderId }, include: { variants: { include: { interpretations: true } } } });
    if (!order) throw new NotFoundException(`유전체 오더 없음: ${genomicOrderId}`);
    if (!dto.signer?.trim()) throw new BadRequestException('서명자(signer) 필요');
    const hasFinal = order.variants.some((v) => v.interpretations.some((i) => i.status === 'FINAL'));
    if (!hasFinal) throw new BadRequestException('확정(FINAL) 해석이 없어 서명할 수 없습니다');
    const wasSigned = order.reportStatus === '최종' || order.reportStatus === '개정';
    return this.prisma.genomicOrder.update({
      where: { genomicOrderId },
      data: { reportStatus: wasSigned ? '개정' : '최종', reportSignedBy: dto.signer.trim(), reportSignedDt: new Date() },
    });
  }

  /** G3 유전체 보고서 배포 기록 — ReportDelivery 재사용(specimenNo=genomicOrderId). 서명(최종/개정)만. */
  async deliverGenomicReport(genomicOrderId: string, dto: { channel: string; recipient?: string; deliveredBy?: string; note?: string }) {
    const order = await this.prisma.genomicOrder.findUnique({ where: { genomicOrderId } });
    if (!order) throw new NotFoundException(`유전체 오더 없음: ${genomicOrderId}`);
    if (order.reportStatus !== '최종' && order.reportStatus !== '개정') throw new BadRequestException(`서명 완료(최종/개정) 보고서만 배포 가능: 현재 ${order.reportStatus ?? '미서명'}`);
    const CH = ['PRINT', 'PORTAL', 'PROVIDER', 'FAX'];
    if (!CH.includes(dto.channel)) throw new BadRequestException(`channel은 ${CH.join('/')}: ${dto.channel}`);
    return this.prisma.reportDelivery.create({
      data: { specimenNo: genomicOrderId, channel: dto.channel, recipient: dto.recipient ?? null, deliveredBy: dto.deliveredBy ?? null, note: dto.note ?? null },
    });
  }

  async listGenomicDeliveries(genomicOrderId: string) {
    return this.prisma.reportDelivery.findMany({ where: { specimenNo: genomicOrderId }, orderBy: { deliveredDt: 'desc' } });
  }
}
