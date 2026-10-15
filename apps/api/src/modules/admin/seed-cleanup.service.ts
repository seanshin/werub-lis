/**
 * SeedCleanupService — 시드 표식 기반 **선택 삭제**.
 *
 * 대체 대상: `infra/scripts/pilot-cleanup.sql`(테이블 전량 `TRUNCATE CASCADE`).
 * 그 방식은 실 환자 데이터가 이미 들어온 뒤 오실행하면 **전량 소실**되고, 방어가
 * 스크립트 주석의 경고문뿐이었다. 여기서는 `seed_artifact`에 등록된 행만 지우므로
 * **실 데이터는 구조적으로 삭제 대상이 되지 않는다.**
 *
 * 안전장치
 *  1. 실 환자 데이터 감지 시 **하드 차단**(override 없음)
 *  2. 기본은 dry-run — 엔티티별 건수를 먼저 보여준다
 *  3. 실행에는 대상 건수를 담은 **확인 문구**가 일치해야 한다
 *  4. 실행 전후를 감사 체인에 남긴다
 *
 * 근거: docs/개시전환센터_기획서.md §3.4·§3.5
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { Injectable, Logger, BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditChainService } from '../audit/audit-chain.service';
import { IntegrationService } from '../../integration/integration.service';
import { buildAccession } from '../../common/accession.util';

/** 삭제 가능한 배치 — `site-starter`는 마스터라 **정리 대상이 아니다**(보존). */
export const CLEANABLE_BATCHES = ['product-demo', 'site-pilot', 'e2e'] as const;
export type CleanableBatch = (typeof CLEANABLE_BATCHES)[number];

/**
 * 백필 대상 엔티티 — **트랜잭션 데이터만**. 마스터·설정·계정은 넣지 않는다.
 * (`pilot-cleanup.sql`의 정리 대상 목록과 같은 범위. 그쪽이 정본이고 여기가 따라간다.)
 * ⚠ 마스터를 넣으면 백필 후 정리에서 검사 마스터·참고치가 지워져 시스템이 못 쓰게 된다.
 */
export const BACKFILL_ENTITIES = [
  'patient', 'visit', 'labOrder', 'orderItem', 'specimen', 'aliquot', 'resultAttachment',
  'result', 'molecularResult', 'ngsRun', 'somaticFinding', 'billingItem', 'billingClaim', 'sendout',
  'reportDelivery', 'criticalNotify', 'qcReview', 'qcResult', 'culture', 'cultureReport',
  'isolate', 'susceptibility', 'pathologyCase', 'pathologyStainOrder', 'pathologyConsult',
  'cytologyReport', 'ihcResult', 'pathologySpecimen', 'pathologyBlock', 'pathologySlide',
  'pathologyScanEvent', 'pathologyReport', 'pathologyAddendum', 'bloodUnit', 'bloodTyping',
  'patientTransfusionReq', 'transfusionAct', 'transfusionReaction', 'infectiousReport',
  'crossmatch', 'bloodIssue', 'genomicOrder', 'consent', 'variant', 'interpretation',
  'eqaSurvey', 'reflexExecution', 'reflexProtocolEvent', 'notification', 'interfaceLog',
] as const;

/**
 * 🔴 **삭제 금지** — 배치에 등록돼 있어도 지우지 않는다(2026-07-30 적대 검토 CRITICAL).
 *
 * 왜 필요한가: 시드 프록시는 `seedDemoDetail`이 만드는 **의료진 마스터(provider)** 와
 * 데모 직무 계정(appUser)까지 `product-demo`로 등록한다. 이걸 지우면 FK가 막지 않고
 * **ON DELETE SET NULL로 조용히 NULL이 된다** —
 *   `pathology_report.signer`(병리 최종 서명자) · `result.verifier`(결과 검증자) ·
 *   `crossmatch.tester`(교차시험 시행자) · `interpretation.classifier`(변이 분류자).
 * 병행운영 중 실 직원이 데모 계정으로 실 검체를 검증했다면, 개시일 정리에서
 * **"누가 검증했는가"가 소멸**한다(행은 남아 삭제 0건으로 보인다).
 *
 * 계정 폐기는 이 API가 아니라 `/admin/users`(최후 관리자 보호가 있는 경로)에서 한다 — 체크리스트 RUN-2.
 */
const PROTECTED_ENTITIES = new Set([
  'provider', 'appUser', 'userRole', 'role',
  'testMaster', 'panel', 'panelItem', 'referenceRange', 'codeMapping', 'container',
  'qcMaterial', 'qcTarget', 'terminologyCode', 'instrumentMapping', 'barcodeConfig',
  'reflexProtocol', 'hisLabCode', 'catalogVersion', 'catalogItem',
  'systemSetting', 'signoffRecord', 'orgApproval', 'orgApprovalHistory',
  'goLiveApproval', 'goLiveTaskRecord', 'goLiveAttachment', 'siteProfile',
  'cutoverRun', 'seedArtifact', 'decisionRecord', 'auditLog',
]);

