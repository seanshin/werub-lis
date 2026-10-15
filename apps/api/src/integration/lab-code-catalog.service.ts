/**
 * LabCodeCatalogService — integration 도메인 서비스.
 *
 * 주요 진입점: `importCatalog()`, `search()`, `lookup()`, `coverage()`
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../infrastructure/prisma/prisma.service';
import { getLabCodePage, type HisLabCodeItem } from './his-integration-client';

/**
 * HIS 검사코드 카탈로그 반입(H1).
 *
 * 용도는 **참조·대사·매핑 보조**다. 오더 코드 해소에는 쓰지 않는다 —
 * 해소는 `CodeMapping`(LIS가 수행하는 검사만) 정본을 유지한다. 이유는 `HisLabCode` 모델 주석 참조.
 *
 * 규격: HIS `docs/05-reference/relay-his-lis-h1h5-response.md` H1.
 *  - `GET /api/v1/integration/lis/lab-codes?page=&limit=&since=`
 *  - 응답 `{ data: { total, count, page, limit, items[] } }`, limit 상한 20000
 */
@Injectable()
export class LabCodeCatalogService {
  private readonly logger = new Logger('LabCodeCatalog');
  private readonly WATERMARK_KEY = 'labcode_watermark';
  /** 페이지 크기 — HIS 상한 20000. 응답 크기·메모리와 왕복 수의 절충. */
  private readonly PAGE_SIZE = 5000;
  /** 안전 상한: 예상 규모(약 53,900) 대비 넉넉하되 무한 순회는 막는다. */
  private readonly MAX_PAGES = 200;

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 카탈로그 반입. `incremental=true`면 마지막 성공 시점 이후만(`?since=`).
   *
   * ★페이징 정확성을 스스로 검증한다. HIS 구현이 `distinct` + `skip/take`를 함께 쓰는데,
   *   ORM이 distinct를 DB(DISTINCT ON)가 아니라 메모리에서 적용하면 **페이지마다 limit보다
   *   적게 오고 일부 코드가 순회에서 통째로 누락**될 수 있다. 조용히 넘어가면 "카탈로그를
   *   전량 받았다"고 착각한 채 커버리지를 계산하게 되므로, 수집 distinct 수와 total을 대조해
   *   불일치를 결과에 실어 보고한다(HIS 확인요청 ②에 대한 회신 근거).
   */
  async importCatalog(opts?: { incremental?: boolean }): Promise<{
    ok: boolean;
    reason?: string;
    since: string | null;
    pages: number;
    total: number | null;
    received: number;
    distinctCodes: number;
    upserted: number;
    pageCountMismatch: boolean;
    watermark: string | null;
  }> {
    const since = opts?.incremental ? await this.getWatermark() : null;
    const seen = new Map<string, HisLabCodeItem>();
    let received = 0;
    let total: number | null = null;
    let page = 1;
    let upserted = 0;

    for (; page <= this.MAX_PAGES; page++) {
      const r = await getLabCodePage(page, this.PAGE_SIZE, since);
      if (!r.available) {
        // 1페이지부터 실패면 반입 자체가 불가(시크릿 미주입 등). 중간 실패면 받은 데이터는 살린다.
        if (page === 1) return { ok: false, reason: r.reason, since, pages: 0, total: null, received: 0, distinctCodes: 0, upserted: 0, pageCountMismatch: false, watermark: null };
        this.logger.error(`카탈로그 반입 중단(page ${page}): ${r.reason}`);
        break;
      }
      const body = r.data;
      total = typeof body.total === 'number' ? body.total : total;
      const items = body.items ?? [];
      received += items.length;
      for (const it of items) if (it?.code) seen.set(it.code, it);

      // 저장은 페이지 단위로 — 전량을 메모리에 쥔 채 마지막에 쓰면 중간 실패 시 전부 잃는다.
      upserted += await this.upsertItems(items);

      if (items.length === 0) break;
      if (total != null && received >= total) break;
    }

    const distinctCodes = seen.size;
    // 순회로 받은 distinct 코드 수가 HIS가 알려준 total과 다르면 누락·중복이 있다는 뜻.
    const pageCountMismatch = total != null && distinctCodes !== total;
    if (pageCountMismatch) {
      this.logger.error(
        `카탈로그 페이징 불일치 — HIS total=${total} · 수집 distinct=${distinctCodes} · 수신 행=${received}. ` +
        `HIS 측 distinct+페이징 조합 확인 필요(누락 가능).`,
      );
    }

    // 워터마크는 **반입에 성공한 항목의 최대 lastUpdated**. 실패로 중단됐으면 전진시키지 않는다
    // (다음 증분에서 못 받은 구간을 다시 받도록).
    let watermark: string | null = null;
    if (!pageCountMismatch && page <= this.MAX_PAGES) {
      let max = '';
      for (const it of seen.values()) {
        const lu = it.meta?.lastUpdated;
        if (lu && lu > max) max = lu;
      }
      if (max) { watermark = max; await this.setWatermark(max); }
    }

    this.logger.log(
      `카탈로그 반입: 페이지 ${page - 1} · 수신 ${received} · distinct ${distinctCodes} · 저장 ${upserted}` +
      `${total != null ? ` · HIS total ${total}` : ''}${pageCountMismatch ? ' · ★불일치' : ''}`,
    );
    return { ok: true, since, pages: page - 1, total, received, distinctCodes, upserted, pageCountMismatch, watermark };
  }

