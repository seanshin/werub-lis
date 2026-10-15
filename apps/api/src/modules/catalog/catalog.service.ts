/**
 * CatalogService — catalog 도메인 서비스.
 *
 * 주요 진입점: `onModuleInit()`, `reloadAll()`, `active()`, `activeAst()`, `notifiableRules()`, `cytoCategories()`, `synopticProtocols()`, `icdoCodes()`…
 * 일부 경로는 트랜잭션으로 묶인다 — 부분 반영 시 임상 상태가 깨지는 구간.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, BadRequestException, NotFoundException, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditChainService } from '../audit/audit-chain.service';
import { genId } from '../../common/id.util';
import { CATALOG_BY_ID, CATALOG_DEFS, diffCatalog, parseCatalogCsv } from '../../domain/catalog';
import { STARTER_BREAKPOINTS, type BreakpointTable } from '../../domain/ast-breakpoints';
import { CYTO_CATEGORIES as STARTER_CYTO_CATEGORIES } from '../../domain/cytology';
import { SYNOPTIC_PROTOCOLS as STARTER_SYNOPTIC } from '../../domain/synoptic-protocols';
import { STARTER_NOTIFIABLE } from '../../domain/notifiable-disease';

/**
 * 표준 코드셋 반입 — 발행기관 개정판(CLSI M100 등)을 통째로 갈아 끼운다.
 *
 * 흐름: **반입(DRAFT) → 차이 확인 → 활성화**. 활성화 전에 차이를 보여주는 것이 핵심이다.
 * 브레이크포인트 한 줄이 바뀌면 그 약제의 S/I/R이 뒤집히고 곧 항생제 선택이 달라지는데,
 * 무엇이 바뀌는지 모른 채 바꾸면 어제 S였던 균이 오늘 R이 된 이유를 아무도 설명할 수 없다.
 *
 * 판정 시점마다 DB를 읽지 않도록 활성 버전을 메모리에 캐시한다(설정과 동일한 전제: 단일 인스턴스).
 */
export interface VariantEvidenceRow {
  gene: string; variant: string; significance?: string; stars?: number | string;
  gnomad_af?: number | string; condition?: string; source?: string; citation?: string; oncokb_level?: string;
}

interface ActiveCatalog {
  version: string;
  standard: string;
  items: { key: string; payload: Record<string, unknown> }[];
}

