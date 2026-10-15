/**
 * Admin · Users (사용자·권한 관리) HTTP 컨트롤러 — 라우트 31개 (`api/v1/admin`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: 역할 게이트(LisRole.ADM).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Post, Patch, Param, Body, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsArray, IsOptional, IsIn, IsInt, IsBoolean, Min } from 'class-validator';
import { UserAdminService } from './user-admin.service';
import { SignoffService } from './signoff.service';
import { GoLiveService } from './golive.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { LisRole } from '../../common/rbac/roles';
import { GATE_TRANSITION_STATUSES } from '../../domain/signoff-review';

class CreateUserDto {
  @IsString() userId!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() dept?: string;
  @IsString() password!: string;
  @IsArray() @IsString({ each: true }) roles!: string[];
  /** 판독의 계정이면 Provider 연결(병리 사인아웃 서명 주체). 나중에 별도 연결도 가능. */
  @IsOptional() @IsString() providerId?: string;
}
class SetProviderDto {
  /** 연결 해제는 null. Provider(의사 마스터) ID. */
  @IsOptional() @IsString() providerId?: string | null;
}
class SetRolesDto {
  @IsArray() @IsString({ each: true }) roles!: string[];
}
class SetStatusDto {
  @IsIn(['ACTIVE', 'INACTIVE']) status!: 'ACTIVE' | 'INACTIVE';
}
class ResetPwDto {
  @IsString() newPassword!: string;
}
class SignoffDto {
  @IsString() signerName!: string; // 확정한 사람 실명(계정과 별개일 수 있다)
  @IsOptional() @IsString() signerRole?: string;
  @IsOptional() @IsString() documentNo?: string;
  @IsOptional() @IsString() note?: string;
}
class ApproveGateDto {
  @IsOptional() @IsString() docNo?: string;
  @IsOptional() @IsString() approvedDate?: string;
  @IsOptional() @IsString() approver?: string;
  @IsOptional() @IsString() approverUserId?: string; // 결재자 실 계정(인력변경 감지 결속)
  @IsOptional() @IsInt() @Min(1) reviewIntervalDays?: number; // 정기 재검토 주기(일)
  @IsOptional() @IsString() note?: string;
}
class FlagReviewDto {
  @IsString() reason!: string;
  @IsOptional() @IsString() actor?: string;
}
class DecisionDto {
  @IsOptional() @IsString() status?: string; // 정본 검증은 서비스(isDecisionStatus)
  @IsOptional() @IsString() decidedValue?: string;
  @IsOptional() @IsString() decidedByName?: string; // 결정 주체(외부 인물·부서)
  @IsOptional() @IsString() decidedDate?: string;
  @IsOptional() @IsString() documentRef?: string;
  @IsOptional() @IsString() note?: string;
}
class GoLiveApproveDto {
  @IsOptional() @IsString() approvedByName?: string;
  @IsOptional() @IsString() approvedDate?: string;
  @IsOptional() @IsBoolean() override?: boolean;
  @IsOptional() @IsString() residualRisk?: string;
  @IsOptional() @IsString() note?: string;
}
class ApprovalReferenceDto {
  @IsIn(GATE_TRANSITION_STATUSES as unknown as string[]) status!: string;
  @IsOptional() @IsString() docNo?: string;
  @IsOptional() @IsString() approvedDate?: string;
  @IsOptional() @IsString() approver?: string;
  @IsOptional() @IsString() approverUserId?: string;
  @IsOptional() @IsInt() @Min(1) reviewIntervalDays?: number;
  @IsOptional() @IsString() reason?: string;
  @IsOptional() @IsString() source?: string;
}

