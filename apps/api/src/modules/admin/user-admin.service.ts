/**
 * UserAdminService — admin 도메인 서비스.
 *
 * 주요 진입점: `matrix()`, `roles()`, `listUsers()`, `createUser()`, `setRoles()`, `setStatus()`, `listProviders()`, `setProvider()`…
 * 일부 경로는 트랜잭션으로 묶인다 — 부분 반영 시 임상 상태가 깨지는 구간.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { describeMatrix, LisRole } from '../../common/rbac/roles';
import { validatePasswordStrength } from '../../domain/password-policy';
import { reviewFlags, isStale, addDaysIso, DEFAULT_REVIEW_INTERVAL_DAYS, isTransitionableGateStatus, GATE_TRANSITION_STATUSES } from '../../domain/signoff-review';
import { DECISION_ITEMS, DECISION_AXIS, isDecisionStatus } from '../../domain/decision-registry';
import { getEapprovalStatus, mapHisApprovalStatus } from '../../integration/his-integration-client';
import { genId } from '../../common/id.util';

const VALID_ROLES = Object.values(LisRole) as string[];

/**
 * 사용자·역할 관리 서비스 — 계정 생성·역할 배정·상태·비번 재설정.
 * 권한 매트릭스는 코드(roles.ts) 기준으로 조회 제공. (사용자 요청: 권한 관리 기능)
 */