/**
 * 실 운영 활동 신호 — 하나라도 미등록 행이 있으면 "실 데이터 있음"으로 본다.
 * 환자·오더만 보던 것을 확장했다(혈액은행 재고·QC·EQA·동의서는 환자 유입 전에도 쌓인다).
 */
const REAL_DATA_SIGNALS = [
  'patient', 'labOrder', 'result', 'bloodUnit', 'qcResult', 'eqaSurvey',
  'consent', 'pathologyCase', 'culture', 'billingClaim',
] as const;

type Delegate = {
  deleteMany: (args: { where: unknown }) => Promise<{ count: number }>;
  count: (args: { where: unknown }) => Promise<number>;
};

@Injectable()
export class SeedCleanupService {
  private readonly logger = new Logger(SeedCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditChain: AuditChainService,
    private readonly integration: IntegrationService,
  ) {}

  /**
   * 삭제 대상 병리 케이스 중 **PACS 워크리스트가 살아 있는** 것.
   *
   * 왜 필요한가(2026-08-03 PACS 회신): 취소는 전파되지만 **삭제는 전파되지 않는다.**
   * 전파 경로가 취소 ORM(ORC-1=CA) 하나뿐인데, 그 ORM은 `pathologyCase`를 읽어서 만든다 —
   * 행을 지운 뒤에는 보낼 방법이 없다. 실제로 07-29 종단검증 픽스처를 LIS에서 지웠더니
   * PACS 워크리스트에 `ACC-SP-26-1008/1009`가 SCHEDULED로 남았고, PACS의 48h 감시가
   * 뒤늦게 잡아냈다. 개시일 파일럿 정리(RUN-6)는 **같은 일을 훨씬 큰 규모로** 한다.
   *
   * 판정 순서(먼저 맞는 것으로 확정):
   *  ① `mwlStatus='CANCELLED'` → 살아 있지 않다
   *  ② IF-09 ORM 로그의 **마지막 메시지**가 NW면 살아 있고, CA면 아니다
   *     — `mwlStatus` 도입 **이전** 송신분이 현 파일럿 DB에 실재하므로 필드만 믿으면 놓친다.
   *       반대로 로그를 "NW가 있었는가"로만 보면 **이미 취소한 건까지 다시 세어** 개시일에
   *       보낼 건수가 부풀려진다(예행에서 SP-2026-0002가 그렇게 잡혔다 — 07-15에 CA 2회 발신됨).
   *  ③ 로그가 없으면 `mwlStatus='SENT'`로 판단
   * 애매하면 **살아 있는 쪽으로** 센다 — 모르는 accession에 CA를 한 번 더 보내는 것은 무해하지만,
   * 빠뜨리면 PACS에 고아가 남는다. **이 선택은 실측으로 검증됐다**(2026-08-03 PACS 회신):
   * 항목이 없으면 `cancel-noop`, COMPLETED·수행중이면 `cancel-ignored`(상태 보존), 이미 취소면 멱등 —
   * **네 경우 모두 AA**이고 오류가 없다.
   *
   * ⚠ 그래서 `mwlCancelled`는 **"발신에 성공했다"는 뜻이지 "워크리스트가 있었다"는 증명이 아니다.**
   *   PACS도 ACK만으로는 전이와 미존재-무시를 구분할 수 없다(둘 다 AA). 고아 여부의 최종 확인은
   *   PACS 워크리스트 대조뿐이다.
   */
  private async liveWorklistSpNos(spNos: string[]): Promise<string[]> {
    if (spNos.length === 0) return [];
    const cases = await this.prisma.pathologyCase.findMany({
      where: { spNo: { in: spNos } },
      select: { spNo: true, mwlStatus: true, report: { select: { accessionNo: true } } },
    });

    // accession별 **마지막** ORM 종류(NW/CA). 취소 후 재송신도 있으므로 순서가 판정을 가른다.
    const logs = await this.prisma.interfaceLog.findMany({
      where: { ifId: 'IF-09', messageType: { in: ['ORM^O01(MWL)', 'ORM^O01(MWL-CANCEL)'] } },
      select: { messageType: true, payload: true, createdDt: true },
      orderBy: { createdDt: 'asc' },
      take: 5000,
    });
    const lastOrm = new Map<string, 'NW' | 'CA'>();
    for (const l of logs) {
      const acc = /ACC-[A-Za-z0-9-]+/.exec(l.payload ?? '')?.[0];
      if (acc) lastOrm.set(acc, l.messageType === 'ORM^O01(MWL-CANCEL)' ? 'CA' : 'NW');
    }

    const live: string[] = [];
    for (const c of cases) {
      if (c.mwlStatus === 'CANCELLED') continue;
      const last = lastOrm.get(c.report?.accessionNo ?? buildAccession(c.spNo));
      if (last === 'NW' || (last === undefined && c.mwlStatus === 'SENT')) live.push(c.spNo);
    }
    return live.sort();
  }