@Injectable()
export class CatalogService implements OnModuleInit {
  private readonly logger = new Logger(CatalogService.name);
  /** 모든 활성 카탈로그를 메모리에 — 판정 시점마다 DB를 읽지 않는다(단일 인스턴스 전제). */
  private cache = new Map<string, ActiveCatalog>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditChainService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.reloadAll().catch((e) => {
      // 카탈로그를 못 읽어도 코드 스타터셋으로 계속 판정해야 한다(기동 실패로 만들지 않는다)
      this.logger.warn(`카탈로그 로드 실패 — 코드 스타터셋으로 판정합니다: ${e instanceof Error ? e.message : e}`);
    });
  }

  /** 활성 카탈로그 전량을 메모리로. */
  async reloadAll(): Promise<void> {
    const actives = await this.prisma.catalogVersion.findMany({ where: { status: 'ACTIVE' }, include: { items: true } });
    this.cache = new Map(
      actives.map((v) => [
        v.catalogId,
        {
          version: v.version,
          standard: v.standard || v.version,
          items: v.items.map((i) => ({ key: i.itemKey, payload: JSON.parse(i.payload) as Record<string, unknown> })),
        },
      ]),
    );
  }

  /** 활성 카탈로그(원시 행). 없으면 null → 도메인 스타터셋으로 판정. */
  active(catalogId: string): ActiveCatalog | null {
    return this.cache.get(catalogId) ?? null;
  }

  /** 판정엔진(MIC)이 쓰는 활성 브레이크포인트 표. */
  activeAst(): { table: BreakpointTable; standard: string } | null {
    const c = this.cache.get('AST_BREAKPOINT');
    if (!c) return null;
    const table: BreakpointTable = {};
    for (const it of c.items) {
      const p = it.payload as { group: string; antibiotic: string; s: number; r: number };
      (table[p.group] ??= {})[p.antibiotic] = { s: p.s, r: p.r };
    }
    return { table, standard: c.standard };
  }

  /** 활성 법정감염병 규칙(없으면 null → 코드 스타터 규칙). */
  notifiableRules(): { type: string; match: string; disease: string; grade: string }[] | null {
    const c = this.cache.get('NOTIFIABLE_DISEASE');
    return c ? c.items.map((i) => i.payload as { type: string; match: string; disease: string; grade: string }) : null;
  }

  /** 활성 세포병리 분류 코드 집합(없으면 null → 스타터 목록). */
  cytoCategories(): Set<string> | null {
    const c = this.cache.get('CYTOLOGY_CATEGORY');
    return c ? new Set(c.items.map((i) => String((i.payload as { code: string }).code))) : null;
  }

  /** 활성 CAP synoptic 프로토콜(없으면 null → 스타터). */
  synopticProtocols(): { key: string; label: string; required: string[] }[] | null {
    const c = this.cache.get('SYNOPTIC_PROTOCOL');
    return c ? c.items.map((i) => i.payload as { key: string; label: string; required: string[] }) : null;
  }

  /** 활성 ICD-O 코드 집합(없으면 null → 형식 검증만). key는 'KIND|code'. */
  icdoCodes(): { has: (kind: string, code: string) => boolean } | null {
    const c = this.cache.get('ICDO');
    if (!c) return null;
    const set = new Set(c.items.map((i) => i.key));
    return { has: (kind, code) => set.has(`${kind}|${code}`) };
  }

  /**
   * 변이 임상근거 조회기 — 활성 VARIANT_EVIDENCE에서 gene+variant(HGVS)로 근거를 찾는다.
   * AI 해석이 ClinVar 유의성·별점·gnomAD 빈도·출처를 **인용**하는 데 쓴다. 없으면 null(근거 없음).
   */
  variantEvidence(): {
    version: string;
    lookup: (gene: string | null | undefined, variants: (string | null | undefined)[]) => VariantEvidenceRow | null;
  } | null {
    const c = this.cache.get('VARIANT_EVIDENCE');
    if (!c) return null;
    const byKey = new Map(c.items.map((i) => [i.key, i.payload as unknown as VariantEvidenceRow]));
    return {
      version: c.version,
      lookup: (gene, variants) => {
        const g = (gene ?? '').trim().toUpperCase();
        if (!g) return null;
        for (const v of variants) {
          const key = `${g}|${(v ?? '').trim()}`;
          const hit = byKey.get(key);
          if (hit) return hit;
        }
        return null;
      },
    };
  }

  async list() {
    const versions = await this.prisma.catalogVersion.findMany({ orderBy: [{ catalogId: 'asc' }, { importedDt: 'desc' }] });
    return CATALOG_DEFS.map((d) => ({
      catalogId: d.catalogId,
      label: d.label,
      help: d.help,
      columns: d.columns,
      sample: d.sample,
      versions: versions.filter((v) => v.catalogId === d.catalogId).map((v) => ({
        version: v.version, standard: v.standard, effectiveDate: v.effectiveDate, status: v.status,
        itemCount: v.itemCount, note: v.note, importedBy: v.importedBy, importedDt: v.importedDt,
        activatedBy: v.activatedBy, activatedDt: v.activatedDt,
      })),
      // 활성 버전이 없으면 코드 스타터셋으로 동작한다는 사실을 화면이 알려야 한다
      activeVersion: versions.find((v) => v.catalogId === d.catalogId && v.status === 'ACTIVE')?.version ?? null,
    }));
  }

  /** 반입 — 항상 DRAFT로 들어온다. 활성 버전은 이 단계에서 건드리지 않는다. */
  async import(
    catalogId: string,
    dto: { version: string; standard?: string; effectiveDate?: string; csv: string; note?: string },
    userId: string | null,
  ) {
    const def = CATALOG_BY_ID.get(catalogId);
    if (!def) throw new NotFoundException(`카탈로그 없음: ${catalogId}`);
    const version = dto.version?.trim();
    if (!version) throw new BadRequestException('버전이 필요합니다(예: CLSI-M100-2025)');

    const parsed = parseCatalogCsv(def, dto.csv ?? '');
    if (parsed.errors.length) {
      // 몇 줄이 틀렸는지 그대로 알려준다 — "반입 실패"만으로는 고칠 수가 없다
      throw new BadRequestException(
        `반입 오류 ${parsed.errors.length}건 — ${parsed.errors.slice(0, 5).map((e) => `${e.line}행: ${e.message}`).join(' / ')}${parsed.errors.length > 5 ? ' …' : ''}`,
      );
    }
    if (parsed.rows.length === 0) throw new BadRequestException('반입할 행이 없습니다');

    const exists = await this.prisma.catalogVersion.findUnique({ where: { catalogId_version: { catalogId, version } } });
    if (exists && exists.status !== 'DRAFT') {
      throw new BadRequestException(`이미 활성화(또는 폐기)된 버전입니다: ${version} — 새 버전 번호를 쓰세요`);
    }
    // 초안 교체+버전 upsert+항목 생성은 한 트랜잭션으로 — 중간에 죽으면(배포·DB blip)
    //   itemCount>0인데 실제 항목 0인 유령 DRAFT가 남고, 그걸 활성화하면 판정 근거가 빈 채로 라이브가 된다.
    await this.prisma.$transaction([
      ...(exists ? [this.prisma.catalogItem.deleteMany({ where: { catalogId, version } })] : []),
      this.prisma.catalogVersion.upsert({
        where: { catalogId_version: { catalogId, version } },
        create: {
          catalogId, version, standard: dto.standard?.trim() || version, effectiveDate: dto.effectiveDate?.trim() || null,
          status: 'DRAFT', itemCount: parsed.rows.length, note: dto.note?.trim() || null, importedBy: userId,
        },
        update: {
          standard: dto.standard?.trim() || version, effectiveDate: dto.effectiveDate?.trim() || null,
          itemCount: parsed.rows.length, note: dto.note?.trim() || null, importedBy: userId, importedDt: new Date(),
        },
      }),
      this.prisma.catalogItem.createMany({
        data: parsed.rows.map((r) => ({ itemId: genId('CI'), catalogId, version, itemKey: r.key, payload: JSON.stringify(r.payload) })),
      }),
    ]);

    await this.audit.append({
      userId, action: 'CATALOG_IMPORT', target: `${catalogId}:${version}`,
      detail: `초안 반입 ${parsed.rows.length}건`, status: 201, sensitive: false,
    });
    const diff = await this.diff(catalogId, version);
    return { catalogId, version, status: 'DRAFT', itemCount: parsed.rows.length, diff };
  }

  /** 활성 버전 대비 차이. 활성 버전이 없으면 코드 스타터셋과 비교한다. */
  async diff(catalogId: string, version: string) {
    const def = CATALOG_BY_ID.get(catalogId);
    if (!def) throw new NotFoundException(`카탈로그 없음: ${catalogId}`);
    const [target, active] = await Promise.all([
      this.prisma.catalogVersion.findUnique({ where: { catalogId_version: { catalogId, version } }, include: { items: true } }),
      this.prisma.catalogVersion.findFirst({ where: { catalogId, status: 'ACTIVE' }, include: { items: true } }),
    ]);
    if (!target) throw new NotFoundException(`버전 없음: ${catalogId}/${version}`);

    const toRows = (items: { itemKey: string; payload: string }[]) =>
      items.map((i) => ({ key: i.itemKey, payload: JSON.parse(i.payload) as Record<string, unknown> }));

    const before = active ? toRows(active.items) : starterRows(catalogId);
    const d = diffCatalog(before, toRows(target.items));
    return { ...d, comparedTo: active ? active.version : '(코드 스타터셋)', baselineIsStarter: !active };
  }

  /**
   * 활성화 — 이전 활성 버전은 RETIRED로 남긴다(삭제하지 않는다).
   * 지난 보고서가 **어느 기준으로 판정됐는지** 나중에 소명할 수 있어야 한다.
   */
  async activate(catalogId: string, version: string, userId: string | null) {
    const target = await this.prisma.catalogVersion.findUnique({ where: { catalogId_version: { catalogId, version } } });
    if (!target) throw new NotFoundException(`버전 없음: ${catalogId}/${version}`);
    if (target.status === 'ACTIVE') throw new BadRequestException('이미 활성 버전입니다');
    // 저장된 카운터가 아니라 실제 항목 수로 판정 — 유령 DRAFT(카운터>0·항목0)를 활성화해 빈 판정근거가 라이브되는 것 차단
    const realItemCount = await this.prisma.catalogItem.count({ where: { catalogId, version } });
    if (realItemCount === 0) throw new BadRequestException('항목이 없는 버전은 활성화할 수 없습니다(반입이 불완전했을 수 있음 — 재반입하세요)');

    const diff = await this.diff(catalogId, version);
    await this.prisma.$transaction([
      this.prisma.catalogVersion.updateMany({ where: { catalogId, status: 'ACTIVE' }, data: { status: 'RETIRED' } }),
      this.prisma.catalogVersion.update({
        where: { catalogId_version: { catalogId, version } },
        data: { status: 'ACTIVE', activatedBy: userId, activatedDt: new Date() },
      }),
    ]);
    await this.reloadAll();

    await this.audit.append({
      userId, action: 'CATALOG_ACTIVATE', target: `${catalogId}:${version}`,
      detail: `활성화(추가 ${diff.added.length} · 변경 ${diff.changed.length} · 삭제 ${diff.removed.length})`,
      status: 200, sensitive: false,
    });
    this.logger.warn(`카탈로그 활성화 ${catalogId} ${version} — 추가 ${diff.added.length}·변경 ${diff.changed.length}·삭제 ${diff.removed.length}`);
    return { catalogId, version, status: 'ACTIVE', diff };
  }

  async items(catalogId: string, version: string) {
    const v = await this.prisma.catalogVersion.findUnique({
      where: { catalogId_version: { catalogId, version } },
      include: { items: { orderBy: { itemKey: 'asc' } } },
    });
    if (!v) throw new NotFoundException(`버전 없음: ${catalogId}/${version}`);
    return v.items.map((i) => ({ key: i.itemKey, ...(JSON.parse(i.payload) as Record<string, unknown>) }));
  }

  /** 잘못 반입한 초안(DRAFT) 삭제 — 활성/이전 버전은 이력이라 삭제 불가. 항목은 FK Cascade로 함께 제거. */
  async deleteDraft(catalogId: string, version: string) {
    const v = await this.prisma.catalogVersion.findUnique({ where: { catalogId_version: { catalogId, version } } });
    if (!v) throw new NotFoundException(`버전 없음: ${catalogId}/${version}`);
    if (v.status !== 'DRAFT') throw new BadRequestException('DRAFT(초안) 버전만 삭제할 수 있습니다 — 활성/이전 버전은 이력으로 보존');
    await this.prisma.catalogVersion.delete({ where: { catalogId_version: { catalogId, version } } });
    return { catalogId, version, deleted: true };
  }
}