@Injectable()
export class UserAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: SettingsService,
  ) {}

  /** 역할·기능 권한 매트릭스(읽기 전용). */
  matrix() {
    return describeMatrix();
  }

  /** 역할 목록. */
  roles() {
    return this.prisma.role.findMany({ orderBy: { roleCode: 'asc' } });
  }

  /** 사용자 목록(역할·상태·잠금 포함). */
  async listUsers() {
    const users = await this.prisma.appUser.findMany({
      include: { roles: true },
      orderBy: { userId: 'asc' },
    });
    return users.map((u) => ({
      userId: u.userId,
      name: u.name,
      dept: u.dept,
      status: u.status,
      locked: !!u.lockedUntil && u.lockedUntil.getTime() > Date.now(),
      failedAttempts: u.failedAttempts,
      pwdUpdatedDt: u.pwdUpdatedDt,
      mustChangePassword: u.mustChangePassword,
      providerId: u.providerId, // 임상 서명 주체(병리 사인아웃) — 미연결이면 서명 불가

      roles: u.roles.map((r) => r.roleCode),
    }));
  }

  private assertRoles(roles: string[]) {
    const bad = roles.filter((r) => !VALID_ROLES.includes(r));
    if (bad.length) throw new BadRequestException(`잘못된 역할: ${bad.join(', ')}`);
  }

  /**
   * 최후의 활성 관리자(ADM) 보호 — ADM 권한 회수·계정 비활성화로 관리 불능(전 병원 잠금)을 막는다.
   * 역할·상태는 매 요청 DB에서 재판정(jwt.strategy)되므로 마지막 ADM을 내리면 즉시·영구 잠금이고 인앱 복구 불가.
   */
  private async assertNotLastActiveAdmin(userId: string, action: string) {
    const targetIsAdmin = await this.prisma.userRole.findFirst({ where: { userId, roleCode: 'ADM' } });
    if (!targetIsAdmin) return; // 대상이 ADM이 아니면 무관
    const otherActiveAdmins = await this.prisma.appUser.count({
      where: { userId: { not: userId }, status: 'ACTIVE', roles: { some: { roleCode: 'ADM' } } },
    });
    if (otherActiveAdmins === 0) throw new BadRequestException(`마지막 활성 관리자입니다 — ${action} 불가(다른 관리자 계정을 먼저 활성화/권한부여하세요)`);
  }

  /** 사용자 생성(초기 비번·역할). */
  async createUser(dto: { userId: string; name: string; dept?: string; password: string; roles: string[]; providerId?: string }) {
    const dup = await this.prisma.appUser.findUnique({ where: { userId: dto.userId } });
    if (dup) throw new BadRequestException(`이미 존재하는 사용자: ${dto.userId}`);
    const violation = validatePasswordStrength(dto.password);
    if (violation) throw new BadRequestException(violation);
    this.assertRoles(dto.roles);
    await this.prisma.appUser.create({
      data: {
        userId: dto.userId,
        name: dto.name,
        dept: dto.dept ?? null,
        passwordHash: await bcrypt.hash(dto.password, 10),
        pwdUpdatedDt: new Date(),
        // 관리자가 정한 초기 비밀번호는 본인이 바꾸기 전까지 다른 기능을 쓸 수 없다.
        // (관리자가 아는 비번으로 사용자가 계속 활동하면 행위 귀속·부인방지가 성립하지 않음)
        mustChangePassword: true,
        providerId: dto.providerId ?? null,
        roles: { create: dto.roles.map((roleCode) => ({ roleCode })) },
      },
    });
    return { userId: dto.userId, created: true };
  }

  /** 역할 재배정(전체 교체). */
  async setRoles(userId: string, roles: string[]) {
    const user = await this.prisma.appUser.findUnique({ where: { userId } });
    if (!user) throw new NotFoundException(`사용자 없음: ${userId}`);
    this.assertRoles(roles);
    if (!roles.includes('ADM')) await this.assertNotLastActiveAdmin(userId, 'ADM 권한 회수');
    await this.prisma.$transaction([
      this.prisma.userRole.deleteMany({ where: { userId } }),
      this.prisma.userRole.createMany({ data: roles.map((roleCode) => ({ userId, roleCode })), skipDuplicates: true }),
    ]);
    // 인력변경 트리거: 역할 전체 회수(무권한) 시 이 사람이 결재한 게이트를 재검토 필요로 플래그
    if (roles.length === 0) await this.flagStaleByApprover(userId, '결재자 역할 전체 회수');
    return { userId, roles };
  }

  /** 계정 상태 변경(활성/비활성) + 잠금 해제. */
  async setStatus(userId: string, status: 'ACTIVE' | 'INACTIVE') {
    const user = await this.prisma.appUser.findUnique({ where: { userId } });
    if (!user) throw new NotFoundException(`사용자 없음: ${userId}`);
    if (status === 'INACTIVE') await this.assertNotLastActiveAdmin(userId, '계정 비활성화');
    const updated = await this.prisma.appUser.update({
      where: { userId },
      data: { status, failedAttempts: 0, lockedUntil: null },
    });
    // 인력변경 트리거: 계정 비활성화 시 이 사람이 결재한 게이트를 재검토 필요로 플래그
    if (status === 'INACTIVE') await this.flagStaleByApprover(userId, '결재자 계정 비활성화');
    const { passwordHash: _omit, ...safe } = updated; // 응답에 비밀번호 해시를 싣지 않는다
    return safe;
  }

  /** 특정 결재자(계정)가 승인한 게이트를 재검토 필요로 플래그 + 이력 기록(인력변경 트리거). */
  private async flagStaleByApprover(userId: string, reason: string) {
    const affected = await this.prisma.orgApproval.findMany({ where: { approverUserId: userId, status: 'APPROVED', needsReview: false } });
    for (const g of affected) {
      await this.prisma.orgApproval.update({ where: { gateCode: g.gateCode }, data: { needsReview: true, reviewReason: reason } });
      await this.prisma.orgApprovalHistory.create({ data: { gateCode: g.gateCode, action: 'FLAGGED_STALE', actor: 'SYSTEM(인력변경)', reason } });
    }
    return affected.length;
  }

  /** 관리자 비밀번호 재설정(정책 검증). */
  /** 의사 마스터 목록(계정 연결 선택용). */
  async listProviders() {
    return this.prisma.provider.findMany({
      select: { providerId: true, name: true, dept: true, roleType: true },
      orderBy: { providerId: 'asc' },
    });
  }

  /**
   * 계정↔판독의(Provider) 연결. 병리 사인아웃의 서명자는 이 연결로 서버가 유도한다.
   * 존재하지 않는 Provider면 거부(FK 위반을 500이 아니라 명확한 400으로).
   */
  async setProvider(userId: string, providerId: string | null) {
    const user = await this.prisma.appUser.findUnique({ where: { userId } });
    if (!user) throw new NotFoundException(`사용자 없음: ${userId}`);
    if (providerId) {
      const p = await this.prisma.provider.findUnique({ where: { providerId } });
      if (!p) throw new BadRequestException(`판독의(Provider) 없음: ${providerId}`);
      const dup = await this.prisma.appUser.findFirst({ where: { providerId, NOT: { userId } } });
      if (dup) throw new BadRequestException(`이미 다른 계정(${dup.userId})에 연결된 판독의입니다`);
    }
    await this.prisma.appUser.update({ where: { userId }, data: { providerId } });
    return { userId, providerId };
  }

  /**
   * 계정 잠금 해제 — 연속 로그인 실패로 걸린 잠금만 푼다.
   * ★상태(ACTIVE/INACTIVE)는 건드리지 않는다. 예전엔 화면에서 '비활성·잠금해제' 한 버튼이
   *   상태만 토글해, 잠긴 검사자를 풀어주려던 관리자가 계정을 아예 차단시켰다.
   */
  async unlockAccount(userId: string) {
    const user = await this.prisma.appUser.findUnique({ where: { userId } });
    if (!user) throw new NotFoundException(`사용자 없음: ${userId}`);
    await this.prisma.appUser.update({ where: { userId }, data: { failedAttempts: 0, lockedUntil: null } });
    return { userId, unlocked: true };
  }

  async resetPassword(userId: string, newPassword: string) {
    const user = await this.prisma.appUser.findUnique({ where: { userId } });
    if (!user) throw new NotFoundException(`사용자 없음: ${userId}`);
    const violation = validatePasswordStrength(newPassword);
    if (violation) throw new BadRequestException(violation);
    await this.prisma.appUser.update({
      where: { userId },
      // 재설정 비밀번호도 임시 — 본인이 변경해야 정상 사용 가능(관리자 사칭 방지).
      data: { passwordHash: await bcrypt.hash(newPassword, 10), pwdUpdatedDt: new Date(), failedAttempts: 0, lockedUntil: null, mustChangePassword: true },
    });
    return { userId, reset: true };
  }

  private todayIso() { return new Date().toISOString().slice(0, 10); }

  /** 게이트에 재검토 플래그(인력변경 저장분 + 정기 만료 계산분) 병합. */
  private withReview<T extends { status: string; needsReview?: boolean; reviewReason?: string | null; nextReviewDate?: string | null }>(g: T) {
    const flags = reviewFlags(g, this.todayIso());
    return { ...g, reviewFlags: flags, reviewStatus: flags.length ? 'STALE' : 'OK' };
  }

  /** 조직 게이트(A-1/A-2/A-3/PACS) 결재 현황 + 재검토 상태(인력변경·정기 만료). 개시 준비도 추적. */
  async listGates() {
    const gates = await this.prisma.orgApproval.findMany({ orderBy: { gateCode: 'asc' } });
    return gates.map((g) => this.withReview(g));
  }

  /**
   * 개시 준비도(Go-Live Readiness) — "사람 몫" 잔여 항목을 라이브 근거로 점검·집계.
   * 수동 SQL/curl 대신 한 화면에서 무엇이 GREEN/대기인지 보고, 해결 화면으로 연결한다.
   * BLOCK=개시 차단 · WARN=개시 전/개시일 필요 · OK=완료.
   */
  async readiness() {
    const DEMO = ['U00', 'U01', 'U02', 'U03', 'U04', 'U05', 'U06', 'U07', 'U08'];
    const [gates, roleUsers, demoActive, rrCodes, qcCodes, mapCount, catActive] = await Promise.all([
      this.prisma.orgApproval.findMany({ where: { gateCode: { in: ['A-1', 'A-2', 'A-3'] } } }),
      this.prisma.userRole.findMany({ where: { roleCode: { in: ['PHY', 'PAT'] } }, select: { userId: true } }),
      this.prisma.appUser.count({ where: { userId: { in: DEMO }, status: 'ACTIVE' } }),
      this.prisma.referenceRange.findMany({ select: { testCode: true }, distinct: ['testCode'] }),
      this.prisma.qcTarget.findMany({ select: { testCode: true }, distinct: ['testCode'] }),
      this.prisma.codeMapping.count(),
      this.prisma.catalogVersion.count({ where: { status: 'ACTIVE' } }),
    ]);
    const roleUserIds = [...new Set(roleUsers.map((r) => r.userId))];
    const unlinked = roleUserIds.length
      ? await this.prisma.appUser.count({ where: { userId: { in: roleUserIds }, providerId: null, status: 'ACTIVE' } })
      : 0;
    // 데모/실 판정: 서버가 결속한 기입자(recordedBy)가 정본. 없으면(레거시) approver 이름 heuristic 폴백.
    //   → 데모계정이 결재자명에 실명을 적어도 false-green(개시차단 해제) 불가.
    const isDemoApproval = (g: { recordedBy?: string | null; approver?: string | null }) =>
      g.recordedBy ? DEMO.includes(g.recordedBy) : DEMO.includes(g.approver ?? '');
    const realApproved = gates.filter((g) => g.status === 'APPROVED' && !isDemoApproval(g)).length;
    const placeholder = gates.filter((g) => g.status === 'APPROVED' && isDemoApproval(g)).length;
    const webhook = this.settings.get('CRITICAL_WEBHOOK_URL') || process.env.CRITICAL_WEBHOOK_URL || '';
    const webhookSeed = /_seed\//.test(webhook); // 파일럿 시드 sink URL 여부(실전달 X)
    const offsite = process.env.LIS_BACKUP_OFFSITE || '';
    const erp = process.env.ERP_BILLING_URL || '';

    const checks = [
      { key: 'critical_webhook', category: '구성', label: '위험치 알림 채널', owner: '병원 IT/진료지원', fix: '/admin/settings',
        status: webhook ? (webhookSeed ? 'SEED' : (/^https/i.test(webhook) ? 'OK' : 'WARN')) : 'BLOCK',
        detail: webhook ? (webhookSeed ? '시드값(파일럿 sink) — 개시 시 실 URL로 교체' : (/^https/i.test(webhook) ? '설정됨(https)' : '설정됨 · ⚠ http(https 권장)')) : '미설정 — 부서 URL 대기' },
      { key: 'org_gates', category: '조직', label: '조직 결재 A-1/A-2/A-3', owner: '진료부·검사의학·보안팀', fix: '/admin/gates',
        status: realApproved === 3 ? 'OK' : 'BLOCK',
        detail: `실결재 ${realApproved}/3${placeholder ? ` · DEV 플레이스홀더 ${placeholder}건(실결재 교체 필요)` : ''}` },
      { key: 'provider_link', category: '개시일', label: '판독의 Provider 연결', owner: '운영자', fix: '/admin/users',
        status: unlinked > 0 ? 'WARN' : 'OK',
        detail: unlinked > 0 ? `PHY/PAT 계정 ${unlinked}건 미연결 — 미연결이면 병리 사인아웃 403` : '전 판독의 연결됨' },
      { key: 'demo_accounts', category: '개시일', label: '데모 계정 비활성', owner: '운영자', fix: '/admin/users',
        status: demoActive > 0 ? 'WARN' : 'OK',
        detail: demoActive > 0 ? `데모 계정 ${demoActive}개 활성 — 개시일 비활성/삭제` : '데모 계정 없음' },
      { key: 'backup_offsite', category: '구성', label: '오프사이트 백업 경로', owner: '운영자', fix: null,
        status: offsite ? 'OK' : 'WARN', detail: offsite ? '설정됨' : 'LIS_BACKUP_OFFSITE 미설정(로컬 보관만)' },
      { key: 'master_signoff', category: '데이터', label: '마스터 실값 서명(대표값)', owner: '검사실', fix: '/admin/signoff',
        status: 'WARN',
        detail: `참고치 ${rrCodes.length}종 · QC ${qcCodes.length}종 · 코드매핑 ${mapCount}건 — 전부 대표값(검사실 서명 시 실값 교체)` },
      { key: 'catalogs', category: '데이터', label: '코드셋 카탈로그 활성본', owner: '검사실', fix: '/admin/catalogs',
        status: catActive > 0 ? 'OK' : 'WARN', detail: `활성 ${catActive}종 (미활성은 코드 스타터셋 동작)` },
      { key: 'erp_billing', category: '구성', label: 'ERP 청구 연동', owner: '원무·운영자', fix: '/billing',
        status: erp ? 'OK' : 'WARN', detail: erp ? '개통(URL·시크릿 주입)' : '미구성 — PENDING 스테이징' },
    ];
    const summary = {
      block: checks.filter((c) => c.status === 'BLOCK').length,
      warn: checks.filter((c) => c.status === 'WARN').length,
      seed: checks.filter((c) => c.status === 'SEED').length,
      ok: checks.filter((c) => c.status === 'OK').length,
    };
    return { summary, checks, generatedAt: new Date().toISOString() };
  }

  /**
   * 운영 관리 콘솔(P1) — "정의해야 하는" 관리 항목을 4대 축(기준정보·거버넌스·운영·연동)의
   * 단일 레지스트리로 집계. 개시 준비도(readiness)를 정의 항목 전체로 일반화한 상위 뷰.
   * 각 항목: axis·label·owner·status(OK/WARN/SEED/BLOCK)·detail·fixHref·blocking(개시차단).
   */
  async managementConsole() {
    const DEMO = ['U00', 'U01', 'U02', 'U03', 'U04', 'U05', 'U06', 'U07', 'U08'];
    const [gates, roleUsers, demoActive, rrCodes, qcCodes, mapCount, catActive, terms, barcodes, reflexActive, reflexTotal, signoffSections] = await Promise.all([
      this.prisma.orgApproval.findMany({ where: { gateCode: { in: ['A-1', 'A-2', 'A-3'] } } }),
      this.prisma.userRole.findMany({ where: { roleCode: { in: ['PHY', 'PAT'] } }, select: { userId: true } }),
      this.prisma.appUser.count({ where: { userId: { in: DEMO }, status: 'ACTIVE' } }),
      this.prisma.referenceRange.findMany({ select: { testCode: true }, distinct: ['testCode'] }),
      this.prisma.qcTarget.findMany({ select: { testCode: true }, distinct: ['testCode'] }),
      this.prisma.codeMapping.count(),
      this.prisma.catalogVersion.count({ where: { status: 'ACTIVE' } }),
      this.prisma.terminologyCode.count(),
      this.prisma.barcodeConfig.count(),
      this.prisma.reflexProtocol.count({ where: { status: 'ACTIVE' } }),
      this.prisma.reflexProtocol.count(),
      this.prisma.signoffRecord.findMany({ select: { section: true }, distinct: ['section'] }),
    ]);
    const roleUserIds = [...new Set(roleUsers.map((r) => r.userId))];
    const unlinked = roleUserIds.length ? await this.prisma.appUser.count({ where: { userId: { in: roleUserIds }, providerId: null, status: 'ACTIVE' } }) : 0;
    // 데모/실 판정 정본 = 서버 결속 기입자(recordedBy). 레거시는 approver 이름 폴백(readiness와 동일 규칙).
    const isDemoApproval = (g: { recordedBy?: string | null; approver?: string | null }) =>
      g.recordedBy ? DEMO.includes(g.recordedBy) : DEMO.includes(g.approver ?? '');
    const realApproved = gates.filter((g) => g.status === 'APPROVED' && !isDemoApproval(g)).length;
    const placeholder = gates.filter((g) => g.status === 'APPROVED' && isDemoApproval(g)).length;
    const gatesReview = gates.some((g) => isStale(g, this.todayIso()));
    const webhook = this.settings.get('CRITICAL_WEBHOOK_URL') || process.env.CRITICAL_WEBHOOK_URL || '';
    const webhookSeed = /_seed\//.test(webhook);
    const purge = this.settings.getBool('LIFECYCLE_PURGE');
    const offsite = process.env.LIS_BACKUP_OFFSITE || '';
    const erp = process.env.ERP_BILLING_URL || '';
    const hisFhir = !!(process.env.HIS_FHIR_BASE && process.env.HIS_CLIENT_ID && process.env.HIS_CLIENT_SECRET);
    const pacs = !!(process.env.PACS_MLLP_HOST && process.env.PACS_MLLP_PORT) || !!process.env.PACS_BASE;

    // P2: 표준 lifecycle 단계 — UNDEFINED→SEEDED→CONFIGURED→SIGNED→LIVE (+REVIEW 재검토)
    type Stage = 'UNDEFINED' | 'SEEDED' | 'CONFIGURED' | 'SIGNED' | 'LIVE' | 'REVIEW';
    type Item = { key: string; label: string; owner: string; fix: string | null; blocking: boolean; status: 'OK' | 'WARN' | 'SEED' | 'BLOCK'; stage: Stage; next: string | null; review: boolean; detail: string };
    // ★서명 완료도는 섹션별로 판정 — 아무 섹션 1개만 서명해도 완료로 뜨던 것 수정(과대보고).
    //   마스터값=A(참고치)·B(델타)·C(EDI)·D(QC), 워크시트=A~G 전체. 미서명 섹션을 detail에 노출.
    const signedSecs = new Set(signoffSections.map((s) => s.section));
    const MASTER_SECS = ['A', 'B', 'C', 'D'];
    const ALL_SECS = ['A', 'B', 'C', 'D', 'E', 'F', 'G'];
    const masterSigned = MASTER_SECS.every((s) => signedSecs.has(s));
    const allSigned = ALL_SECS.every((s) => signedSecs.has(s));
    const missMaster = MASTER_SECS.filter((s) => !signedSecs.has(s));
    const missAll = ALL_SECS.filter((s) => !signedSecs.has(s));
    const axes: { axis: string; label: string; items: Item[] }[] = [
      { axis: '1', label: '기준정보 정의', items: [
        { key: 'master_signoff', label: '검사 마스터·참고치(실값 서명)', owner: '검사실', fix: '/admin/gates', blocking: false, status: masterSigned ? 'OK' : 'WARN', stage: masterSigned ? 'SIGNED' : 'SEEDED', next: masterSigned ? null : `검사실 실값 서명(미서명 ${missMaster.join('·')})`, review: false, detail: masterSigned ? `참고치 ${rrCodes.length}종·QC ${qcCodes.length}종·EDI매핑 ${mapCount}건 — A~D 서명 완료(실값 반영)` : `참고치 ${rrCodes.length}종·QC ${qcCodes.length}종·EDI매핑 ${mapCount}건 — 대표값(미서명 섹션 ${missMaster.join('·')})` },
        { key: 'catalogs', label: '코드셋 카탈로그', owner: '검사실', fix: '/admin/catalogs', blocking: false, status: catActive > 0 ? 'OK' : 'WARN', stage: catActive > 0 ? 'LIVE' : 'SEEDED', next: catActive > 0 ? null : '공식 코드북 반입·활성화', review: false, detail: `활성 ${catActive}종 (미활성은 코드 스타터셋)` },
        { key: 'terminology', label: '용어·SNOMED', owner: '검사실', fix: '/admin/terminology', blocking: false, status: terms > 0 ? 'OK' : 'WARN', stage: terms > 0 ? 'LIVE' : 'SEEDED', next: terms > 0 ? null : 'KHIS 정식 코드셋 반영', review: false, detail: terms > 0 ? `${terms}개 코드` : '스타터셋(KHIS 라이선스 후 정식)' },
        { key: 'barcode', label: '바코드 규칙', owner: '운영자', fix: '/admin/barcode', blocking: false, status: barcodes > 0 ? 'OK' : 'WARN', stage: barcodes > 0 ? 'LIVE' : 'UNDEFINED', next: barcodes > 0 ? null : '바코드 규칙 정의', review: false, detail: `${barcodes}개 규칙` },
      ] },
      { axis: '2', label: '거버넌스·승인', items: [
        { key: 'org_gates', label: '조직 결재 A-1/A-2/A-3', owner: '진료부·검사의학·보안팀', fix: '/admin/gates', blocking: true, status: realApproved === 3 ? 'OK' : 'BLOCK', stage: gatesReview ? 'REVIEW' : realApproved === 3 ? 'LIVE' : placeholder > 0 ? 'SEEDED' : 'UNDEFINED', next: realApproved === 3 ? null : '실결재 문서번호 기입', review: gatesReview, detail: `실결재 ${realApproved}/3${placeholder ? ` · DEV 플레이스홀더 ${placeholder}건` : ''}` },
        { key: 'lab_signoff', label: '검사실 실값 서명(워크시트)', owner: '검사실', fix: '/admin/gates', blocking: false, status: allSigned ? 'OK' : 'WARN', stage: allSigned ? 'SIGNED' : 'SEEDED', next: allSigned ? null : `서명 워크시트 확정(미서명 ${missAll.join('·')})`, review: false, detail: `서명 ${signedSecs.size}/7 섹션${missAll.length ? ` · 미서명 ${missAll.join('·')}` : ' — 전량 완료'}` },
        { key: 'reflex_protocols', label: '반사검사 프로토콜 승인', owner: '검사의학과', fix: '/admin/reflex', blocking: false, status: reflexActive > 0 ? 'OK' : 'WARN', stage: reflexActive > 0 ? 'LIVE' : reflexTotal > 0 ? 'CONFIGURED' : 'UNDEFINED', next: reflexActive > 0 ? null : '위원회 승인·활성화', review: false, detail: `활성 ${reflexActive}/${reflexTotal}` },
      ] },
      { axis: '3', label: '운영 설정·계정', items: [
        { key: 'critical_webhook', label: '위험치 알림 채널', owner: '병원 IT/진료지원', fix: '/admin/settings', blocking: true, status: webhook ? (webhookSeed ? 'SEED' : (/^https/i.test(webhook) ? 'OK' : 'WARN')) : 'BLOCK', stage: webhook ? (webhookSeed ? 'SEEDED' : /^https/i.test(webhook) ? 'LIVE' : 'CONFIGURED') : 'UNDEFINED', next: webhook && !webhookSeed && /^https/i.test(webhook) ? null : '실 채널 URL·테스트발송', review: false, detail: webhook ? (webhookSeed ? '시드값(파일럿 sink) — 개시 시 실 URL 교체' : /^https/i.test(webhook) ? '설정됨(https)' : '설정됨 · ⚠ http') : '미설정 — 부서 URL 대기' },
        { key: 'retention', label: '보존기간 자동정리', owner: '법무·운영자', fix: '/admin/lifecycle', blocking: false, status: purge ? 'OK' : 'WARN', stage: purge ? 'LIVE' : 'CONFIGURED', next: purge ? null : '법무 확정 후 자동정리 on', review: false, detail: purge ? '자동정리 실행' : '미실행(법무 확정 전 정상)' },
        { key: 'provider_link', label: '판독의 Provider 연결', owner: '운영자', fix: '/admin/users', blocking: false, status: unlinked > 0 ? 'WARN' : 'OK', stage: unlinked > 0 ? 'CONFIGURED' : 'LIVE', next: unlinked > 0 ? '실 판독의 계정 Provider 연결' : null, review: false, detail: unlinked > 0 ? `PHY/PAT ${unlinked}건 미연결(병리 사인아웃 403)` : '전 판독의 연결됨' },
        { key: 'demo_accounts', label: '데모 계정 비활성', owner: '운영자', fix: '/admin/users', blocking: false, status: demoActive > 0 ? 'WARN' : 'OK', stage: demoActive > 0 ? 'CONFIGURED' : 'LIVE', next: demoActive > 0 ? '개시일 데모계정 비활성' : null, review: false, detail: demoActive > 0 ? `데모 ${demoActive}개 활성 — 개시일 비활성` : '데모 계정 없음' },
        { key: 'backup_offsite', label: '오프사이트 백업', owner: '운영자', fix: null, blocking: false, status: offsite ? 'OK' : 'WARN', stage: offsite ? 'LIVE' : 'UNDEFINED', next: offsite ? null : 'LIS_BACKUP_OFFSITE 경로 설정', review: false, detail: offsite ? '설정됨' : 'LIS_BACKUP_OFFSITE 미설정(로컬 보관만)' },
      ] },
      { axis: '4', label: '연동·정산', items: [
        { key: 'his_integration', label: 'HIS 연동', owner: '운영자', fix: '/admin/integration', blocking: false, status: hisFhir ? 'OK' : 'WARN', stage: hisFhir ? 'LIVE' : 'UNDEFINED', next: hisFhir ? null : '자격증명 주입', review: false, detail: hisFhir ? '자격증명 구성됨' : '미구성(자격증명 대기)' },
        { key: 'pacs_integration', label: 'PACS 연동', owner: '운영자', fix: '/admin/integration', blocking: false, status: pacs ? 'OK' : 'WARN', stage: pacs ? 'LIVE' : 'UNDEFINED', next: pacs ? null : 'PACS 자격 주입', review: false, detail: pacs ? '구성됨' : '미구성' },
        { key: 'erp_billing', label: 'ERP 청구 연동', owner: '원무·운영자', fix: '/billing', blocking: false, status: erp ? 'OK' : 'WARN', stage: erp ? 'LIVE' : 'UNDEFINED', next: erp ? null : '실 URL·시크릿 주입', review: false, detail: erp ? '개통(URL·시크릿 주입)' : '미구성 — PENDING 스테이징' },
      ] },
    ];
    // ⑤ 조직·외부 결정 — 시스템 상태로 추론 불가한 사람/조직 결정(DecisionRecord 캡처). 미결정 blocking은 개시차단 계수.
    const decisions = await this.listDecisions();
    axes.push({ axis: DECISION_AXIS, label: '조직·외부 결정', items: decisions.map((d): Item => {
      const st: { s: Item['status']; stage: Stage; next: string | null } = d.status === 'DECIDED'
        ? { s: 'OK', stage: 'LIVE', next: null }
        : d.status === 'HOLD'
          ? { s: 'WARN', stage: 'REVIEW', next: '보류 해제·결정' }
          : d.status === 'IN_PROGRESS'
            ? { s: 'WARN', stage: 'CONFIGURED', next: '결정 진행 중' }
            : { s: d.blocking ? 'BLOCK' : 'WARN', stage: 'UNDEFINED', next: '결정·근거 기입' };
      return {
        key: d.key, label: d.label, owner: d.owner, fix: '/admin/console?view=decisions', blocking: d.blocking,
        status: st.s, stage: st.stage, next: st.next, review: false,
        detail: d.status === 'DECIDED'
          ? `결정: ${d.decidedValue ?? ''}${d.decidedByName ? ` · ${d.decidedByName}` : ''}${d.documentRef ? ` (${d.documentRef})` : ''}`.slice(0, 200)
          : d.hint,
      };
    }) });
    const all = axes.flatMap((a) => a.items);
    const count = (st: string) => all.filter((i) => i.status === st).length;
    const STAGES: Stage[] = ['UNDEFINED', 'SEEDED', 'CONFIGURED', 'SIGNED', 'LIVE', 'REVIEW'];
    const pipeline = STAGES.map((stage) => ({ stage, items: all.filter((i) => i.stage === stage).map((i) => ({ key: i.key, label: i.label, status: i.status, axis: axes.find((a) => a.items.includes(i))!.axis })) }));
    return {
      summary: { block: count('BLOCK'), warn: count('WARN'), seed: count('SEED'), ok: count('OK'), total: all.length, blockingOpen: all.filter((i) => i.blocking && i.status !== 'OK').length, review: all.filter((i) => i.review).length },
      axes: axes.map((a) => ({ ...a, progress: { ok: a.items.filter((i) => i.status === 'OK').length, total: a.items.length } })),
      pipeline,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * 운영 관리 통합 이력(P3) — 결재·서명·코드셋 반입·설정 변경·반사검사 프로토콜 이벤트를
   * 한 타임라인으로 집계(관리 항목별 추적성). 각기 저장되던 이력을 콘솔에서 한곳에 본다.
   */
  async managementActivity(limit = 60) {
    const [gateHist, signoffs, catalogs, settings, reflexEvents] = await Promise.all([
      this.prisma.orgApprovalHistory.findMany({ orderBy: { createdDt: 'desc' }, take: limit }),
      this.prisma.signoffRecord.findMany({ orderBy: { signedDt: 'desc' }, take: limit, select: { section: true, signerName: true, signedBy: true, documentNo: true, signedDt: true } }),
      this.prisma.catalogVersion.findMany({ orderBy: { importedDt: 'desc' }, take: limit }),
      this.prisma.systemSetting.findMany({ orderBy: { updatedDt: 'desc' }, take: limit }),
      this.prisma.reflexProtocolEvent.findMany({ orderBy: { createdDt: 'desc' }, take: limit }),
    ]);
    type Ev = { at: string; category: string; actor: string | null; summary: string; itemKey: string };
    // 값 미노출 대상: 명시적 시크릿 키 + URL류(웹훅 URL은 경로에 토큰이 박혀 크리덴셜과 같다)
    const secret = /secret|key|token|password|webhook|_url$|url$/i;
    const events: Ev[] = [
      ...gateHist.map((h) => ({ at: h.createdDt.toISOString(), category: '조직결재', actor: h.actor, itemKey: 'org_gates',
        summary: `${h.gateCode} ${h.action === 'APPROVED' ? '결재' : h.action === 'RE_APPROVED' ? '재결재' : h.action === 'FLAGGED_STALE' ? '재검토 플래그' : h.action}${h.docNo ? ` (문서 ${h.docNo})` : ''}` })),
      ...signoffs.map((s) => ({ at: s.signedDt.toISOString(), category: '검사실서명', actor: s.signedBy, itemKey: 'lab_signoff',
        summary: `섹션 ${s.section} 서명 — ${s.signerName}${s.documentNo ? ` (문서 ${s.documentNo})` : ''}` })),
      ...catalogs.flatMap((c) => {
        const evs: Ev[] = [{ at: c.importedDt.toISOString(), category: '코드셋반입', actor: c.importedBy, itemKey: 'catalogs', summary: `${c.catalogId} ${c.version} 반입(${c.itemCount}행)` }];
        if (c.activatedDt) evs.push({ at: c.activatedDt.toISOString(), category: '코드셋반입', actor: c.activatedBy, itemKey: 'catalogs', summary: `${c.catalogId} ${c.version} 활성화` });
        return evs;
      }),
      ...settings.map((st) => ({ at: st.updatedDt.toISOString(), category: '설정변경', actor: st.updatedBy,
        // 설정 키를 해당 관리 항목으로 매핑(추적성) — 미상은 generic 'settings'
        itemKey: /CRITICAL_WEBHOOK/i.test(st.key) ? 'critical_webhook' : /LIFECYCLE_PURGE|RETENTION/i.test(st.key) ? 'retention' : 'settings',
        // 시크릿류는 값 미노출(키·설정여부만)
        summary: `${st.key} ${secret.test(st.key) ? (st.value ? '설정됨' : '해제') : (st.value ? `= ${st.value.slice(0, 60)}` : '해제')}` })),
      ...reflexEvents.map((e) => ({ at: e.createdDt.toISOString(), category: '반사검사', actor: e.actor, itemKey: 'reflex_protocols',
        summary: `${e.protocolId} ${e.event}${e.note ? ` — ${e.note.slice(0, 40)}` : ''}` })),
    ];
    events.sort((a, b) => (a.at < b.at ? 1 : -1));
    return { total: events.length, events: events.slice(0, limit), generatedAt: new Date().toISOString() };
  }

  /**
   * 개시 조직/외부 결정 목록 — 레지스트리(DECISION_ITEMS) × 기록(DecisionRecord) 병합.
   * 시스템 상태로 추론 불가한 사람·조직 결정(인프라·PACS·법무값·외부의존)을 결정값·주체·근거와 함께 본다.
   */
  async listDecisions() {
    const records = await this.prisma.decisionRecord.findMany();
    const byKey = new Map(records.map((r) => [r.key, r]));
    return DECISION_ITEMS.map((it) => {
      const r = byKey.get(it.key);
      return {
        key: it.key, axis: it.axis, label: it.label, owner: it.owner, blocking: it.blocking, hint: it.hint,
        status: r?.status ?? 'PENDING',
        decidedValue: r?.decidedValue ?? null, decidedByName: r?.decidedByName ?? null,
        decidedBy: r?.decidedBy ?? null, decidedDate: r?.decidedDate ?? null,
        documentRef: r?.documentRef ?? null, note: r?.note ?? null, updatedDt: r?.updatedDt ?? null,
      };
    });
  }

  /**
   * 결정 기입/갱신 — DECIDED 시 결정값·주체·일자·근거 필수 권장. recordedBy(LIS 기입 인증계정)는 서버가 결속.
   * decidedByName은 실제 결정 주체(외부 인물·부서). 결정이 관리 항목이 되도록 콘솔이 이 값을 집계.
   */
  async recordDecision(
    key: string,
    dto: { status?: string; decidedValue?: string; decidedByName?: string; decidedDate?: string; documentRef?: string; note?: string },
    recordedBy: string | null,
  ) {
    const item = DECISION_ITEMS.find((i) => i.key === key);
    if (!item) throw new NotFoundException(`결정 항목 없음: ${key}`);
    if (dto.status && !isDecisionStatus(dto.status)) throw new BadRequestException(`status 오류(PENDING/IN_PROGRESS/DECIDED/HOLD): ${dto.status}`);
    const status = dto.status ?? 'DECIDED';
    if (status === 'DECIDED' && !dto.decidedValue?.trim()) throw new BadRequestException('결정완료(DECIDED)는 결정 내용(decidedValue) 필수');
    const data = {
      status,
      decidedValue: dto.decidedValue ?? null, decidedByName: dto.decidedByName ?? null,
      decidedBy: recordedBy, // 서버 결속(부인방지)
      decidedDate: dto.decidedDate ?? (status === 'DECIDED' ? new Date().toISOString().slice(0, 10) : null),
      documentRef: dto.documentRef ?? null, note: dto.note ?? null,
    };
    return this.prisma.decisionRecord.upsert({ where: { key }, create: { key, ...data }, update: data });
  }

  /** 콘솔에서 미해소 개시차단(blocking && status!=='OK') 목록 산출 — 개시 승인 게이트 공통 기반. */
  private async openBlockers() {
    const con = await this.managementConsole();
    return con.axes.flatMap((a) => a.items).filter((i) => i.blocking && i.status !== 'OK')
      .map((i) => ({ key: i.key, label: i.label, status: i.status, owner: i.owner }));
  }

  /** 개시 승인 현황 — 준비 상태(NOT_READY/READY/APPROVED)·미해소 차단·최신 승인/철회. */
  async goLiveStatus() {
    const blockers = await this.openBlockers();
    const latest = await this.prisma.goLiveApproval.findFirst({ orderBy: { createdDt: 'desc' } });
    const approved = latest?.action === 'APPROVED';
    // ★승인은 sticky가 아니다: 승인 후 차단이 재발생/회귀하면(웹훅 http화·결정 PENDING 복귀 등) 승인이
    //   승인 시점에 소명한 범위를 벗어난다 → APPROVED_STALE로 표시해 배너가 초록으로 차단을 은폐하지 않게 한다.
    //   승인 시 override로 수용한(스냅샷) 차단은 새 차단이 아니므로 유효 유지.
    let state: string;
    if (approved) {
      let acceptedKeys: string[] = [];
      try { acceptedKeys = (JSON.parse(latest?.blockingSnapshot ?? '[]') as { key: string }[]).map((b) => b.key); } catch { acceptedKeys = []; }
      const newBlockers = blockers.filter((b) => !acceptedKeys.includes(b.key));
      state = newBlockers.length === 0 ? 'APPROVED' : 'APPROVED_STALE';
      /**
       * 승인 무효화는 밀어서 알린다 — 배너는 콘솔을 열어야 보인다.
       *
       * 승인 후 차단이 재발생하면(웹훅이 http로 바뀜·결정이 PENDING 복귀 등) 그 승인은
       * 소명 범위를 벗어난다. 그런데 이 상태는 **읽을 때 계산**되므로, 아무도 콘솔을 열지
       * 않으면 무효인 줄 모른 채 개시로 갈 수 있다.
       * 읽을 때마다 쌓지 않도록 미확인 알림이 있으면 만들지 않는다.
       */
      if (state === 'APPROVED_STALE') {
        void this.prisma.notification
          .findFirst({ where: { ntype: '개시승인무효', ackDt: null } })
          .then((open) => {
            if (open) return;
            return this.prisma.notification.create({
              data: {
                notifyId: genId('NTF'),
                ntype: '개시승인무효',
                target: '경영·개시총괄',
                message: `개시 승인 무효 — 승인 후 신규 차단 ${newBlockers.length}건 발생: ${newBlockers.map((b) => b.key).join(', ')}`.slice(0, 500),
                createdDt: new Date(),
              },
            });
          })
          .catch(() => undefined); // 알림 실패가 상태 조회를 막지 않는다
      }
    } else {
      state = blockers.length === 0 ? 'READY' : 'NOT_READY';
    }
    return { state, blockingOpen: blockers.length, openBlockers: blockers, current: latest ?? null };
  }

  /**
   * 개시 최종 승인(조직 GO 결정). 차단 0이어야 승인 — 잔존 시 override+잔여위험 명시해야 강행.
   * approvedBy는 서버가 JWT로 결속(부인방지). 승인 시점 미해소 차단을 스냅샷으로 남긴다(소명).
   */
  async approveGoLive(dto: { approvedByName?: string; approvedDate?: string; note?: string; override?: boolean; residualRisk?: string; forceOverride?: boolean; checklistSnapshot?: string; registryVersion?: string }, recordedBy: string | null) {
    const blockers = await this.openBlockers();
    if (blockers.length > 0 && !dto.override) {
      throw new BadRequestException(`개시 차단 ${blockers.length}건 미해소 — 승인 불가(강행하려면 override+잔여위험 명시): ${blockers.map((b) => b.label).join(', ')}`);
    }
    if (blockers.length > 0 && dto.override && !dto.residualRisk?.trim()) {
      throw new BadRequestException('차단 잔존 강행 승인(override)은 잔여위험(residualRisk) 명시 필수');
    }
    return this.prisma.goLiveApproval.create({
      data: {
        action: 'APPROVED', approvedByName: dto.approvedByName ?? null, approvedBy: recordedBy,
        approvedDate: dto.approvedDate ?? new Date().toISOString().slice(0, 10),
        // 체크리스트 차단을 강행한 경우도 override로 남긴다(forceOverride) — 콘솔 blocker가
        //   0이면 강행 승인이 '정상 승인'으로 기록되던 것을 막는다.
        override: blockers.length > 0 || dto.forceOverride === true, residualRisk: dto.residualRisk ?? null,
        blockingSnapshot: blockers.length ? JSON.stringify(blockers) : null, note: dto.note ?? null,
        // 승인 시점 체크리스트 전문 — 나중에 "무엇을 확인하고 승인했는가"를 재구성한다(§3.7).
        checklistSnapshot: dto.checklistSnapshot ?? null, registryVersion: dto.registryVersion ?? null,
      },
    });
  }

  /** 개시 승인 철회(조건 변화·재검토). */
  async revokeGoLive(dto: { note?: string }, recordedBy: string | null) {
    return this.prisma.goLiveApproval.create({ data: { action: 'REVOKED', approvedBy: recordedBy, note: dto.note ?? null } });
  }

  /**
   * 개시 준비도 — 파일럿 시드값 일괄 설정. 안전 원칙: 실 완료(OK)와 구별되는 상태로만 시드한다.
   *  - 위험치 채널: 시드 sink URL + SEED 마커(SEED 상태로 표시 — 실 전달 X, 개시 시 교체).
   *  - 판독의 Provider: 데모 판독 계정을 실재 Provider에 연결(파일럿 사인아웃 기능적으로 동작 → OK).
   * ★조직 결재·검사실 실값 서명·데모계정 비활성은 시드하지 않는다(실 결재/서명/컷오버 몫 — 페이크 금지).
   */
  async seedReadiness(userId: string | null) {
    // ★가드(2026-07-30 보안 검토 HIGH): 개시 승인 후 또는 실 채널 설정 후에는 시드가
    //   실 위험치 통보 URL을 존재하지 않는 sink로 바꿔 통보를 조용히 죽인다. 덮어쓰지 않는다.
    const latest = await this.prisma.goLiveApproval.findFirst({ orderBy: { createdDt: 'desc' } });
    if (latest?.action === 'APPROVED') {
      throw new BadRequestException('개시 승인 이후에는 시드값 설정을 실행할 수 없습니다(실 운영 설정 보호)');
    }
    const currentWebhook = this.settings.get('CRITICAL_WEBHOOK_URL') ?? '';
    const isSeedOrEmpty = currentWebhook === '' || currentWebhook.includes('/_seed/');
    // 1) 위험치 채널 — 파일럿 sink URL(경로에 _seed 포함 → readiness가 SEED로 감지, 실 전달 X).
    //    이미 실 URL이 들어가 있으면 건드리지 않는다.
    if (isSeedOrEmpty) {
      await this.settings.set('CRITICAL_WEBHOOK_URL', 'https://lis.example.org/api/v1/_seed/critical-sink', userId);
    }
    // 2) 판독의 Provider 연결 — 미연결 PHY/PAT 데모 계정을 실재 Provider에 순서대로 연결
    const providers = await this.prisma.provider.findMany({ orderBy: { providerId: 'asc' }, take: 20, select: { providerId: true } });
    const roleUsers = await this.prisma.userRole.findMany({ where: { roleCode: { in: ['PHY', 'PAT'] } }, select: { userId: true } });
    const unlinkedUsers = await this.prisma.appUser.findMany({
      where: { userId: { in: [...new Set(roleUsers.map((r) => r.userId))] }, providerId: null, status: 'ACTIVE' },
      select: { userId: true }, orderBy: { userId: 'asc' },
    });
    let linked = 0;
    for (let i = 0; i < unlinkedUsers.length && i < providers.length; i++) {
      await this.prisma.appUser.update({ where: { userId: unlinkedUsers[i].userId }, data: { providerId: providers[i].providerId } });
      linked += 1;
    }
    return { webhookSeeded: isSeedOrEmpty, providersLinked: linked, note: '조직 결재·검사실 실값·데모계정 비활성은 시드 대상 아님(실 결재/서명/컷오버 몫)' };
  }

  /**
   * 결재 참조 단일 수신 경로(EAS lifecycle) — 수기 입력·향후 HIS 자동피드 공통 진입점.
   * status: SUBMITTED(상신)/IN_PROGRESS(진행)/APPROVED(완료)/REJECTED(반려).
   * APPROVED일 때만 정기 재검토일 산정·재검토 플래그 해제. 모든 전이를 이력에 기록.
   */
  async applyApprovalReference(gateCode: string, dto: { status: string; docNo?: string; approvedDate?: string; approver?: string; approverUserId?: string; reviewIntervalDays?: number; reason?: string; source?: string; recordedBy?: string }) {
    const g = await this.prisma.orgApproval.findUnique({ where: { gateCode } });
    if (!g) throw new NotFoundException(`게이트 없음: ${gateCode}`);
    if (!isTransitionableGateStatus(dto.status)) throw new BadRequestException(`status는 ${GATE_TRANSITION_STATUSES.join('/')}: ${dto.status}`);

    const data: Record<string, unknown> = {
      status: dto.status, source: dto.source ?? g.source ?? 'MANUAL',
      ...(dto.docNo !== undefined ? { docNo: dto.docNo } : {}),
      ...(dto.approver !== undefined ? { approver: dto.approver } : {}),
      ...(dto.approverUserId !== undefined ? { approverUserId: dto.approverUserId } : {}),
      ...(dto.recordedBy !== undefined ? { recordedBy: dto.recordedBy } : {}), // 서버 결속 기입자(정본)
      ...(dto.reason !== undefined ? { note: dto.reason } : {}),
    };
    let approvedDate: string | null = g.approvedDate;
    if (dto.status === 'APPROVED') {
      approvedDate = dto.approvedDate ?? g.approvedDate ?? this.todayIso();
      const interval = dto.reviewIntervalDays ?? g.reviewIntervalDays ?? DEFAULT_REVIEW_INTERVAL_DAYS;
      Object.assign(data, { approvedDate, reviewIntervalDays: interval, nextReviewDate: addDaysIso(approvedDate, interval), needsReview: false, reviewReason: null });
    }
    const wasApproved = g.status === 'APPROVED';
    const updated = await this.prisma.orgApproval.update({ where: { gateCode }, data });
    const action = dto.status === 'APPROVED' ? (wasApproved ? 'RE_APPROVED' : 'APPROVED')
      : dto.status === 'SUBMITTED' ? (g.status === 'REJECTED' ? 'RESUBMITTED' : 'SUBMITTED')
        : dto.status; // IN_PROGRESS / REJECTED
    await this.prisma.orgApprovalHistory.create({
      // actor는 서버 결속 기입자(recordedBy) 우선 — 클라이언트가 준 approver 문자열보다 신뢰(비신뢰 방지)
      data: { gateCode, action, actor: dto.recordedBy ?? dto.approver ?? dto.approverUserId ?? null, docNo: dto.docNo ?? null, approvedDate: dto.status === 'APPROVED' ? approvedDate : null, reason: dto.reason ?? null },
    });
    return this.withReview(updated);
  }

  /** 게이트 실결재/재결재(완료) — 단일 수신 경로에 status=APPROVED로 위임(수기). */
  async approveGate(gateCode: string, dto: { docNo?: string; approvedDate?: string; approver?: string; approverUserId?: string; reviewIntervalDays?: number; note?: string; source?: string; recordedBy?: string }) {
    return this.applyApprovalReference(gateCode, { ...dto, status: 'APPROVED', reason: dto.note });
  }

  /** 담당자 교체 등으로 수동 재검토 표시(승인 유지, 재검토 필요 플래그만). */
  async flagGateReview(gateCode: string, reason: string, actor?: string) {
    const g = await this.prisma.orgApproval.findUnique({ where: { gateCode } });
    if (!g) throw new NotFoundException(`게이트 없음: ${gateCode}`);
    const updated = await this.prisma.orgApproval.update({ where: { gateCode }, data: { needsReview: true, reviewReason: reason } });
    await this.prisma.orgApprovalHistory.create({ data: { gateCode, action: 'FLAGGED_STALE', actor: actor ?? null, reason } });
    return this.withReview(updated);
  }

  /** 게이트 결재 이력(승인·재승인·재검토플래그). */
  async gateHistory(gateCode: string) {
    return this.prisma.orgApprovalHistory.findMany({ where: { gateCode }, orderBy: { createdDt: 'desc' } });
  }

  /** HIS EApprovalRelay에서 단일 게이트 결재 상태 참조 → 단일 수신 경로로 반영(source=HIS). */
  async syncGateFromHis(gateCode: string) {
    const g = await this.prisma.orgApproval.findUnique({ where: { gateCode } });
    if (!g) throw new NotFoundException(`게이트 없음: ${gateCode}`);
    const r = await getEapprovalStatus(gateCode);
    if (!r.available) return { gateCode, synced: false, reason: r.reason };
    const status = mapHisApprovalStatus(r.data.status);
    if (!status) return { gateCode, synced: false, reason: `HIS 상태 매핑 불가: ${r.data.status ?? '(없음)'}` };
    const updated = await this.applyApprovalReference(gateCode, {
      status, docNo: r.data.docNo, approver: r.data.approver, approvedDate: r.data.approvedDate, reason: r.data.note, source: 'HIS',
    });
    return { gateCode, synced: true, status, gate: updated };
  }

  /** 전 게이트 HIS 동기화(저빈도 폴링). 각 게이트별 결과 요약. */
  async syncAllGatesFromHis() {
    const gates = await this.prisma.orgApproval.findMany({ select: { gateCode: true } });
    const results = [];
    for (const g of gates) results.push(await this.syncGateFromHis(g.gateCode));
    return { total: gates.length, synced: results.filter((r) => r.synced).length, results };
  }

  /**
   * 검사실·법무 서명 워크시트 — 현재 dev seed 값을 실시간 집계(정적 문서와 달리 항상 현재값).
   * A 참고치·B 델타·C EDI·D QC·H 게이트는 DB에서, E/F/G는 결정·카탈로그 서술(체크리스트 §F·C8).
   * ⚠ 서명 전 임시 대표값 — 임상 권위 값 아님. 회신 후 seed 교체·재배포로 확정.
   */
  async signoffWorksheet() {
    const F_TESTS = ['CHE-CL', 'CHE-CO2', 'CHE-AGAP', 'CHE-CRE', 'CHE-BUN', 'CHE-CA', 'CHE-ALB', 'IMM-CRP', 'CHE-15AG']; // 15AG: HIS 실오더 유래 대표값(2026-07-22) — 서명 대상
    const DELTA_TESTS = ['CHE-K', 'CHE-NA', 'CHE-GLU', 'CHE-CRE', 'CHE-CA', 'IMM-CRP'];

    const [ranges, deltaMasters, edi, qc, gates] = await Promise.all([
      this.prisma.referenceRange.findMany({ where: { testCode: { in: F_TESTS } }, orderBy: { testCode: 'asc' } }),
      this.prisma.testMaster.findMany({ where: { testCode: { in: DELTA_TESTS } }, select: { testCode: true, name: true, autoVerify: true, deltaPctLimit: true, deltaAbsLimit: true, deltaWindowDays: true } }),
      this.prisma.codeMapping.findMany({ where: { ediCode: { not: null } }, orderBy: { lisCode: 'asc' } }),
      this.prisma.qcTarget.findMany({ where: { qcCode: 'QC-CH1', lot: 'DEFAULT' }, orderBy: { testCode: 'asc' } }),
      this.prisma.orgApproval.findMany({ orderBy: { gateCode: 'asc' } }),
    ]);
    const names = new Map((await this.prisma.testMaster.findMany({ where: { testCode: { in: [...F_TESTS, ...DELTA_TESTS] } }, select: { testCode: true, name: true, unitUcum: true } })).map((t) => [t.testCode, t]));

    return {
      generatedAt: new Date().toISOString(),
      notice: '현재 dev seed 대표값 — 검사실/법무 서명 후 실값 교체. 임상 권위 값 아님.',
      referenceRanges: ranges.map((r) => ({
        testCode: r.testCode, name: names.get(r.testCode)?.name ?? r.testCode, unit: names.get(r.testCode)?.unitUcum ?? null,
        low: r.low, high: r.high, panicLow: r.panicLow, panicHigh: r.panicHigh, ageMin: r.ageMin, ageMax: r.ageMax,
      })),
      deltaConfig: DELTA_TESTS.map((tc) => deltaMasters.find((m) => m.testCode === tc)).filter((m): m is NonNullable<typeof m> => !!m)
        .map((m) => ({ testCode: m.testCode, name: m.name, autoVerify: m.autoVerify, deltaPctLimit: m.deltaPctLimit, deltaAbsLimit: m.deltaAbsLimit, deltaWindowDays: m.deltaWindowDays })),
      ediCodes: edi.map((e) => ({ lisCode: e.lisCode, hisCode: e.hisCode, ediCode: e.ediCode, loinc: e.loinc })),
      qcTargets: qc.map((q) => ({ testCode: q.testCode, name: names.get(q.testCode)?.name ?? q.testCode, instrument: q.instrument, lot: q.lot, mean: q.mean, sd: q.sd })),
      clinicalDecisions: [
        { code: 'F-1', item: 'Anion Gap 공식·참고치', current: 'K 포함식 10–20', decide: 'K 포함/미포함 관례 확정(미포함 시 공식·참고치 동시 변경)' },
        { code: 'F-2', item: 'eGFR 적용 범위', current: 'CKD-EPI 2021 성인(≥18세) 전용', decide: '소아 eGFR(Schwartz) 추가 여부' },
        { code: 'F-3', item: 'ACMG SF 유전자 목록', current: 'v3.2(~87유전자)', decide: '개시 시점 최신본 대조·버전 서명' },
        { code: 'F-4', item: '항체동정 패널', current: '합성 11-cell(boolean)', decide: '실 시약 로트(dosage/zygosity) 반영' },
        { code: 'F-5', item: '특수수혈 요구원', current: '혈액은행 수기 등록 강제', decide: 'HIS 진단연동 자동도출 매핑 여부' },
      ],
      pathologyCatalogs: [
        { item: '세포병리 분류', current: 'Bethesda 대표 카테고리', decide: '검체별 최신판 세부' },
        { item: '종양분류(ICD-O-3)', current: '형식 검증만(NNNN/N·Cnn.n)', decide: 'ICD-O-3 코드북 채택본' },
        { item: 'Synoptic', current: 'CAP 간소화 필수요소', decide: 'CAP 프로토콜 전체(암종별)' },
      ],
      // ★실제 적용값을 싣는다 — 문서에 적힌 값과 동작하는 값이 다르면 서명이 무의미하다.
      //   설정 화면에서 보존일을 바꾸면 여기 값이 바뀌고, G 섹션이 '서명 이후 변경됨'으로 뜬다.
      legal: [
        { item: '감사로그 보존기간', current: `${this.settings.getNumber('RETENTION_DAYS_audit_log', 1095)}일`, decide: '법정·내부규정 최종값(하한 730일)' },
        { item: '연계 로그 보존기간', current: `${this.settings.getNumber('RETENTION_DAYS_interface_log', 365)}일`, decide: '최종값' },
        { item: '알림 보존기간', current: `${this.settings.getNumber('RETENTION_DAYS_notification', 365)}일`, decide: '최종값' },
        { item: '경과 데이터 자동 정리', current: this.settings.getBool('LIFECYCLE_PURGE') ? '실행(매일 04:00)' : '미실행', decide: '법무 확정 후 실행 여부' },
        { item: '유전정보 동의·이차소견', current: '동의 게이트 강제', decide: '동의서 양식·보고 정책 서명' },
      ],
      gates: gates.map((g) => ({ gateCode: g.gateCode, title: g.title, owner: g.owner, scope: g.scope, status: g.status, docNo: g.docNo, approvedDate: g.approvedDate, approver: g.approver, nextReviewDate: g.nextReviewDate, reviewFlags: reviewFlags(g, this.todayIso()) })),
    };
  }
}
