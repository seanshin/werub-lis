/**
 * GoLiveService — 개시 전환 체크리스트(단일 진입점).
 *
 * 문서 3종(체크리스트 A~H · 잔여 의뢰서 · 컷오버 런시트)에만 있던 항목을 시스템 항목으로 올린다.
 * 정의는 코드 레지스트리(`golive-registry.ts`), 상태만 DB(`golive_task_record`).
 *
 * ★자동 판정 항목은 사람이 완료 처리할 수 없다 — "화면상 완료"로 오인하는 사고를 근본 차단한다
 *   (2026-07-30 실측: 위험치 URL이 `설정됨`이지만 시드 sink, 게이트가 `APPROVED`지만 플레이스홀더).
 *
 * 근거: docs/개시전환센터_기획서.md §3.2
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */
import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { AuditChainService } from '../audit/audit-chain.service';
import { UserAdminService } from './user-admin.service';
import { GoLiveAttachmentService } from './golive-attachment.service';
import {
  GOLIVE_REGISTRY_VERSION, GOLIVE_TASK_BY_CODE, GOLIVE_TASKS, SITE_CAPABILITIES,
  tasksForCapabilities, type GoLiveTask,
} from '../../domain/golive-registry';

type TaskStatus = 'OPEN' | 'DONE' | 'NA';
type AutoStatus = 'OK' | 'WARN' | 'BLOCK' | 'SEED' | 'REVIEW';