/** 코드 스타터셋을 비교 기준 행으로 — 첫 반입에서도 "무엇이 달라지는지" 보여준다. */
function starterRows(catalogId: string): { key: string; payload: Record<string, unknown> }[] {
  const out: { key: string; payload: Record<string, unknown> }[] = [];
  if (catalogId === 'AST_BREAKPOINT') {
    for (const [group, drugs] of Object.entries(STARTER_BREAKPOINTS)) {
      for (const [antibiotic, bp] of Object.entries(drugs)) {
        out.push({ key: `${group}|${antibiotic}`, payload: { group, antibiotic, s: bp.s, r: bp.r } });
      }
    }
  } else if (catalogId === 'CYTOLOGY_CATEGORY') {
    for (const code of STARTER_CYTO_CATEGORIES) out.push({ key: code, payload: { code, system: 'STARTER', label: code } });
  } else if (catalogId === 'SYNOPTIC_PROTOCOL') {
    for (const p of STARTER_SYNOPTIC) out.push({ key: p.key, payload: { key: p.key, label: p.label, required: p.required } });
  } else if (catalogId === 'NOTIFIABLE_DISEASE') {
    for (const r of STARTER_NOTIFIABLE) out.push({ key: `${r.type}|${r.match}`, payload: { ...r } });
  }
  // ICDO는 코드 스타터셋이 없다(형식 검증만 있었으므로 첫 반입은 전부 추가로 잡힌다)
  return out;
}