  /** 배치의 삭제 대상 병리 케이스 spNo 목록(등록부 기준). */
  private async pathologyTargets(batch: CleanableBatch): Promise<string[]> {
    const rows = await this.prisma.seedArtifact.findMany({
      where: { batch, entity: 'pathologyCase' }, select: { pk: true },
    });
    return rows.map((r) => r.pk);
  }

  private delegate(entity: string): Delegate | null {
    const d = (this.prisma as unknown as Record<string, unknown>)[entity];
    if (!d || typeof d !== 'object') return null;
    const cand = d as Partial<Delegate>;
    return typeof cand.deleteMany === 'function' && typeof cand.count === 'function' ? (d as Delegate) : null;
  }

  /**
   * 전환 실행 이력 기록 — 감사 체인과 **역할이 다르다.**
   * 감사는 전 조치가 섞인 append-only 로그라 "무엇이 지워졌나"를 되짚기 어렵다.
   * 여기는 실행 단위로 전/후를 함께 남긴다. 기록 실패가 실행을 막지 않는다.
   */
  private async recordRun(r: {
    step: string; result: 'OK' | 'BLOCKED' | 'FAILED';
    requestedBy: string | null; approvedBy?: string | null;
    before?: unknown; after?: unknown; message?: string;
  }): Promise<void> {
    try {
      await this.prisma.cutoverRun.create({
        data: {
          runId: `RUN-${randomUUID()}`, step: r.step, mode: 'EXEC', result: r.result,
          requestedBy: r.requestedBy, approvedBy: r.approvedBy ?? null,
          beforeJson: r.before ? JSON.stringify(r.before).slice(0, 4000) : null,
          afterJson: r.after ? JSON.stringify(r.after).slice(0, 4000) : null,
          message: r.message?.slice(0, 500) ?? null, finishedDt: new Date(),
        },
      });
    } catch (e) {
      this.logger.warn(`전환 실행 이력 기록 실패(${r.step}): ${e instanceof Error ? e.message : e}`);
    }
  }

  /** 전환 실행 이력 조회 — 최근순. */
  async runs(limit = 50) {
    return this.prisma.cutoverRun.findMany({
      orderBy: { startedDt: 'desc' },
      take: Math.min(Math.max(limit, 1), 200),
    });
  }

  private assertBatch(batch: string): CleanableBatch {
    if (!(CLEANABLE_BATCHES as readonly string[]).includes(batch)) {
      throw new BadRequestException(
        `정리 가능한 배치는 ${CLEANABLE_BATCHES.join('·')} 입니다(site-starter는 마스터라 보존): ${batch}`,
      );
    }
    return batch as CleanableBatch;
  }

  /**
   * 🔴 실 환자 데이터 감지 — 하나라도 있으면 정리를 **거부**한다.
   *
   * 판정: 시드로 등록되지 않은 환자 또는 오더가 존재하는가.
   * 실 진료가 시작된 뒤에는 어떤 이유로도 파일럿 정리를 돌리지 않는다.
   */
  async detectRealData(): Promise<{ clean: boolean; realPatients: number; realOrders: number; signals: { entity: string; unregistered: number }[] }> {
    // ★환자·오더만 보면 사각지대가 크다(2026-07-30 적대 검토 HIGH).
    //   혈액제제 재고·QC/EQA·유전체 동의서는 환자 유입 전에도 실운영으로 쌓인다.
    //   그 상태에서 clean으로 보이면 백필→정리로 **실 재고·정도관리 이력이 사라진다.**
    const signals: { entity: string; unregistered: number }[] = [];
    for (const entity of REAL_DATA_SIGNALS) {
      const del = this.delegate(entity);
      if (!del) continue;
      const fields = await this.pkFields(entity);
      if (!fields || fields.length !== 1) continue;
      const [total, registered] = await Promise.all([
        del.count({ where: {} }),
        this.prisma.seedArtifact.count({ where: { entity } }),
      ]);
      const unregistered = Math.max(total - registered, 0);
      if (unregistered > 0) signals.push({ entity, unregistered });
    }
    const realPatients = signals.find((s2) => s2.entity === 'patient')?.unregistered ?? 0;
    const realOrders = signals.find((s2) => s2.entity === 'labOrder')?.unregistered ?? 0;
    return { clean: signals.length === 0, realPatients, realOrders, signals };
  }

