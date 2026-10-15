/**
 * MasterService — master 도메인 서비스.
 *
 * 주요 진입점: `listTests()`, `createTest()`, `seedDerivedTests()`, `updateTest()`, `listReferenceRanges()`, `createReferenceRange()`, `updateReferenceRange()`, `deleteReferenceRange()`…
 * 일부 경로는 트랜잭션으로 묶인다 — 부분 반영 시 임상 상태가 깨지는 구간.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { genId } from '../../common/id.util';
import { CODE_ID_PATTERN, CODE_ID_MESSAGE } from '../../common/validation';
import {
  CreateTestDto,
  UpdateTestDto,
  UpsertReferenceRangeDto,
  UpsertCodeMappingDto,
  UpsertPanelDto,
  UpsertQcMaterialDto,
  UpsertQcTargetDto,
} from './dto/master.dto';
import { USE_STATUSES, isOneOf } from '../../domain/enums';
import { DERIVED_TESTS, DERIVED_FORMULA } from '../../domain/derived-tests';
import { validateReferenceRange } from '../../domain/result-evaluation';
import { formatRange } from '@lis/shared';

/**
 * 마스터 관리 — 검사항목·참고치·코드매핑·패널·QC 목표치의 운영자 CRUD.
 * (기획 22 §6-3 P1) 변경은 전역 AuditInterceptor가 자동 기록.
 */
@Injectable()
export class MasterService {
  constructor(private readonly prisma: PrismaService) {}

  /** testCode 존재 보장 — FK 위반을 400으로 선제 차단. */
  private async assertTest(testCode: string): Promise<void> {
    const t = await this.prisma.testMaster.findUnique({ where: { testCode } });
    if (!t) throw new BadRequestException(`미등록 검사항목: ${testCode}`);
  }

  // ── 검사항목(TestMaster) ──
  listTests(domain?: string) {
    return this.prisma.testMaster.findMany({
      where: domain ? { domain: domain as never } : undefined,
      orderBy: { testCode: 'asc' },
    });
  }

  async createTest(dto: CreateTestDto) {
    const dup = await this.prisma.testMaster.findUnique({ where: { testCode: dto.testCode } });
    if (dup) throw new BadRequestException(`이미 존재하는 검사코드: ${dto.testCode}`);
    return this.prisma.testMaster.create({
      data: {
        testCode: dto.testCode,
        name: dto.name,
        loinc: dto.loinc ?? null,
        domain: dto.domain as never,
        unitUcum: dto.unitUcum ?? null,
        specimenType: dto.specimenType ?? null,
      },
    });
  }