@ApiTags('Admin · Users (사용자·권한 관리)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(LisRole.ADM)
@Controller('api/v1/admin')
export class UserAdminController {
  constructor(
    private readonly service: UserAdminService,
    private readonly signoff: SignoffService,
    private readonly goLiveSvc: GoLiveService, // 승인 경로 단일화 — 체크리스트 게이트가 정본
  ) {}

  @Get('permission-matrix')
  @ApiOperation({ summary: '역할×기능 권한 매트릭스(읽기 전용)' })
  matrix() {
    return { data: this.service.matrix() };
  }

  @Get('gates')
  @ApiOperation({ summary: '조직 게이트(A-1/A-2/A-3/PACS) 결재 현황 — 개시 준비도' })
  async gates() {
    return { data: await this.service.listGates() };
  }

  @Get('readiness')
  @Roles(LisRole.ADM, LisRole.AUD)
  @ApiOperation({ summary: '개시 준비도 — 사람 몫 잔여 항목(위험치채널·조직결재·판독의연결·데모계정·백업·마스터·카탈로그·ERP) 라이브 점검' })
  async readiness() {
    return { data: await this.service.readiness() };
  }

  @Post('readiness/seed')
  @ApiOperation({ summary: '개시 준비도 파일럿 시드값 설정 — 위험치채널(시드 sink·SEED표시)·판독의 Provider 연결. 조직결재·검사실서명·데모계정은 시드 제외' })
  async seedReadiness(@Req() req: { user?: { userId?: string } }) {
    return { data: await this.service.seedReadiness(req.user?.userId ?? null) };
  }

  @Get('console')
  @Roles(LisRole.ADM, LisRole.AUD)
  @ApiOperation({ summary: '운영 관리 콘솔(P1/P2) — 정의 항목 4축 집계·lifecycle·워크플로우 파이프라인' })
  async console() {
    return { data: await this.service.managementConsole() };
  }

  @Get('console/activity')
  @Roles(LisRole.ADM, LisRole.AUD)
  @ApiOperation({ summary: '운영 관리 통합 이력(P3) — 결재·서명·코드셋반입·설정변경·반사검사 이벤트를 한 타임라인으로' })
  async consoleActivity() {
    return { data: await this.service.managementActivity() };
  }

  @Get('decisions')
  @Roles(LisRole.ADM, LisRole.AUD)
  @ApiOperation({ summary: '개시 조직/외부 결정 목록 — 시스템 추론 불가 결정(인프라·PACS·법무값 등) 레지스트리×기록' })
  async decisions() {
    return { data: await this.service.listDecisions() };
  }

  @Post('decisions/:key')
  @ApiOperation({ summary: '조직/외부 결정 기입·갱신(결정값·주체·근거) — 기입자는 서버가 결속' })
  async recordDecision(@Param('key') key: string, @Body() body: DecisionDto, @Req() req: { user?: { userId?: string } }) {
    return { data: await this.service.recordDecision(key, body, req.user?.userId ?? null) };
  }

  @Get('golive')
  @Roles(LisRole.ADM, LisRole.AUD)
  @ApiOperation({ summary: '개시 승인 현황 — 준비상태(NOT_READY/READY/APPROVED)·미해소 차단·최신 승인' })
  async goLive() {
    // 결정등록 판정 + 체크리스트를 합친 것이 정본이다 — 둘이 따로 놀면 두 화면이 정반대를 말한다.
    return { data: await this.goLiveSvc.status() };
  }

  @Post('golive/approve')
  @ApiOperation({ summary: '개시 최종 승인(조직 GO) — 차단 0 필요, 강행 시 override+잔여위험. 승인자 서버 결속' })
  async approveGoLive(@Body() body: GoLiveApproveDto, @Req() req: { user?: { userId?: string } }) {
    // 승인 경로는 **하나여야 한다.** 체크리스트 게이트를 가진 GoLiveService.approve가 정본이고,
    // 그 안에서 결정 등록 기준 게이트(UserAdminService.approveGoLive)를 다시 호출한다.
    // 여기서 service.approveGoLive를 직접 부르면 체크리스트 차단을 건너뛴다.
    return { data: await this.goLiveSvc.approve(body, req.user?.userId ?? null) };
  }

  @Post('golive/revoke')
  @ApiOperation({ summary: '개시 승인 철회(조건 변화·재검토)' })
  async revokeGoLive(@Body() body: { note?: string }, @Req() req: { user?: { userId?: string } }) {
    return { data: await this.service.revokeGoLive(body ?? {}, req.user?.userId ?? null) };
  }

  @Get('signoff-worksheet')
  @Roles(LisRole.TEC, LisRole.PHY, LisRole.MIC, LisRole.ADM, LisRole.AUD)
  @ApiOperation({ summary: '검사실·법무 서명 워크시트 — 현재 seed 값 실시간 집계(검사실 열람 가능)' })
  async signoffWorksheet() {
    return { data: await this.service.signoffWorksheet() };
  }

  // ── 검사실·법무 서명(워크시트를 인쇄물에서 기록으로) ──
  /**
   * 서명 drift 점검 수동 실행 — 크론(매일 09:10)과 같은 로직.
   * 크론만 두면 도입 직후 동작 확인이 다음 날까지 불가하다.
   */
  @Post('signoff/drift-check')
  @Roles(LisRole.ADM)
  @ApiOperation({ summary: '서명 이후 값 변경 점검(수동) — 크론과 동일. 변경 있으면 알림 생성' })
  async signoffDriftCheck() {
    await this.signoff.signoffDriftAlert();
    return { data: { ran: true } };
  }

  @Get('signoff/status')
  @Roles(LisRole.TEC, LisRole.PHY, LisRole.MIC, LisRole.ADM, LisRole.AUD)
  @ApiOperation({ summary: '섹션별 서명 현황 — 서명 여부·서명 이후 값 변경(drift) 표시' })
  async signoffStatus() {
    return { data: await this.signoff.status() };
  }

  @Get('signoff/:section/history')
  @Roles(LisRole.TEC, LisRole.PHY, LisRole.MIC, LisRole.ADM, LisRole.AUD)
  @ApiOperation({ summary: '섹션 서명 이력(재서명 포함 — 수정·삭제 없이 쌓인다)' })
  async signoffHistory(@Param('section') section: string) {
    return { data: await this.signoff.history(section) };
  }

  @Get('signoff/:section/drift')
  @Roles(LisRole.TEC, LisRole.PHY, LisRole.MIC, LisRole.ADM, LisRole.AUD)
  @ApiOperation({ summary: '서명 이후 무엇이 바뀌었는지(항목 단위 추가·삭제·변경)' })
  async signoffDrift(@Param('section') section: string) {
    return { data: await this.signoff.drift(section) };
  }

  @Post('signoff/:section')
  @Roles(LisRole.TEC, LisRole.PHY, LisRole.MIC, LisRole.ADM)
  @ApiOperation({ summary: '서명 기입 — 현재 값 스냅샷을 함께 굳힌다(이후 변경은 drift로 드러남)' })
  async sign(@Param('section') section: string, @Body() dto: SignoffDto, @Req() req: { user?: { userId?: string } }) {
    return { data: await this.signoff.sign(section, dto, req.user?.userId ?? null) };
  }

  @Post('gates/:gateCode/approve')
  @ApiOperation({ summary: '게이트 실결재/재결재(APPROVED·결재자 결속·정기 재검토일 산정·이력)' })
  async approveGate(@Param('gateCode') gateCode: string, @Body() body: ApproveGateDto, @Req() req: { user?: { userId?: string } }) {
    // 기입자는 서버가 JWT에서 결속(클라이언트 위조 불가) — 감사 정본·데모/실 판정
    return { data: await this.service.approveGate(gateCode, { ...body, recordedBy: req.user?.userId }) };
  }

  @Post('gates/:gateCode/reference')
  @ApiOperation({ summary: '결재 참조 단일 수신(EAS lifecycle: 상신/진행/완료/반려) — 수기·향후 자동피드 공통' })
  async applyReference(@Param('gateCode') gateCode: string, @Body() body: ApprovalReferenceDto, @Req() req: { user?: { userId?: string } }) {
    return { data: await this.service.applyApprovalReference(gateCode, { ...body, recordedBy: req.user?.userId }) };
  }

  @Post('gates/:gateCode/flag-review')
  @ApiOperation({ summary: '게이트 재검토 필요 수동 표시(담당자 교체 등)' })
  async flagGateReview(@Param('gateCode') gateCode: string, @Body() body: FlagReviewDto) {
    return { data: await this.service.flagGateReview(gateCode, body.reason, body.actor) };
  }

  @Post('gates/sync')
  @ApiOperation({ summary: '전 게이트 HIS 결재 참조 동기화(EApprovalRelay 폴링)' })
  async syncAllGates() {
    return { data: await this.service.syncAllGatesFromHis() };
  }

  @Post('gates/:gateCode/sync')
  @ApiOperation({ summary: '단일 게이트 HIS 결재 참조 동기화' })
  async syncGate(@Param('gateCode') gateCode: string) {
    return { data: await this.service.syncGateFromHis(gateCode) };
  }

  @Get('gates/:gateCode/history')
  @ApiOperation({ summary: '게이트 결재 이력(승인·재승인·재검토플래그)' })
  async gateHistory(@Param('gateCode') gateCode: string) {
    return { data: await this.service.gateHistory(gateCode) };
  }

  @Get('roles')
  @ApiOperation({ summary: '역할 목록' })
  async roles() {
    return { data: await this.service.roles() };
  }

  @Get('users')
  @ApiOperation({ summary: '사용자 목록(역할·상태·잠금)' })
  async users() {
    return { data: await this.service.listUsers() };
  }

  @Post('users')
  @ApiOperation({ summary: '사용자 생성(초기 비번·역할)' })
  async create(@Body() body: CreateUserDto) {
    return { data: await this.service.createUser(body) };
  }

  @Patch('users/:userId/roles')
  @ApiOperation({ summary: '역할 재배정(전체 교체)' })
  async setRoles(@Param('userId') userId: string, @Body() body: SetRolesDto) {
    return { data: await this.service.setRoles(userId, body.roles) };
  }

  @Patch('users/:userId/status')
  @ApiOperation({ summary: '계정 활성/비활성 + 잠금 해제' })
  async setStatus(@Param('userId') userId: string, @Body() body: SetStatusDto) {
    return { data: await this.service.setStatus(userId, body.status) };
  }

  @Get('providers')
  @ApiOperation({ summary: '의사 마스터(Provider) 목록 — 계정↔판독의 연결용' })
  async providers() {
    return { data: await this.service.listProviders() };
  }

  @Patch('users/:userId/provider')
  @ApiOperation({ summary: '계정↔판독의(Provider) 연결 — 병리 사인아웃 등 임상 서명 주체 결속' })
  async setProvider(@Param('userId') userId: string, @Body() body: SetProviderDto) {
    return { data: await this.service.setProvider(userId, body.providerId ?? null) };
  }

  @Post('users/:userId/unlock')
  @ApiOperation({ summary: '계정 잠금 해제(연속 실패 잠금) — 활성/비활성 상태는 건드리지 않음' })
  async unlock(@Param('userId') userId: string) {
    return { data: await this.service.unlockAccount(userId) };
  }

  @Post('users/:userId/reset-password')
  @ApiOperation({ summary: '관리자 비밀번호 재설정' })
  async reset(@Param('userId') userId: string, @Body() body: ResetPwDto) {
    return { data: await this.service.resetPassword(userId, body.newPassword) };
  }
}