  /**
   * 백필 — 추적 도입 **이전에** 쌓인 데이터를 `site-pilot`으로 등록한다(등록만, 삭제 없음).
   *
   * 왜 필요한가: 추적은 2026-07-30부터다. 그 전에 설치된 사이트(현 파일럿)는 시드 산출물이
   * 등록돼 있지 않아, 정리 API가 전부 "실 데이터"로 보아 차단한다(fail-safe라 옳지만 정리가 막힌다).
   *
   * ★휴리스틱으로 "이건 시드 같다"를 추측하지 않는다 — 실 데이터를 잘못 등록하면
   *   나중에 **실 환자 기록이 정리 대상이 된다.** 대신 **"이 DB는 전부 파일럿"이라는 사람의
   *   단언**을 확인 문구로 받는다. 그 단언이 참인 DB에서만 쓰는 기능이다.
   */
  private readonly BACKFILL_PHRASE = '이 데이터베이스에는 실 환자 데이터가 없습니다';

  /** 백필 대상 미리보기 — 미등록 행이 엔티티별로 몇 개인지(읽기 전용). */
  async backfillPreview() {
    const registered = await this.prisma.seedArtifact.groupBy({ by: ['entity'], _count: { _all: true } });
    const regBy = new Map(registered.map((r) => [r.entity, r._count._all]));
    const rows: { entity: string; total: number; registered: number; unregistered: number }[] = [];
    for (const entity of BACKFILL_ENTITIES) {
      const del = this.delegate(entity);
      if (!del) continue;
      const total = await del.count({ where: {} });
      if (total === 0) continue;
      const reg = regBy.get(entity) ?? 0;
      rows.push({ entity, total, registered: reg, unregistered: Math.max(total - reg, 0) });
    }
    const unregistered = rows.reduce((s, r) => s + r.unregistered, 0);
    return {
      unregistered,
      rows: rows.filter((r) => r.unregistered > 0).sort((a, b) => b.unregistered - a.unregistered),
      // ★확인 문구를 응답에 담지 않는다(2026-07-30 적대 검토 CRITICAL).
      //   담으면 화면이 그대로 되돌려 보내 '사람의 단언'이 버튼 한 번으로 전락한다.
      //   운영자는 설치 가이드에 적힌 문구를 직접 입력한다.
      confirmPhraseHint: '설치 가이드 §3-1의 백필 확인 문구를 직접 입력하십시오(응답에 담지 않습니다)',
      warning:
        '백필은 **등록만** 하고 아무것도 삭제하지 않는다. 다만 등록된 행은 이후 정리 대상이 되므로, ' +
        '실 환자 데이터가 섞인 DB에서는 절대 실행하지 말 것.',
    };
  }

  /** 백필 실행 — 미등록 행을 site-pilot으로 등록. 삭제하지 않는다. */
  async backfill(confirmPhrase: string, userId: string | null, approverId?: string) {
    // 백필은 **삭제 반경을 가장 크게 바꾸는 조작**이다(실 데이터를 '시드'로 만든다).
    // 기본으로 꺼져 있다 — 기관이 승인 절차를 정한 뒤 LIS_SEED_BACKFILL_ENABLED=1 로 켠다.
    if (process.env.LIS_SEED_BACKFILL_ENABLED !== '1') {
      throw new ForbiddenException('백필은 기본으로 꺼져 있습니다 — 기관이 승인 절차를 정한 뒤 LIS_SEED_BACKFILL_ENABLED=1 로 켜십시오(PUBLIC-EDITION.md)');
    }
    // 요청자·승인자 둘 다 활성 ADM이고 서로 달라야 한다.
    await this.assertActiveAdmin(userId, '요청자');
    await this.assertActiveAdmin(approverId ?? null, '승인자');
    if (userId === approverId) throw new BadRequestException('승인자는 요청자와 달라야 합니다(직무분리)');
    if (confirmPhrase !== this.BACKFILL_PHRASE) {
      throw new BadRequestException(
        `확인 문구가 일치하지 않습니다. 실 환자 데이터가 없는 DB에서만 실행하며, 정확히 입력해야 합니다: "${this.BACKFILL_PHRASE}"`,
      );
    }
    void this.auditChain.append({
      userId, action: 'SYSTEM', target: '/admin/seed-cleanup/backfill',
      detail: '백필 시작 — 미등록 행을 site-pilot으로 등록(삭제 없음)', status: null, sensitive: false,
    });

    let registered = 0;
    const byEntity: { entity: string; count: number }[] = [];
    for (const entity of BACKFILL_ENTITIES) {
      const fields = await this.pkFields(entity);
      const del = this.delegate(entity);
      if (!fields || !del) continue;
      const findMany = (this.prisma as unknown as Record<string, { findMany: (a: unknown) => Promise<Record<string, unknown>[]> }>)[entity];
      const rows = await findMany.findMany({ select: Object.fromEntries(fields.map((f) => [f, true])) });
      if (rows.length === 0) continue;
      const data = rows.map((row, i) => {
        const pk = fields.map((f) => String(row[f])).join('|');
        return {
          artifactId: `SA-backfill-${entity}-${Buffer.from(pk).toString('base64url').slice(0, 24)}-${i}`,
          batch: 'site-pilot', entity, pk,
        };
      });
      const r = await this.prisma.seedArtifact.createMany({ data, skipDuplicates: true });
      if (r.count > 0) { registered += r.count; byEntity.push({ entity, count: r.count }); }
    }

    void this.auditChain.append({
      userId, action: 'SYSTEM', target: '/admin/seed-cleanup/backfill',
      detail: `백필 완료 — ${registered}건 등록(site-pilot). 삭제 없음`, status: null, sensitive: false,
    });
    this.logger.warn(`시드 백필: ${registered}건 등록(site-pilot)`);
    await this.recordRun({
      step: 'seed-backfill', result: 'OK', requestedBy: userId, approvedBy: approverId ?? null,
      after: byEntity, message: `${registered}건 등록(site-pilot) · 삭제 0`,
    });
    return { registered, byEntity: byEntity.sort((a, b) => b.count - a.count), deleted: 0 };
  }