  /**
   * 대량 upsert — 5만 건을 Prisma upsert 루프로 돌리면 왕복이 5만 번이라 현실적이지 않다.
   * 다중행 INSERT ... ON CONFLICT DO UPDATE로 청크 처리한다.
   */
  private async upsertItems(items: HisLabCodeItem[]): Promise<number> {
    const CHUNK = 500;
    let n = 0;
    for (let i = 0; i < items.length; i += CHUNK) {
      const slice = items.slice(i, i + CHUNK).filter((it) => it?.code);
      if (slice.length === 0) continue;
      const rows = slice.map((it) => {
        const lu = it.meta?.lastUpdated ? new Date(it.meta.lastUpdated) : null;
        return Prisma.sql`(${it.code}, ${it.nameKo ?? null}, ${it.loincCode ?? null}, ${it.category ?? null},
          ${it.panel && it.panel.length ? JSON.stringify(it.panel) : null},
          ${lu && !isNaN(lu.getTime()) ? lu : null}, NOW())`;
      });
      n += await this.prisma.$executeRaw`
        INSERT INTO "his_lab_code" ("code","name_ko","loinc_code","category","panel_json","his_updated","synced_dt")
        VALUES ${Prisma.join(rows)}
        ON CONFLICT ("code") DO UPDATE SET
          "name_ko" = EXCLUDED."name_ko",
          "loinc_code" = EXCLUDED."loinc_code",
          "category" = EXCLUDED."category",
          "panel_json" = EXCLUDED."panel_json",
          "his_updated" = EXCLUDED."his_updated",
          "synced_dt" = NOW()`;
    }
    return n;
  }

  /** 카탈로그 검색 — 매핑 등록 화면의 코드 조회용(코드 접두 또는 명칭 부분일치). */
  async search(q: string, take = 30) {
    const term = (q ?? '').trim();
    if (!term) return [];
    return this.prisma.hisLabCode.findMany({
      where: { OR: [{ code: { startsWith: term.toUpperCase() } }, { nameKo: { contains: term } }] },
      orderBy: { code: 'asc' },
      take: Math.min(Math.max(take, 1), 100),
      select: { code: true, nameKo: true, loincCode: true, category: true },
    });
  }

  /** 코드 1건 조회 — 대기열의 미매핑 코드에 이름을 붙이는 용도. */
  async lookup(codes: string[]): Promise<Map<string, { nameKo: string | null; loincCode: string | null }>> {
    const uniq = [...new Set(codes.filter(Boolean))];
    if (uniq.length === 0) return new Map();
    const rows = await this.prisma.hisLabCode.findMany({
      where: { code: { in: uniq } },
      select: { code: true, nameKo: true, loincCode: true },
    });
    return new Map(rows.map((r) => [r.code, { nameKo: r.nameKo, loincCode: r.loincCode }]));
  }

  /**
   * 커버리지 — 카탈로그 대비 LIS 매핑 보유 비율.
   *
   * ⚠ 분모가 HIRA 전체 카탈로그(약 53,900)라 비율 자체는 의미가 작다. LIS가 수행하지 않는
   *   검사가 대부분이기 때문이다. **의미 있는 분모는 "병원이 실제로 발행하는 오더 코드 집합"**이며
   *   그것은 HIS에 별도 요청 중이다(H1 §4-2). 여기서는 실제로 들어온 오더 코드 기준 커버리지를
   *   함께 낸다 — 그쪽이 개시 리스크를 직접 반영한다.
   */
  async coverage() {
    const [catalogTotal, mappings, dropped] = await Promise.all([
      this.prisma.hisLabCode.count(),
      this.prisma.codeMapping.findMany({ select: { hisCode: true, ediCode: true } }),
      this.prisma.interfaceLog.count({ where: { ifId: 'IF-HISORD', direction: 'INBOUND', status: 'DROPPED' } }),
    ]);
    const mapped = new Set<string>();
    for (const m of mappings) { if (m.hisCode) mapped.add(m.hisCode); if (m.ediCode) mapped.add(m.ediCode); }
    const inCatalog = catalogTotal > 0
      ? await this.prisma.hisLabCode.count({ where: { code: { in: [...mapped] } } })
      : 0;
    return {
      catalogTotal,
      lisMappedCodes: mapped.size,
      lisMappedFoundInCatalog: inCatalog, // 매핑이 카탈로그에 실재하는지(오타·폐지 코드 탐지)
      droppedOrders: dropped, // ★개시 리스크 직결 — 실제 들어왔는데 매핑 없는 건
      lastSyncedDt: await this.prisma.hisLabCode.findFirst({ orderBy: { syncedDt: 'desc' }, select: { syncedDt: true } }).then((r) => r?.syncedDt ?? null),
    };
  }

  private async getWatermark(): Promise<string | null> {
    const row = await this.prisma.integrationState.findUnique({ where: { key: this.WATERMARK_KEY } });
    return row?.value ?? null;
  }
  private async setWatermark(v: string): Promise<void> {
    await this.prisma.integrationState.upsert({ where: { key: this.WATERMARK_KEY }, update: { value: v }, create: { key: this.WATERMARK_KEY, value: v } });
  }
}