  /**
   * 계산검사 입력·출력 검사 + 참고치 멱등 시딩 — eGFR/LDL/anion gap/보정칼슘 활성화.
   * 입력검사는 참고치가 있어야 자동검증→파생이 동작(참고치 미설정 시 보류).
   */
  async seedDerivedTests() {
    // LOINC은 표준 화학검사라 병원 불문 고정값. AG는 K 포함식이므로 'Anion gap 4'(33037-3)와 정합.
    const tests: { testCode: string; name: string; unit: string; loinc?: string; low?: number; high?: number; panicLow?: number; panicHigh?: number }[] = [
      // 입력검사
      { testCode: 'CHE-CREA', name: '크레아티닌', unit: 'mg/dL', loinc: '2160-0', low: 0.6, high: 1.3, panicHigh: 10 },
      { testCode: 'CHE-CHOL', name: '총콜레스테롤', unit: 'mg/dL', loinc: '2093-3', low: 0, high: 200 },
      { testCode: 'CHE-HDL', name: 'HDL 콜레스테롤', unit: 'mg/dL', loinc: '2085-9', low: 40, high: 100 },
      { testCode: 'CHE-TG', name: '중성지방', unit: 'mg/dL', loinc: '2571-8', low: 0, high: 150 },
      { testCode: 'CHE-CO2', name: '이산화탄소(HCO3)', unit: 'mmol/L', loinc: '1963-8', low: 22, high: 29 },
      { testCode: 'CHE-CA', name: '칼슘', unit: 'mg/dL', loinc: '17861-6', low: 8.6, high: 10.2, panicLow: 6, panicHigh: 13 },
      { testCode: 'CHE-ALB', name: '알부민', unit: 'g/dL', loinc: '1751-7', low: 3.5, high: 5.2 },
      // 출력(파생)검사
      { testCode: 'CHE-EGFR', name: 'eGFR(추정 사구체여과율)', unit: 'mL/min/1.73m²', loinc: '62238-1', low: 60, high: 200 },
      { testCode: 'CHE-LDLC', name: 'LDL 콜레스테롤(계산)', unit: 'mg/dL', loinc: '13457-7', low: 0, high: 130 },
      // K 포함식 AG=(Na+K)-(Cl+HCO3) 정상범위(≈10~20). K 미포함(8~16)과 혼동 금지. (개시 전 검사실 확정 D2)
      { testCode: 'CHE-AGAP', name: 'Anion Gap', unit: 'mmol/L', loinc: '33037-3', low: 10, high: 20 },
      { testCode: 'CHE-CACORR', name: '보정 칼슘', unit: 'mg/dL', low: 8.6, high: 10.2 }, // 보정칼슘 단일 LOINC 불명확 → 검사실 확정
    ];
    let created = 0;
    for (const t of tests) {
      await this.prisma.testMaster.upsert({
        where: { testCode: t.testCode },
        update: { loinc: t.loinc ?? undefined }, // 기존 항목에도 LOINC 채움(멱등 보강)
        create: { testCode: t.testCode, name: t.name, domain: 'DIAGNOSTIC' as never, unitUcum: t.unit, loinc: t.loinc ?? null, specimenType: 'SERUM' },
      });
      const hasRange = await this.prisma.referenceRange.findFirst({ where: { testCode: t.testCode } });
      if (!hasRange && (t.low != null || t.high != null)) {
        await this.prisma.referenceRange.create({
          data: { rrId: genId('RR'), testCode: t.testCode, sex: 'A', ageMin: 0, ageMax: 200, low: t.low ?? null, high: t.high ?? null, panicLow: t.panicLow ?? null, panicHigh: t.panicHigh ?? null },
        });
      }
      created++;
    }
    return { seeded: created };
  }

  async updateTest(testCode: string, dto: UpdateTestDto) {
    await this.assertTest(testCode);
    // 델타 한계는 "얼마나 변하면 사람이 본다"는 양수 임계다. 음수면 비교식이 항상 참이 되어
    // 모든 결과가 델타 보류로 쌓이거나(운영 마비) 반대로 무의미해진다.
    if (dto.deltaPctLimit != null && dto.deltaPctLimit <= 0) throw new BadRequestException(`델타 백분율 한계는 양수여야 합니다(입력: ${dto.deltaPctLimit})`);
    if (dto.deltaAbsLimit != null && dto.deltaAbsLimit <= 0) throw new BadRequestException(`델타 절대값 한계는 양수여야 합니다(입력: ${dto.deltaAbsLimit})`);
    if (dto.deltaWindowDays != null && dto.deltaWindowDays <= 0) throw new BadRequestException(`델타 비교 기간은 1일 이상이어야 합니다(입력: ${dto.deltaWindowDays})`);
    return this.prisma.testMaster.update({ where: { testCode }, data: { ...dto } });
  }

  /**
   * 참고치 정합성 게이트 — 판정 로직이 옳아도 참고치가 틀리면 모든 결과가 틀린다.
   * 위험치가 정상범위 안으로 들어오면 **정상값이 위험치로 통보**되고, 위험치가 역전되면
   * 거의 모든 값이 LL이 되어 통보가 폭주한다(경보 피로 → 진짜 위험치를 무시하게 된다).
   */
  private assertRangeSane(r: { low?: number | null; high?: number | null; panicLow?: number | null; panicHigh?: number | null; ageMin?: number | null; ageMax?: number | null }) {
    const errs = validateReferenceRange(r);
    if (errs.length) throw new BadRequestException(`참고치 정합성 오류 — ${errs.join(' / ')}`);
  }

  // ── 참고치(ReferenceRange) ──
  async listReferenceRanges(testCode: string) {
    return this.prisma.referenceRange.findMany({
      where: { testCode },
      orderBy: [{ sex: 'asc' }, { ageMin: 'asc' }],
    });
  }