  /** 정리 대상 미리보기 — 읽기 전용. 실행 전 반드시 이걸로 건수를 확인한다. */
  async preview(batch: string) {
    const b = this.assertBatch(batch);
    const rows = await this.prisma.seedArtifact.groupBy({
      by: ['entity'],
      where: { batch: b },
      _count: { _all: true },
    });
    const targets = rows
      .filter((r) => !PROTECTED_ENTITIES.has(r.entity)) // 보호 엔티티는 대상이 아니다 — 건수에도 넣지 않는다
      .map((r) => ({ entity: r.entity, count: r._count._all }))
      .sort((a, b2) => b2.count - a.count);
    const total = targets.reduce((s, t) => s + t.count, 0);
    const real = await this.detectRealData();
    const pacsWorklist = await this.liveWorklistSpNos(await this.pathologyTargets(b));
    return {
      batch: b,
      total,
      targets,
      realData: real,
      blocked: !real.clean,
      // 실행 시 이 건들에 취소 ORM을 **먼저** 보낸다 — 지운 뒤에는 보낼 방법이 없다.
      pacsWorklist: {
        count: pacsWorklist.length,
        spNos: pacsWorklist,
        note: pacsWorklist.length
          ? `PACS 워크리스트가 살아 있는 병리 케이스 ${pacsWorklist.length}건 — 삭제 전 취소 ORM 자동 발신`
          : 'PACS 워크리스트 잔여 없음',
      },
      confirmPhrase: `${b} ${total}건 삭제`, // 실행 시 이 문구를 그대로 보내야 한다
      note: real.clean
        ? '실 환자 데이터 없음 — 정리 가능'
        : `🔴 실 데이터 감지(환자 ${real.realPatients}·오더 ${real.realOrders}) — 정리 불가`,
    };
  }

  /**
   * 실행 — 등록된 행만 지운다. FK는 **반복 패스**로 푼다(하드코딩 순서를 두지 않는다 —
   * 스키마가 바뀌면 순서표가 조용히 낡기 때문이다). 진전이 없으면 남은 것을 보고하고 멈춘다.
   */
  /**
   * 2인 승인 확인 — 요청자 ≠ 승인자, 둘 다 활성 ADM.
   *
   * 수혈 출고 2인 확인·결과 자가검증 차단과 **같은 직무분리 패턴**이다.
   * 특히 `실행자가 승인자 2인 중 1인이어야 한다`는 조건이 핵심 — 없으면 한 사람이 남의 ID 둘을
   * 타이핑해 독립 승인을 위조할 수 있다(수혈에서 이미 겪어 T3로 못박은 규칙).
   */
  private async assertActiveAdmin(userId: string | null, label: string): Promise<void> {
    if (!userId) throw new BadRequestException(`${label} 계정을 확인할 수 없습니다`);
    const u = await this.prisma.appUser.findFirst({
      where: { userId, status: 'ACTIVE' },
      select: { roles: { select: { roleCode: true } } },
    });
    if (!u) throw new BadRequestException(`${label}(${userId})는 유효한 활성 계정이 아닙니다`);
    if (!u.roles.some((r) => r.roleCode === 'ADM')) {
      throw new BadRequestException(`${label}(${userId})는 관리자(ADM)가 아닙니다 — 비가역 작업 불가`);
    }
  }