@Injectable()
export class GoLiveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditChain: AuditChainService,
    private readonly userAdmin: UserAdminService,
    private readonly attachments: GoLiveAttachmentService,
  ) {}

  /** 사이트 프로파일 — 없으면 전 기능 활성으로 간주한다(기존 설치본 호환). */
  async profile() {
    const row = await this.prisma.siteProfile.findFirst({ where: { id: 1 } });
    if (row) {
      return {
        siteCode: row.siteCode, siteName: row.siteName,
        capabilities: row.capabilities.split(',').map((c) => c.trim()).filter(Boolean),
        installedDt: row.installedDt, configured: true,
      };
    }
    return {
      siteCode: process.env.LIS_SITE_CODE ?? 'UNSET',
      siteName: null as string | null,
      capabilities: [...SITE_CAPABILITIES],
      installedDt: null as Date | null,
      configured: false, // 미설정 — 전 기능 활성으로 간주(항목이 누락되는 쪽보다 안전)
    };
  }

  async saveProfile(dto: { siteCode: string; siteName?: string; capabilities: string[]; reason?: string }, userId: string | null) {
    const bad = dto.capabilities.filter((c) => !(SITE_CAPABILITIES as readonly string[]).includes(c));
    if (bad.length) throw new BadRequestException(`알 수 없는 기능: ${bad.join(', ')}`);

    // ★개시 차단을 없애는 프로파일에는 **사유가 필수**다(NA와 같은 원칙).
    //   기능을 빼면 그 기능의 항목이 생성되지 않아 차단이 조용히 줄어든다 —
    //   실수든 고의든, 왜 뺐는지 답할 수 있어야 한다.
    const droppedBlocking = this.excludedFor(dto.capabilities).filter((e) => e.blocking);
    if (droppedBlocking.length > 0 && !dto.reason?.trim()) {
      throw new BadRequestException(
        `이 구성은 개시 차단 ${droppedBlocking.length}건을 제외합니다(${droppedBlocking.map((e) => e.code).join('·')}) — ` +
          '사유가 필요합니다. 해당 기능을 실제로 쓰지 않는다면 그 사실을 적으십시오.',
      );
    }
    const data = {
      siteCode: dto.siteCode, siteName: dto.siteName ?? null,
      capabilities: dto.capabilities.join(','),
    };
    const saved = await this.prisma.siteProfile.upsert({ where: { id: 1 }, update: data, create: { id: 1, ...data } });
    void this.auditChain.append({
      userId, action: 'PUT', target: '/admin/golive/profile',
      detail: `사이트 프로파일 저장 — ${dto.siteCode}(${data.capabilities})` +
        (droppedBlocking.length ? ` · 개시차단 ${droppedBlocking.length}건 제외(${droppedBlocking.map((e) => e.code).join('·')}) 사유: ${dto.reason}` : ''),
      status: null, sensitive: false,
    });
    return saved;
  }

  /**
   * 자동 판정 결과를 항목 키로 인덱싱한다 — **판정 로직을 여기서 다시 쓰지 않는다.**
   * 소스는 둘: `readiness()`(개시 준비도 checks)와 `managementConsole()`(관리 5축 items).
   * 키가 양쪽에 있으면 readiness를 우선한다.
   */
  /** 요청 스코프 캐시 — checklist 한 번에 판정 소스를 두 번 부르지 않는다(25→11 쿼리). */
  private autoCache: { at: number; map: Map<string, { status: AutoStatus; detail: string | null }> } | null = null;
  private readonly AUTO_TTL_MS = 3000;

  private async autoChecks(): Promise<Map<string, { status: AutoStatus; detail: string | null }>> {
    const now = Date.now();
    if (this.autoCache && now - this.autoCache.at < this.AUTO_TTL_MS) return this.autoCache.map;
    const map = new Map<string, { status: AutoStatus; detail: string | null }>();
    const add = (items: { key: string; status: string; detail?: string | null }[] | undefined) => {
      for (const it of items ?? []) {
        if (!map.has(it.key)) map.set(it.key, { status: it.status as AutoStatus, detail: it.detail ?? null });
      }
    };
    try {
      const rd = (await this.userAdmin.readiness()) as unknown as { checks?: { key: string; status: string; detail?: string | null }[] };
      add(rd.checks);
    } catch { /* 미판정으로 남긴다 — 체크리스트 전체를 못 보게 만들지 않는다 */ }
    try {
      const con = (await this.userAdmin.managementConsole()) as unknown as {
        axes?: { items: { key: string; status: string; detail?: string | null }[] }[];
      };
      add((con.axes ?? []).flatMap((a) => a.items ?? []));
    } catch { /* 〃 */ }
    this.autoCache = { at: now, map };
    return map;
  }

  private resolve(task: GoLiveTask, rec: { status: string; naReason: string | null; completedBy: string | null; completedDt: Date | null; note: string | null } | undefined,
    auto: Map<string, { status: AutoStatus; detail: string | null }>, attachCount = 0) {
    if (task.autoCheck) {
      const a = auto.get(task.autoCheck);
      let status: TaskStatus | 'UNKNOWN' = !a ? 'UNKNOWN' : a.status === 'OK' ? 'DONE' : 'OPEN';
      // ★자동 판정 + 근거 필수인 항목(E1·E2·E3 조직 결재)은 **첨부가 있어야 완료**다.
      //   이전에는 setStatus의 autoCheck 분기가 먼저 throw해 DOC_REQUIRED 검사가 도달 불가였고,
      //   판정 소스(org_gates)는 docNo 문자열만 본다 — 문서번호만 적으면 완료가 됐다.
      //   "문자열만으로는 결재가 실재했는지 소명할 수 없다"는 문서함의 존재 이유가 무력화돼 있었다.
      if (status === 'DONE' && task.evidence === 'DOC_REQUIRED' && attachCount === 0) status = 'OPEN';
      return { status, autoJudged: true, autoStatus: a?.status ?? null,
        detail: (a?.status === 'OK' && task.evidence === 'DOC_REQUIRED' && attachCount === 0)
          ? '결재는 기입됐으나 **근거 문서가 없다** — 원본을 첨부해야 완료로 본다'
          : a?.detail ?? null,
        completedBy: null as string | null, completedDt: null as Date | null, note: rec?.note ?? null, naReason: null as string | null };
    }
    return {
      status: (rec?.status ?? 'OPEN') as TaskStatus, autoJudged: false, autoStatus: null, detail: null,
      completedBy: rec?.completedBy ?? null, completedDt: rec?.completedDt ?? null,
      note: rec?.note ?? null, naReason: rec?.naReason ?? null,
    };
  }

  /**
   * 프로파일에서 **제외된** 항목 — `requires` 미충족으로 생성되지 않은 것들.
   *
   * ★왜 드러내야 하나: 비해당을 '미생성'으로 처리한 것은 손 NA를 막기 위해서였는데,
   *   그 자체가 **차단을 조용히 없애는 경로**가 된다. 실측: capabilities에서 HIS를 빼면
   *   blocking 3건(E3·RUN-3·PS-3)이 사라져 개시 차단이 17→14로 줄어든다.
   *   막지는 않는다(HIS를 정말 안 쓰는 사이트가 있다) — 대신 **항상 보이게** 한다.
   */
  private excludedFor(caps: readonly string[]) {
    return GOLIVE_TASKS.filter((t) => !t.deprecated && t.requires && !t.requires.every((r) => caps.includes(r)))
      .map((t) => ({ code: t.code, title: t.title, blocking: t.blocking, requires: t.requires ?? [] }));
  }

  /** 체크리스트 전체 — 사이트 프로파일에 맞는 항목만. */
  async checklist() {
    const prof = await this.profile();
    const tasks = tasksForCapabilities(prof.capabilities);
    const [records, auto, attachCounts] = await Promise.all([
      this.prisma.goLiveTaskRecord.findMany(),
      this.autoChecks(),
      this.attachments.countsByTask(),
    ]);
    const recBy = new Map(records.map((r) => [r.code, r]));

    const items = tasks.map((t) => {
      const r = this.resolve(t, recBy.get(t.code), auto, attachCounts.get(t.code) ?? 0);
      const blockedBy = (t.dependsOn ?? []).filter((dep) => {
        const depTask = GOLIVE_TASK_BY_CODE.get(dep);
        if (!depTask) return false;
        const depState = this.resolve(depTask, recBy.get(dep), auto, attachCounts.get(dep) ?? 0);
        return depState.status !== 'DONE' && depState.status !== 'NA';
      });
      return { ...t, ...r, blockedBy, attachments: attachCounts.get(t.code) ?? 0 };
    });

    const counted = items.filter((i) => i.status !== 'NA');
    const done = counted.filter((i) => i.status === 'DONE').length;
    const blockingOpen = items.filter((i) => i.blocking && i.status !== 'DONE' && i.status !== 'NA').length;

    const excluded = this.excludedFor(prof.capabilities);
    return {
      registryVersion: GOLIVE_REGISTRY_VERSION,
      site: prof,
      // 제외된 항목을 항상 함께 준다 — 특히 blocking이 제외됐다면 화면이 경고해야 한다.
      excluded,
      excludedBlocking: excluded.filter((e) => e.blocking).length,
      summary: {
        total: counted.length, done, open: counted.length - done, blockingOpen,
        na: items.length - counted.length,
        canApprove: blockingOpen === 0,
      },
      phases: (['PREP', 'CUTOVER', 'POST'] as const).map((phase) => ({
        phase,
        items: items.filter((i) => i.phase === phase),
      })),
      generatedAt: new Date(),
    };
  }

  /** 수동 항목의 상태 변경. 자동 판정 항목은 거부한다. */
  async setStatus(code: string, dto: { status: TaskStatus; note?: string; naReason?: string }, userId: string | null) {
    const task = GOLIVE_TASK_BY_CODE.get(code);
    if (!task) throw new NotFoundException(`알 수 없는 항목: ${code}`);
    if (task.autoCheck) {
      throw new BadRequestException(
        `이 항목은 시스템이 판정합니다(${task.autoCheck}) — 수동으로 완료 처리할 수 없습니다. ` +
          '실제 상태를 바꾸면 자동으로 반영됩니다.',
      );
    }
    if (!['OPEN', 'DONE', 'NA'].includes(dto.status)) throw new BadRequestException('status는 OPEN|DONE|NA');

    // ★선행 미완이면 완료할 수 없다. 레지스트리는 "미완이면 시작할 수 없다"고 선언했는데
    //   구현이 표시만 하고 있었다 — RUN-6(파일럿 정리·비가역)을 P1(백업·복구 리허설) 미완
    //   상태에서 완료로 찍을 수 있었다. 되돌릴 지점 없이 비가역 작업이 완료로 기록된다.
    if (dto.status === 'DONE' && task.dependsOn?.length) {
      const c = await this.checklist();
      const item = c.phases.flatMap((p) => p.items).find((i) => i.code === code);
      if (item && item.blockedBy.length > 0) {
        throw new BadRequestException(
          `선행 항목이 미완입니다: ${item.blockedBy.join(' · ')} — 순서를 건너뛰면 되돌릴 지점 없이 다음 단계로 갑니다`,
        );
      }
    }
    if (dto.status === 'NA' && !dto.naReason?.trim()) {
      throw new BadRequestException('해당없음(NA)은 사유가 필수입니다 — 개시 압박에서 항목을 조용히 지우지 않도록');
    }
    // 근거 필수 항목은 **첨부 없이 완료할 수 없다.** 문서번호 문자열만으로는 결재가 실재했는지
    // 소명할 수 없어서다(§3.3). 원본을 문서함에 올린 뒤 완료 처리한다.
    if (task.evidence === 'DOC_REQUIRED' && dto.status === 'DONE') {
      const counts = await this.attachments.countsByTask();
      if (!(counts.get(code) ?? 0)) {
        throw new BadRequestException(
          `이 항목은 근거 문서가 필수입니다 — 원본(결재 공문·회신서 등)을 먼저 첨부하세요. ` +
            'POST /api/v1/admin/golive/attachments (taskCode=' + code + ')',
        );
      }
    }

    const data = {
      status: dto.status,
      note: dto.note ?? null,
      naReason: dto.status === 'NA' ? (dto.naReason ?? null) : null,
      completedBy: dto.status === 'DONE' ? userId : null,
      completedDt: dto.status === 'DONE' ? new Date() : null,
      owner: task.owner,
    };
    const saved = await this.prisma.goLiveTaskRecord.upsert({ where: { code }, update: data, create: { code, ...data } });
    void this.auditChain.append({
      userId, action: 'PUT', target: `/admin/golive/tasks/${code}`,
      detail: `${task.title} → ${dto.status}${dto.naReason ? ` (사유: ${dto.naReason})` : ''}`.slice(0, 500),
      status: null, sensitive: false,
    });
    return saved;
  }

  /**
   * 준비도 내보내기 — 원격 접속 없이 검수할 수 있게 상태만 담는다.
   * ⚠ **PHI를 포함하지 않는다** — 상태·건수·판정 근거만.
   */
  async exportSnapshot() {
    return this.snapshotOf(await this.checklist());
  }

  /** 체크리스트 → 스냅샷(순수 변환). 승인 경로가 같은 계산을 두 번 하지 않도록 분리했다. */
  private snapshotOf(c: Awaited<ReturnType<GoLiveService['checklist']>>) {
    return {
      exportedAt: new Date(),
      registryVersion: c.registryVersion,
      site: c.site,
      summary: c.summary,
      // 승인 스냅샷이 "무엇을 제외한 채 승인했는가"까지 담아야 나중에 소명이 된다.
      excluded: c.excluded,
      items: c.phases.flatMap((p) =>
        p.items.map((i) => ({
          code: i.code, phase: i.phase, title: i.title, owner: i.owner,
          blocking: i.blocking, status: i.status, autoJudged: i.autoJudged, detail: i.detail,
          // 소명에 필요한 것들 — 이전에는 status만 남아 "무슨 근거로/왜 뺐는지"를 복원할 수 없었다.
          attachments: i.attachments, naReason: i.naReason, evidence: i.evidence,
        })),
      ),
    };
  }

  /**
   * 개시 승인 현황 — **결정등록 판정과 체크리스트를 합쳐서** 준다.
   *
   * 이전에는 `goLiveStatus()`(결정등록만)와 `/admin/golive` 체크리스트가 서로를 몰라
   * **두 화면이 정반대를 말할 수 있었다** — 승인 후 데모 계정이 다시 활성화되면
   * 콘솔은 APPROVED(초록), 체크리스트는 개시 차단 1. 승인이 소명 범위를 벗어난 채 초록으로 남는다.
   */
  async status() {
    const [base, c] = await Promise.all([this.userAdmin.goLiveStatus(), this.checklist()]);
    const openBlockers = c.phases.flatMap((p) => p.items)
      .filter((i) => i.blocking && i.status !== 'DONE' && i.status !== 'NA');

    // ★승인 시점에 **수용(override)한 차단은 새 차단이 아니다** — 결정등록 쪽과 같은 규칙이다.
    //   이걸 구분하지 않으면 정당한 강행 승인이 곧바로 STALE로 뒤집혀 경고가 무의미해진다.
    let acceptedCodes: string[] = [];
    const cur = base.current as { action?: string; checklistSnapshot?: string | null } | null;
    if (cur?.action === 'APPROVED' && cur.checklistSnapshot) {
      try {
        const snap = JSON.parse(cur.checklistSnapshot) as { items?: { code: string; blocking: boolean; status: string }[] };
        acceptedCodes = (snap.items ?? [])
          .filter((i) => i.blocking && i.status !== 'DONE' && i.status !== 'NA')
          .map((i) => i.code);
      } catch { acceptedCodes = []; }
    }
    const newBlockers = openBlockers.filter((i) => !acceptedCodes.includes(i.code));
    const state = base.state === 'APPROVED' && newBlockers.length > 0 ? 'APPROVED_STALE' : base.state;

    return {
      ...base, state,
      checklistBlocking: openBlockers.length,
      checklistNewBlocking: newBlockers.length,
      checklistOpenBlockers: openBlockers.map((i) => ({ code: i.code, title: i.title, owner: i.owner })),
      staleReason: state === 'APPROVED_STALE' && base.state === 'APPROVED'
        ? `승인 후 **새로** 발생한 체크리스트 차단 ${newBlockers.length}건(${newBlockers.map((i) => i.code).join('·')}) — 승인이 소명한 범위를 벗어났다`
        : null,
    };
  }

  /**
   * ⑥ 개시 필수 키 묶음 — `/admin/settings`는 전체 설정 화면이라 개시에 필요한 키가 묻힌다.
   * 여기서는 **개시에 필요한 것만 순서대로** 보여준다. 저장·검증·감사는 설정 화면이 그대로 담당한다
   * (판정 로직을 두 벌 만들지 않는다). 값은 절대 반환하지 않는다 — 설정 여부와 판정만.
   */
  async keys() {
    const auto = await this.autoChecks();
    const pick = (k: string) => auto.get(k) ?? null;
    const wh = pick('critical_webhook');
    return {
      keys: [
        {
          key: 'CRITICAL_WEBHOOK_URL', label: '위험치 통보 채널', blocking: true, fix: '/admin/settings',
          status: wh?.status ?? 'UNKNOWN', detail: wh?.detail ?? null,
          gate: 'https 필수 · 저장 후 **테스트 발송으로 도달 확인**까지 해야 완료. 시드 sink는 완료가 아니다',
        },
        {
          key: 'OPS_WEBHOOK_URL', label: '운영 통보 채널', blocking: false, fix: '/admin/settings',
          status: 'MANUAL', detail: null,
          gate: '미설정 시 연계 이상이 알림함에만 표시된다(무인 시간대 공백)',
        },
        {
          key: 'LIS_BACKUP_OFFSITE', label: '오프사이트 백업 경로', blocking: false, fix: null,
          status: pick('backup_offsite')?.status ?? 'UNKNOWN', detail: pick('backup_offsite')?.detail ?? null,
          gate: '설정만으로 백업이 돌지는 않는다 — cron 등록 + 복원 검증까지 해야 한다',
        },
        {
          key: 'HIS_*', label: 'HIS 운영 자격', blocking: false, fix: '/admin/integration',
          status: pick('his_integration')?.status ?? 'UNKNOWN', detail: pick('his_integration')?.detail ?? null,
          gate: 'A-3 결재 선행. 주입 후 왕복 스모크로 확인한다',
        },
        {
          key: 'PACS_*', label: 'PACS 운영 자격', blocking: false, fix: '/admin/integration',
          status: pick('pacs_integration')?.status ?? 'UNKNOWN', detail: pick('pacs_integration')?.detail ?? null,
          gate: '컷오버 창에 실 자격 적용',
        },
      ],
      note: '값은 이 API로 조회·저장하지 않는다 — /admin/settings에서 입력하고, 여기서는 판정만 본다.',
    };
  }

  /**
   * ④ 최종 승인 — **체크리스트 기준**으로 게이트를 건다.
   *
   * 기존 승인(결정 등록 blocker 기준)은 그대로 두고, 체크리스트 차단을 **추가 조건**으로 얹는다.
   * 두 판정이 보는 대상이 다르기 때문이다: 결정 등록은 조직 결정, 체크리스트는 전환 절차 전반.
   * 승인 시 그 시점 체크리스트 전문을 스냅샷으로 남긴다 — "무엇을 확인하고 승인했는가".
   */
  async approve(dto: { approvedByName?: string; approvedDate?: string; note?: string; override?: boolean; residualRisk?: string }, userId: string | null) {
    const c = await this.checklist();
    if (c.summary.blockingOpen > 0 && !dto.override) {
      const open = c.phases.flatMap((p) => p.items).filter((i) => i.blocking && i.status !== 'DONE' && i.status !== 'NA');
      throw new BadRequestException(
        `체크리스트 차단 ${c.summary.blockingOpen}건 미해소 — 승인 불가(강행하려면 override+잔여위험): ` +
          open.slice(0, 8).map((i) => `${i.code} ${i.title}`).join(' · '),
      );
    }
    if (c.summary.blockingOpen > 0 && dto.override && !dto.residualRisk?.trim()) {
      throw new BadRequestException('차단 잔존 강행 승인(override)은 잔여위험 명시 필수');
    }
    // 스냅샷을 위해 checklist를 다시 계산하지 않는다 — 두 계산 사이에 상태가 바뀌면
    // **게이트를 통과한 스냅샷과 저장되는 스냅샷이 달라진다**(TOCTOU). 방금 것을 그대로 쓴다.
    const snapshot = this.snapshotOf(c);
    // 결정 등록 기준 게이트·APPROVED_STALE 로직은 기존 구현이 정본 — 여기서 다시 만들지 않는다.
    return this.userAdmin.approveGoLive(
      {
        ...dto,
        // 체크리스트 차단을 강행한 것도 **override로 기록**되어야 한다. 이전에는 결정등록
        // blocker만 보고 override를 정했기에, 콘솔이 0이면 강행 승인이 '정상 승인'으로 남았다.
        forceOverride: c.summary.blockingOpen > 0,
        checklistSnapshot: JSON.stringify(snapshot), registryVersion: GOLIVE_REGISTRY_VERSION,
      },
      userId,
    );
  }
}