  async createReferenceRange(dto: UpsertReferenceRangeDto) {
    await this.assertTest(dto.testCode);
    this.assertRangeSane(dto);
    return this.prisma.referenceRange.create({
      data: {
        rrId: genId('RR'),
        testCode: dto.testCode,
        sex: dto.sex ?? 'A',
        ageMin: dto.ageMin ?? 0,
        ageMax: dto.ageMax ?? 200,
        low: dto.low ?? null,
        high: dto.high ?? null,
        panicLow: dto.panicLow ?? null,
        panicHigh: dto.panicHigh ?? null,
      },
    });
  }

  async updateReferenceRange(rrId: string, dto: Partial<UpsertReferenceRangeDto>) {
    const rr = await this.prisma.referenceRange.findUnique({ where: { rrId } });
    if (!rr) throw new NotFoundException(`참고치 없음: ${rrId}`);
    const { testCode: _ignore, ...patch } = dto;
    // 부분 수정도 기존 값과 합쳐 검증한다 — panicHigh만 낮춰도 정상범위와 역전될 수 있다
    this.assertRangeSane({
      low: patch.low !== undefined ? patch.low : rr.low,
      high: patch.high !== undefined ? patch.high : rr.high,
      panicLow: patch.panicLow !== undefined ? patch.panicLow : rr.panicLow,
      panicHigh: patch.panicHigh !== undefined ? patch.panicHigh : rr.panicHigh,
      ageMin: patch.ageMin !== undefined ? patch.ageMin : rr.ageMin,
      ageMax: patch.ageMax !== undefined ? patch.ageMax : rr.ageMax,
    });
    return this.prisma.referenceRange.update({ where: { rrId }, data: { ...patch } });
  }

  async deleteReferenceRange(rrId: string) {
    const rr = await this.prisma.referenceRange.findUnique({ where: { rrId } });
    if (!rr) throw new NotFoundException(`참고치 없음: ${rrId}`);
    await this.prisma.referenceRange.delete({ where: { rrId } });
    return { deleted: rrId };
  }

  // ── 코드매핑(CodeMapping) ──
  listCodeMappings() {
    return this.prisma.codeMapping.findMany({ orderBy: { lisCode: 'asc' } });
  }

  async upsertCodeMapping(lisCode: string, dto: UpsertCodeMappingDto) {
    await this.assertTest(lisCode); // lisCode는 testCode를 참조
    return this.prisma.codeMapping.upsert({
      where: { lisCode },
      update: { ...dto },
      create: {
        lisCode,
        hisCode: dto.hisCode ?? null,
        loinc: dto.loinc ?? null,
        ediCode: dto.ediCode ?? null,
        status: dto.status ?? 'USE',
      },
    });
  }