  /** 요청 유효 시간 — 오래된 요청이 남아 나중에 승인되는 것을 막는다. */
  private readonly REQUEST_TTL_MS = 30 * 60 * 1000;

  /**
   * ① 요청 — 실행자가 게이트(실데이터·확인문구)를 통과시켜 **승인 대기 건**을 만든다.
   *
   * ★왜 2단계인가(2026-07-30 적대 검토 HIGH): 이전에는 승인자 ID를 **실행자가 타이핑**했다.
   *   승인자는 인증하지 않았으므로, ADM 계정 하나를 쥔 사람이 다른 ADM의 ID만 알면 통과했다.
   *   수혈 2인 확인은 병상 옆 물리적 현장 확인이 전제인데, 이건 원격 HTTP 한 방이다.
   *   이제 **승인자가 자기 토큰으로 직접 승인**해야 실행된다.
   */
  async request(batch: string, confirmPhrase: string, userId: string | null) {
    const b = this.assertBatch(batch);
    await this.assertActiveAdmin(userId, '요청자');
    const pre = await this.preview(b);
    if (pre.blocked) {
      await this.recordRun({
        step: `seed-cleanup:${b}`, result: 'BLOCKED', requestedBy: userId,
        before: pre.targets, message: `실 데이터 감지 — 요청 거부`,
      });
      throw new ConflictException(`실 환자 데이터가 있어 요청할 수 없습니다(${pre.note})`);
    }
    if (pre.total === 0) throw new BadRequestException('정리 대상이 없습니다');
    if (confirmPhrase !== pre.confirmPhrase) {
      throw new BadRequestException(`확인 문구가 일치하지 않습니다. 정확히 입력하세요: "${pre.confirmPhrase}"`);
    }
    const runId = `RUN-${randomUUID()}`;
    await this.prisma.cutoverRun.create({
      data: {
        runId, step: `seed-cleanup:${b}`, mode: 'EXEC', result: 'REQUESTED', requestedBy: userId,
        beforeJson: JSON.stringify(pre.targets).slice(0, 4000),
        message: `승인 대기 — 대상 ${pre.total}건. 다른 관리자가 ${this.REQUEST_TTL_MS / 60000}분 내 승인해야 실행된다`,
      },
    });
    void this.auditChain.append({
      userId, action: 'POST', target: `/admin/seed-cleanup/request/${b}`,
      detail: `시드 정리 요청 — 대상 ${pre.total}건(승인 대기 ${runId})`, status: null, sensitive: false,
    });
    // 승인자는 무엇이 지워지는지와 함께 **PACS로 나갈 취소 ORM**도 보고 판단한다(외부 시스템 부작용).
    return { runId, batch: b, total: pre.total, targets: pre.targets, pacsWorklist: pre.pacsWorklist, expiresInMinutes: this.REQUEST_TTL_MS / 60000 };
  }

  /** 대기 중인 요청 목록 — 승인자가 무엇을 승인하는지 보고 결정한다. */
  async pendingRequests() {
    const since = new Date(Date.now() - this.REQUEST_TTL_MS);
    return this.prisma.cutoverRun.findMany({
      where: { result: 'REQUESTED', startedDt: { gte: since } },
      orderBy: { startedDt: 'desc' }, take: 20,
    });
  }

  /**
   * ② 승인·실행 — **승인자 본인의 토큰**으로 호출한다. 요청자와 같으면 거부.
   */
  async approveAndExecute(runId: string, approverId: string | null) {
    await this.assertActiveAdmin(approverId, '승인자');
    const run = await this.prisma.cutoverRun.findUnique({ where: { runId } });
    if (!run || run.result !== 'REQUESTED') throw new NotFoundException('승인 대기 중인 요청이 아닙니다');
    if (Date.now() - run.startedDt.getTime() > this.REQUEST_TTL_MS) {
      await this.prisma.cutoverRun.update({ where: { runId }, data: { result: 'FAILED', message: '요청 만료', finishedDt: new Date() } });
      throw new BadRequestException('요청이 만료됐습니다 — 다시 요청하십시오');
    }
    if (run.requestedBy && run.requestedBy === approverId) {
      throw new BadRequestException('요청자는 자신의 요청을 승인할 수 없습니다(직무분리)');
    }
    const batch = run.step.replace('seed-cleanup:', '');
    // 승인 시점에 게이트를 **다시** 판정한다 — 요청 이후 실 데이터가 유입됐을 수 있다.
    const pre = await this.preview(batch);
    if (pre.blocked) {
      await this.prisma.cutoverRun.update({ where: { runId }, data: { result: 'BLOCKED', message: '승인 시점 실 데이터 감지', finishedDt: new Date() } });
      throw new ConflictException(`실 환자 데이터가 감지되어 실행하지 않습니다(${pre.note})`);
    }
    await this.prisma.cutoverRun.delete({ where: { runId } }); // 실행 이력은 execute가 새로 남긴다
    return this.execute(batch, pre.confirmPhrase, run.requestedBy, approverId ?? undefined);
  }

  /** 내부 실행 — 게이트는 request/approve가 이미 통과시켰다. 직접 호출하지 않는다. */
  private async execute(batch: string, confirmPhrase: string, userId: string | null, approverId?: string) {
    const b = this.assertBatch(batch);
    const pre = await this.preview(b);

    if (pre.blocked) {
      // 차단된 시도도 남긴다 — 실 데이터가 있는데 정리를 시도했다는 사실 자체가 신호다.
      await this.recordRun({
        step: `seed-cleanup:${b}`, result: 'BLOCKED', requestedBy: userId, approvedBy: approverId ?? null,
        before: pre.targets, message: `실 데이터 감지(환자 ${pre.realData.realPatients}·오더 ${pre.realData.realOrders}) — 거부`,
      });
      throw new ConflictException(
        `실 환자 데이터가 있어 정리를 거부합니다(환자 ${pre.realData.realPatients}·오더 ${pre.realData.realOrders}). ` +
          '실 진료 개시 후에는 어떤 경우에도 시드 정리를 실행하지 않습니다.',
      );
    }
    if (pre.total === 0) return { batch: b, deleted: 0, byEntity: [], skipped: [], note: '대상 없음' };
    if (confirmPhrase !== pre.confirmPhrase) {
      throw new BadRequestException(`확인 문구가 일치하지 않습니다. 정확히 입력하세요: "${pre.confirmPhrase}"`);
    }

    void this.auditChain.append({
      userId, action: 'DELETE', target: `/admin/seed-cleanup/${b}`,
      detail: `시드 정리 시작 — 대상 ${pre.total}건 · 승인자 ${approverId ?? '-'}(${pre.targets.map((t) => `${t.entity}:${t.count}`).join(', ')})`.slice(0, 500),
      status: null, sensitive: false,
    });

    const artifacts = await this.prisma.seedArtifact.findMany({
      where: { batch: b }, select: { entity: true, pk: true },
    });
    const byEntity = new Map<string, string[]>();
    for (const a of artifacts) {
      const list = byEntity.get(a.entity);
      if (list) list.push(a.pk); else byEntity.set(a.entity, [a.pk]);
    }

    // 🔴 보호 엔티티는 등록돼 있어도 지우지 않는다 — SET NULL로 서명자·검증자가 소멸한다.
    const protectedHit = [...byEntity.keys()].filter((e) => PROTECTED_ENTITIES.has(e));
    for (const e of protectedHit) byEntity.delete(e);

    /**
     * ★삭제 **전에** PACS 워크리스트를 취소한다 — 순서가 바뀌면 되돌릴 수 없다.
     *   취소 ORM은 `pathologyCase`를 읽어 만들기 때문에, 행이 사라지면 LIS가 보낼 수단을 잃고
     *   PACS에는 SCHEDULED가 영구히 남는다(07-29 픽스처 정리에서 실제로 발생, PACS가 발견).
     *   best-effort다 — PACS가 죽어 있어도 정리는 진행하되, 무엇이 실패했는지 남긴다.
     *   실패분은 사람이 PACS 쪽에서 CANCELLED 전이시켜야 한다(회신 2026-08-03 ①(B)와 같은 처리).
     */
    const worklist = await this.liveWorklistSpNos(byEntity.get('pathologyCase') ?? []);
    const mwlCancelled: string[] = [];
    const mwlFailed: { spNo: string; error: string }[] = [];
    for (const spNo of worklist) {
      try {
        await this.integration.cancelPathologyWorklist(spNo);
        mwlCancelled.push(spNo);
      } catch (e) {
        mwlFailed.push({ spNo, error: (e instanceof Error ? e.message : String(e)).slice(0, 200) });
      }
    }
    if (worklist.length) {
      this.logger.warn(`시드 정리(${b}): PACS 워크리스트 선취소 ${mwlCancelled.length}/${worklist.length}건`);
      void this.auditChain.append({
        userId, action: 'POST', target: `/admin/seed-cleanup/${b}/mwl-cancel`,
        detail: `삭제 전 PACS 워크리스트 취소 — 성공 ${mwlCancelled.length}·실패 ${mwlFailed.length}(${mwlFailed.map((f) => f.spNo).join(',') || '-'})`.slice(0, 500),
        status: null, sensitive: false,
      });
    }

    const deleted: { entity: string; count: number }[] = [];
    let remaining = [...byEntity.keys()];
    // 반복 패스: FK 위반은 "아직 자식이 남았다"는 뜻이므로 다음 패스에서 다시 시도한다.
    for (let pass = 0; pass < 12 && remaining.length > 0; pass++) {
      const stillFailing: string[] = [];
      for (const entity of remaining) {
        const del = this.delegate(entity);
        if (!del) { stillFailing.push(entity); continue; }
        const pks = byEntity.get(entity) ?? [];
        try {
          const where = await this.whereForPks(entity, pks);
          if (!where) { stillFailing.push(entity); continue; }
          const r = await del.deleteMany({ where });
          deleted.push({ entity, count: r.count });
        } catch {
          stillFailing.push(entity);
        }
      }
      if (stillFailing.length === remaining.length) break; // 진전 없음 — 무한 루프 방지
      remaining = stillFailing;
    }

    const totalDeleted = deleted.reduce((s, d) => s + d.count, 0);
    // 지운 행의 등록만 제거한다(남은 것은 등록을 유지해 다음 실행에서 다시 시도).
    const cleared = deleted.filter((d) => d.count > 0).map((d) => d.entity);
    if (cleared.length) {
      await this.prisma.seedArtifact.deleteMany({ where: { batch: b, entity: { in: cleared } } });
    }

    void this.auditChain.append({
      userId, action: 'DELETE', target: `/admin/seed-cleanup/${b}`,
      detail: `시드 정리 완료 — 삭제 ${totalDeleted}건, 잔여 엔티티 ${remaining.length}종`.slice(0, 500),
      status: null, sensitive: false,
    });
    this.logger.warn(`시드 정리(${b}): 삭제 ${totalDeleted}건 · 잔여 ${remaining.join(',') || '없음'}`);

    const outcome = {
      batch: b,
      deleted: totalDeleted,
      byEntity: deleted.filter((d) => d.count > 0),
      skipped: remaining, // 복합키·FK 미해소 — 남으면 사람이 확인한다
      protectedSkipped: protectedHit, // 마스터·계정은 이 API로 지우지 않는다(/admin/users·서명 화면 소관)
      // 취소 실패분은 PACS 워크리스트에 고아로 남는다 — 화면이 반드시 보여줘야 사람이 처리한다.
      mwlCancelled,
      mwlFailed,
      note: remaining.length ? '일부 엔티티가 남았습니다 — 잔여 목록을 확인하세요' : '정리 완료',
    };
    await this.recordRun({
      step: `seed-cleanup:${b}`, result: remaining.length ? 'FAILED' : 'OK',
      requestedBy: userId, approvedBy: approverId ?? null,
      before: pre.targets, after: outcome.byEntity,
      message: `삭제 ${totalDeleted}건${remaining.length ? ` · 잔여 ${remaining.join(',')}` : ''}`
        + (worklist.length ? ` · PACS 취소 ${mwlCancelled.length}/${worklist.length}${mwlFailed.length ? `(실패 ${mwlFailed.map((f) => f.spNo).join(',')})` : ''}` : ''),
    });
    return outcome;
  }