  /**
   * HIS 코드매핑 대량 반입 — EDI 코드 CSV 수령 시 일괄 upsert(멱등).
   * lisCode는 TestMaster에 존재해야 함(미등록은 오류 행으로 보고, 무결성 위해 자동생성 안 함).
   * 빈 셀은 '변경 없음'(기존값 보존) — 실수 삭제 방지.
   *
   * `dryRun`이면 **아무것도 쓰지 않고** 검증 결과와 변경 목록(before→after)만 돌려준다.
   * 심평원 실 수가코드 반입은 청구 산정에 직결되므로, 기존 매핑을 조용히 덮는 일이 없도록
   * 적재 전에 차이를 눈으로 확인한다(카탈로그 반입기의 DRAFT→차이확인→활성화와 같은 원칙).
   */
  async bulkImportCodeMappings(
    rows: { lisCode?: string; hisCode?: string; loinc?: string; ediCode?: string; status?: string }[],
    dryRun = false,
  ) {
    if (!Array.isArray(rows) || rows.length === 0) throw new BadRequestException('반입할 행이 없습니다');
    if (rows.length > 5000) throw new BadRequestException('한 번에 최대 5000행');
    const tests = new Set((await this.prisma.testMaster.findMany({ select: { testCode: true } })).map((t) => t.testCode));
    const prior = new Map((await this.prisma.codeMapping.findMany()).map((m) => [m.lisCode, m]));
    const result = {
      dryRun, total: rows.length, imported: 0, updated: 0, unchanged: 0,
      changes: [] as { row: number; lisCode: string; field: string; before: string | null; after: string }[],
      errors: [] as { row: number; lisCode: string; error: string }[],
    };
    const v = (s?: string) => { const t = (s ?? '').trim(); return t === '' ? undefined : t; };
    for (let i = 0; i < rows.length; i++) {
      if (!rows[i] || typeof rows[i] !== 'object') { result.errors.push({ row: i + 1, lisCode: '', error: '행 형식 오류' }); continue; }
      const lisCode = v(rows[i].lisCode);
      if (!lisCode) { result.errors.push({ row: i + 1, lisCode: '', error: 'lisCode 누락' }); continue; }
      if (!tests.has(lisCode)) { result.errors.push({ row: i + 1, lisCode, error: '미등록 검사코드(TestMaster 없음)' }); continue; }
      // 코드성 필드는 HL7 발신 시 구분자 위치에 들어가므로 문자집합을 좁힌다(발신 escHl7과 이중 방어).
      const codeBad = (['hisCode', 'loinc', 'ediCode'] as const)
        .map((k) => { const val = v(rows[i][k]); return val && !CODE_ID_PATTERN.test(val) ? `${k}: ${CODE_ID_MESSAGE}` : null; })
        .find(Boolean);
      if (codeBad) { result.errors.push({ row: i + 1, lisCode, error: codeBad }); continue; }
      const st = v(rows[i].status);
      if (st && !isOneOf(USE_STATUSES, st)) { result.errors.push({ row: i + 1, lisCode, error: `status는 ${USE_STATUSES.join('/')}: ${st}` }); continue; }

      // 덮어쓰기 되는 값 수집 — 빈 셀(undefined)은 변경 대상이 아니다
      const before = prior.get(lisCode);
      const isNew = !before;
      let touched = false;
      for (const k of ['hisCode', 'loinc', 'ediCode', 'status'] as const) {
        const after = v(rows[i][k]);
        if (after === undefined) continue;
        const cur = before ? (before[k] ?? null) : null;
        if (cur !== after) { result.changes.push({ row: i + 1, lisCode, field: k, before: cur, after }); touched = true; }
      }
      if (isNew) result.imported++;
      else if (touched) result.updated++;
      else { result.unchanged++; continue; } // 변경 없음 — 쓰기도 생략
      if (dryRun) continue;
      try {
        await this.prisma.codeMapping.upsert({
          where: { lisCode },
          update: { hisCode: v(rows[i].hisCode), loinc: v(rows[i].loinc), ediCode: v(rows[i].ediCode), status: v(rows[i].status) },
          create: { lisCode, hisCode: v(rows[i].hisCode) ?? null, loinc: v(rows[i].loinc) ?? null, ediCode: v(rows[i].ediCode) ?? null, status: v(rows[i].status) ?? 'USE' },
        });
      } catch (e) {
        if (isNew) result.imported--; else result.updated--;
        result.errors.push({ row: i + 1, lisCode, error: e instanceof Error ? e.message : '실패' });
      }
    }
    return result;
  }

  /**
   * 청구 EDI코드 재동기화(D5) — 미청구(CAPTURED) 항목의 `ediCode`를 현재 코드매핑으로 갱신.
   *
   * BillingItem.ediCode는 **캡처 시점 스냅샷**이다. 규제팀이 실 수가코드를 나중에 적재하면
   * 그 전에 캡처된 항목은 대표값(또는 미매핑) 그대로 굳어 EDI 집계가 틀어진다.
   * 전송이 끝난 항목(CLAIMED)은 전송 당시 근거라 건드리지 않는다 — 미청구분만 현행화한다.
   */
  async resyncBillingEdiCodes() {
    const items = await this.prisma.billingItem.findMany({ where: { status: 'CAPTURED' }, select: { billingId: true, testCode: true, ediCode: true } });
    if (items.length === 0) return { scanned: 0, updated: 0, stillUnmapped: 0, changes: [] as { testCode: string; before: string | null; after: string | null }[] };
    const maps = await this.prisma.codeMapping.findMany({
      where: { lisCode: { in: [...new Set(items.map((i) => i.testCode))] } },
      select: { lisCode: true, ediCode: true },
    });
    const ediByCode = new Map(maps.map((m) => [m.lisCode, m.ediCode]));
    const changes: { testCode: string; before: string | null; after: string | null }[] = [];
    let updated = 0, stillUnmapped = 0;
    for (const it of items) {
      const next = ediByCode.get(it.testCode) ?? null;
      if (next === null) { stillUnmapped++; }
      if (next === it.ediCode) continue;
      // 매핑이 사라진 경우(next=null)는 덮지 않는다 — 있던 근거를 지우는 쪽이 더 나쁘다
      if (next === null) continue;
      await this.prisma.billingItem.update({ where: { billingId: it.billingId }, data: { ediCode: next } });
      changes.push({ testCode: it.testCode, before: it.ediCode, after: next });
      updated++;
    }
    return { scanned: items.length, updated, stillUnmapped, changes: changes.slice(0, 100) };
  }