  /**
   * PK 문자열 목록 → deleteMany의 where.
   * 단일키는 `{ id: { in: [...] } }`, **복합키는 `{ OR: [{a,b}, …] }`**.
   * 복합키를 못 다루면 `user_role`이 남고, 그것이 참조하는 `app_user`(데모 계정)도 못 지운다 —
   * 개시 전 데모 계정 폐기(체크리스트 B1)가 통째로 막힌다. 실측으로 확인해 보강했다.
   */
  private idFieldCache = new Map<string, string[] | null>();
  private async pkFields(entity: string): Promise<string[] | null> {
    if (this.idFieldCache.has(entity)) return this.idFieldCache.get(entity) ?? null;
    const { Prisma } = await import('@prisma/client');
    const model = Prisma.dmmf.datamodel.models.find(
      (m) => m.name.charAt(0).toLowerCase() + m.name.slice(1) === entity,
    );
    let fields: string[] | null = null;
    if (model) {
      if (model.primaryKey?.fields?.length) fields = [...model.primaryKey.fields];
      else {
        const id = model.fields.find((f) => f.isId)?.name;
        fields = id ? [id] : null;
      }
    }
    this.idFieldCache.set(entity, fields);
    return fields;
  }

  private async whereForPks(entity: string, pks: string[]): Promise<Record<string, unknown> | null> {
    const fields = await this.pkFields(entity);
    if (!fields || fields.length === 0 || pks.length === 0) return null;
    if (fields.length === 1) return { [fields[0]]: { in: pks } };
    const or = pks
      .map((pk) => {
        const parts = pk.split('|');
        if (parts.length !== fields.length) return null;
        return Object.fromEntries(fields.map((f, i) => [f, parts[i]]));
      })
      .filter((x): x is Record<string, string> => x !== null);
    return or.length ? { OR: or } : null;
  }
}