  /**
   * 결과항목 EDI 반입(HIS 확정 구조 2026-07-18) — 동일 edi_code = 처방의 패널 구성.
   * 각 행(결과검사)에 대해: ①(옵션)검사마스터 생성 ②코드매핑(ediCode·loinc) ③edi_code 그룹 → Panel+PanelItem 자동구성.
   * 폴링 해소는 panelCode=edi_code 전개로 1:N 처리(resolveTestCodes step1).
   */
  async bulkImportResultItems(rows: { ediCode?: string; testCode?: string; name?: string; loinc?: string; specimenType?: string; panelName?: string }[], createTests = false) {
    if (!Array.isArray(rows) || rows.length === 0) throw new BadRequestException('반입할 행이 없습니다');
    if (rows.length > 20000) throw new BadRequestException('한 번에 최대 20000행');
    const v = (s?: string) => { const t = (s ?? '').trim(); return t === '' ? undefined : t; };
    /** 코드성 필드 문자집합 검증(HL7 발신 구분자 주입 차단) — 위반 사유 문자열, 정상이면 null. */
    const badCode = (r: Record<string, string | undefined>, keys: string[]): string | null => {
      for (const k of keys) { const val = v(r[k]); if (val && !CODE_ID_PATTERN.test(val)) return `${k}: ${CODE_ID_MESSAGE}`; }
      return null;
    };
    const tests = new Set((await this.prisma.testMaster.findMany({ select: { testCode: true } })).map((t) => t.testCode));
    const result = { total: rows.length, testsCreated: 0, mappings: 0, panels: 0, panelItems: 0, errors: [] as { row: number; testCode: string; error: string }[] };
    const groups = new Map<string, { panelName?: string; testCodes: Set<string> }>();
    for (let i = 0; i < rows.length; i++) {
      const ediCode = v(rows[i].ediCode);
      const testCode = v(rows[i].testCode);
      if (!ediCode || !testCode) { result.errors.push({ row: i + 1, testCode: testCode ?? '', error: 'ediCode/testCode 누락' }); continue; }
      const cb = badCode(rows[i] as Record<string, string | undefined>, ['ediCode', 'testCode', 'loinc']);
      if (cb) { result.errors.push({ row: i + 1, testCode, error: cb }); continue; }
      try {
        if (!tests.has(testCode)) {
          if (!createTests) { result.errors.push({ row: i + 1, testCode, error: '미등록 검사코드(createTests 미설정)' }); continue; }
          await this.prisma.testMaster.create({ data: { testCode, name: v(rows[i].name) ?? testCode, domain: 'DIAGNOSTIC' as never, loinc: v(rows[i].loinc) ?? null, specimenType: v(rows[i].specimenType) ?? null } });
          tests.add(testCode); result.testsCreated++;
        }
        await this.prisma.codeMapping.upsert({
          where: { lisCode: testCode },
          update: { ediCode, loinc: v(rows[i].loinc) },
          create: { lisCode: testCode, ediCode, loinc: v(rows[i].loinc) ?? null, status: 'USE' },
        });
        result.mappings++;
        let g = groups.get(ediCode);
        if (!g) { g = { panelName: v(rows[i].panelName), testCodes: new Set() }; groups.set(ediCode, g); }
        g.testCodes.add(testCode);
      } catch (e) { result.errors.push({ row: i + 1, testCode, error: e instanceof Error ? e.message : '실패' }); }
    }
    // edi_code 그룹 → Panel + PanelItem(멱등)
    for (const [ediCode, g] of groups) {
      try {
        await this.prisma.panel.upsert({ where: { panelCode: ediCode }, update: { name: g.panelName ?? ediCode }, create: { panelCode: ediCode, name: g.panelName ?? ediCode } });
        result.panels++;
        for (const tc of g.testCodes) {
          await this.prisma.panelItem.upsert({ where: { panelCode_testCode: { panelCode: ediCode, testCode: tc } }, update: {}, create: { panelCode: ediCode, testCode: tc } });
          result.panelItems++;
        }
      } catch (e) { result.errors.push({ row: 0, testCode: ediCode, error: `패널 구성 실패: ${e instanceof Error ? e.message : e}` }); }
    }
    return result;
  }

  // ── 패널(Panel + PanelItem) ──
  listPanels() {
    return this.prisma.panel.findMany({ include: { items: true }, orderBy: { panelCode: 'asc' } });
  }

  /**
   * 구성 설명(UX 기획 §2-5) — 화면 팝오버용. "무엇으로 이루어졌는가"를 한 번에 답한다.
   * - panel: 전개되는 검사 목록(오더 화면에서 `E6512` 하나만 보이던 것)
   * - derived: 계산검사 산출식 + 입력 검사(결과에 CALCULATED만 있고 출처 불명이던 것)
   * - test: 검사 단위·참고치(단위 없이 숫자만 보이던 것 — §2-4)
   */
  async explain(kind: string, id: string) {
    if (kind === 'panel') {
      const p = await this.prisma.panel.findUnique({ where: { panelCode: id }, include: { items: true } });
      if (!p) throw new NotFoundException(`패널 없음: ${id}`);
      const codes = p.items.map((i) => i.testCode);
      const tests = await this.prisma.testMaster.findMany({ where: { testCode: { in: codes } }, select: { testCode: true, name: true, unitUcum: true } });
      const byCode = new Map(tests.map((t) => [t.testCode, t]));
      return {
        kind, id, title: `${p.name} (${p.panelCode})`,
        summary: `이 코드로 오더가 들어오면 검사 ${codes.length}종으로 전개됩니다.`,
        items: codes.map((c) => ({ code: c, name: byCode.get(c)?.name ?? c, unit: byCode.get(c)?.unitUcum ?? null })),
      };
    }
    if (kind === 'derived') {
      const def = DERIVED_TESTS.find((d) => d.testCode === id);
      if (!def) throw new NotFoundException(`계산검사 아님: ${id}`);
      const inputs = await this.prisma.testMaster.findMany({ where: { testCode: { in: def.inputs } }, select: { testCode: true, name: true, unitUcum: true } });
      const byCode = new Map(inputs.map((t) => [t.testCode, t]));
      return {
        kind, id, title: `${def.name} (${def.testCode})`,
        summary: '다른 검사 결과로 자동 계산된 값입니다(직접 측정하지 않습니다).',
        formula: DERIVED_FORMULA[def.testCode] ?? null,
        unit: def.unit,
        items: def.inputs.map((c) => ({ code: c, name: byCode.get(c)?.name ?? c, unit: byCode.get(c)?.unitUcum ?? null })),
      };
    }
    if (kind === 'test') {
      const t = await this.prisma.testMaster.findUnique({ where: { testCode: id } });
      if (!t) throw new NotFoundException(`검사 없음: ${id}`);
      const rr = await this.prisma.referenceRange.findMany({ where: { testCode: id }, orderBy: [{ sex: 'asc' }, { ageMin: 'asc' }] });
      return {
        kind, id, title: `${t.name} (${t.testCode})`,
        summary: t.autoVerify === false ? '이 검사는 항상 사람이 검증합니다(자동확정 안 함).' : '조건을 만족하면 자동확정됩니다.',
        unit: t.unitUcum,
        specimenType: t.specimenType,
        // 참고치는 **단위와 함께** 보여준다 — 숫자만 있으면 단위 오해로 값을 오판한다(§2-4)
        ranges: rr.map((r) => ({
          sex: r.sex, ageMin: r.ageMin, ageMax: r.ageMax,
          normal: formatRange(r.low, r.high, t.unitUcum), // 단위 동반·en-dash 정본(shared)
          panic: r.panicLow != null || r.panicHigh != null ? `${r.panicLow ?? ''} / ${r.panicHigh ?? ''}` : null,
        })),
      };
    }
    throw new BadRequestException(`kind는 panel|derived|test 중 하나: ${kind}`);
  }

  async upsertPanel(dto: UpsertPanelDto) {
    for (const tc of dto.testCodes) await this.assertTest(tc);
    // 패널 upsert + 구성 항목 원자적 교체
    return this.prisma.$transaction(async (tx) => {
      await tx.panel.upsert({
        where: { panelCode: dto.panelCode },
        update: { name: dto.name },
        create: { panelCode: dto.panelCode, name: dto.name },
      });
      await tx.panelItem.deleteMany({ where: { panelCode: dto.panelCode } });
      await tx.panelItem.createMany({
        data: dto.testCodes.map((testCode) => ({ panelCode: dto.panelCode, testCode })),
        skipDuplicates: true,
      });
      return tx.panel.findUnique({ where: { panelCode: dto.panelCode }, include: { items: true } });
    });
  }

  // ── QC 물질/목표치 ──
  listQcTargets() {
    return this.prisma.qcTarget.findMany({ orderBy: [{ qcCode: 'asc' }, { testCode: 'asc' }] });
  }

  upsertQcMaterial(dto: UpsertQcMaterialDto) {
    return this.prisma.qcMaterial.upsert({
      where: { qcCode: dto.qcCode },
      update: { name: dto.name ?? null, lot: dto.lot ?? null, expiry: dto.expiry ?? null },
      create: { qcCode: dto.qcCode, name: dto.name ?? null, lot: dto.lot ?? null, expiry: dto.expiry ?? null },
    });
  }

  /**
   * QC 목표(mean/SD) 저장.
   *
   * ★SD가 0 이하면 **QC가 조용히 무력화된다.** `evaluateWestgard`는 sd<=0에서 판정 불가로
   * 보고 PASS를 돌려주므로, 검사실은 QC가 돌아가는 줄 알지만 **어떤 값을 넣어도 통과**한다.
   * QC PASS는 결과 자동확정의 전제라, 장비가 틀어져도 그대로 환자 결과가 나간다.
   * 실측에서 sd=0이 그대로 저장됐다(200) — 저장 시점에 막는다.
   *
   * mean은 음수를 허용한다 — base excess처럼 정상 범위가 음수인 항목이 있다.
   */
  async upsertQcTarget(dto: UpsertQcTargetDto) {
    await this.assertTest(dto.testCode);
    if (!Number.isFinite(dto.mean)) throw new BadRequestException('QC 평균(mean)이 숫자가 아닙니다');
    if (!Number.isFinite(dto.sd) || dto.sd <= 0) {
      throw new BadRequestException(
        `QC 표준편차(SD)는 0보다 커야 합니다(입력: ${dto.sd}) — 0 이하면 Westgard 판정이 불가능해 QC가 항상 통과로 처리됩니다`,
      );
    }
    const mat = await this.prisma.qcMaterial.findUnique({ where: { qcCode: dto.qcCode } });
    if (!mat) throw new BadRequestException(`미등록 QC 물질: ${dto.qcCode}`);
    // (qcCode, instrument, testCode, lot) 유니크 기준 upsert. lot 미지정=DEFAULT.
    const lot = (dto as { lot?: string }).lot ?? 'DEFAULT';
    const existing = await this.prisma.qcTarget.findUnique({
      where: { qcCode_instrument_testCode_lot: { qcCode: dto.qcCode, instrument: dto.instrument, testCode: dto.testCode, lot } },
    });
    if (existing) {
      return this.prisma.qcTarget.update({
        where: { qcTargetId: existing.qcTargetId },
        data: { mean: dto.mean, sd: dto.sd },
      });
    }
    return this.prisma.qcTarget.create({
      data: {
        qcTargetId: genId('QT'),
        qcCode: dto.qcCode,
        instrument: dto.instrument,
        testCode: dto.testCode,
        lot,
        mean: dto.mean,
        sd: dto.sd,
      },
    });
  }
}
