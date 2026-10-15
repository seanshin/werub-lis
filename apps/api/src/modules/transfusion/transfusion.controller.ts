/**
 * Transfusion (수혈) HTTP 컨트롤러 — 라우트 28개 (`api/v1/transfusion`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: 역할 게이트(LisRole.BB, LisRole.ADM).
 * ⚠ 서명·검증 주체는 요청 본문이 아니라 @CurrentUser(JWT)에서 얻는다 — 클라이언트 위조 방지.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Post, Body, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { TransfusionService } from './transfusion.service';
import { IssueBloodDto, RegisterUnitDto, BloodTypingDto, AdministerDto, ReactionDto, ReactionInvestigationDto, RecallUnitDto, CrossmatchDto, PerformCrossmatchDto, AntibodyPanelDto, AddRequirementDto, ReturnUnitDto, DiscardUnitDto } from './dto/transfusion.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { LisRole } from '../../common/rbac/roles';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Transfusion (수혈)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(LisRole.BB, LisRole.ADM)
@Controller('api/v1/transfusion')
export class TransfusionController {
  constructor(private readonly service: TransfusionService) {}

  @Get('inventory')
  @ApiOperation({ summary: '혈액제제 재고 조회' })
  async inventory(@Query('bloodGroup') bloodGroup?: string, @Query('status') status?: string) {
    return { data: await this.service.getInventory(bloodGroup, status) };
  }

  @Get('near-expiry')
  @ApiOperation({ summary: '근접만료 재고(기본 7일 내) — 폐기 예방 워크리스트' })
  async nearExpiry(@Query('days') days?: string) {
    return { data: await this.service.nearExpiry(days ? Number(days) : 7) };
  }

  @Get('requirements/:patientId')
  @ApiOperation({ summary: '환자 특수수혈 요구(방사선조사·CMV음성 등) 조회' })
  async listRequirements(@Param('patientId') patientId: string) {
    return { data: await this.service.listRequirements(patientId) };
  }

  @Post('requirements')
  @ApiOperation({ summary: '특수수혈 요구 등록 — 이후 출고를 서버가 강제(요청 누락 무관)' })
  async addRequirement(@Body() body: AddRequirementDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.addRequirement({ ...body, createdBy: user.userId }) };
  }

  @Post('requirements/:reqId/deactivate')
  @ApiOperation({ summary: '특수수혈 요구 해제(비활성화)' })
  async deactivateRequirement(@Param('reqId') reqId: string) {
    return { data: await this.service.deactivateRequirement(reqId) };
  }

  @Get('compatible-units/:patientId')
  @ApiOperation({ summary: '항원음성 적합 유닛 매칭 — 동종면역 환자 항체 대응 재고' })
  async compatibleUnits(@Param('patientId') patientId: string, @Query('bloodGroup') bloodGroup?: string) {
    return { data: await this.service.compatibleUnits(patientId, bloodGroup) };
  }

  @Get('antibody-panel/template')
  @ApiOperation({ summary: '항체동정 패널 템플릿(세포별 항원 프로파일)' })
  antibodyPanelTemplate() {
    return { data: this.service.antibodyPanelTemplate() };
  }

  @Post('antibody-panel')
  @ApiOperation({ summary: '항체동정 패널 판정(룰아웃·후보·동정) + 선택적 항체 기록' })
  async antibodyPanel(@Body() body: AntibodyPanelDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.interpretAntibodyPanel({ ...body, tester: user.userId }) };
  }

  @Post('issue/:issueId/return')
  @ApiOperation({ summary: '출고 취소·반납 — 시행 전 제제를 재고로 복원' })
  async returnUnit(@Param('issueId') issueId: string, @Body() body: ReturnUnitDto) {
    return { data: await this.service.returnUnit(issueId, body?.reason) };
  }

  @Post('units')
  @ApiOperation({ summary: '혈액제제 입고(등록)' })
  async register(@Body() body: RegisterUnitDto) {
    return { data: await this.service.registerUnit(body) };
  }

  @Post('typing')
  @ApiOperation({ summary: '환자 혈액형·항체선별 등록' })
  async typing(@Body() body: BloodTypingDto) {
    return { data: await this.service.recordTyping(body) };
  }

  @Get('patient/:patientId')
  @ApiOperation({ summary: '출고 대상 환자 확인(성명·혈액형·특수요구) — 오식별 방지' })
  async issueContext(@Param('patientId') patientId: string) {
    return { data: await this.service.issueContext(patientId) };
  }

  @Get('issue-eligibility/:patientId/:unitNo')
  @ApiOperation({ summary: '출고 적격성 사전점검(읽기 전용) — ABO 2회확인·교차시험 경과·독립검증·특수요구·항원매칭 근거 종합 + 차단 사유를 수치 근거로 설명. 실제 출고와 같은 판정 정본 사용' })
  async issueEligibility(@Param('patientId') patientId: string, @Param('unitNo') unitNo: string) {
    return { data: await this.service.issueEligibility(patientId, unitNo) };
  }

  @Get('typing/:patientId')
  @ApiOperation({ summary: '환자 혈액형·항체 이력' })
  async getTyping(@Param('patientId') patientId: string) {
    return { data: await this.service.getTyping(patientId) };
  }

  @Post('crossmatch')
  @ApiOperation({ summary: '교차시험(Crossmatch) 결과 기록(수기 판정값)' })
  async crossmatch(@Body() body: CrossmatchDto) {
    return { data: await this.service.recordCrossmatch(body) };
  }

  @Post('crossmatch/perform')
  @ApiOperation({ summary: '교차시험 생성·판정 — 환자 혈액형·항체선별 + 제제 혈액형으로 ABO/RhD 적합성 자동 판정·기록' })
  async performCrossmatch(@Body() body: PerformCrossmatchDto) {
    return { data: await this.service.performCrossmatch(body) };
  }

  @Get('crossmatch/:patientId/:unitNo')
  @ApiOperation({ summary: '환자+제제 최신 교차시험 결과' })
  async getCrossmatch(@Param('patientId') patientId: string, @Param('unitNo') unitNo: string) {
    return { data: await this.service.getCrossmatch(patientId, unitNo) };
  }

  @Post('issue')
  @ApiOperation({ summary: '혈액제제 출고(안전 게이트 + 2인 확인)' })
  async issue(@Body() body: IssueBloodDto, @CurrentUser() user: AuthUser) {
    // 실제 출고를 실행한 인증 계정 — 2인 확인 중 1인이 반드시 이 사람이어야 한다(서버 결속)
    return { data: await this.service.issueBlood({ ...body, actingUserId: user.userId }) };
  }

  @Post('administer')
  @ApiOperation({ summary: '수혈 시행 기록' })
  async administer(@Body() body: AdministerDto) {
    return { data: await this.service.administer(body) };
  }

  @Post('reactions')
  @ApiOperation({ summary: '수혈 부작용 보고(유형·중증도별 권고 조치)' })
  async reaction(@Body() body: ReactionDto) {
    return { data: await this.service.reportReaction(body) };
  }

  @Get('reactions/:reactionId')
  @ApiOperation({ summary: '수혈 반응 조사 상태 조회(워크업 prefill·종결 확인)' })
  async getReaction(@Param('reactionId') reactionId: string) {
    return { data: await this.service.getReaction(reactionId) };
  }

  @Post('reactions/:reactionId/investigate')
  @ApiOperation({ summary: '수혈 반응 조사 워크업(사무착오·DAT·post ABO·용혈지표·원인제제·최종분류)' })
  async investigate(@Param('reactionId') reactionId: string, @Body() body: ReactionInvestigationDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.investigateReaction(reactionId, body, user.userId) };
  }

  @Get('traceability/:unitNo')
  @ApiOperation({ summary: '제제 완전추적성 — 헌혈유래→출고→수혈자 체인' })
  async traceability(@Param('unitNo') unitNo: string) {
    return { data: await this.service.traceUnit(unitNo) };
  }

  @Get('patient-transfusions/:patientId')
  @ApiOperation({ summary: '환자 수혈 이력(받은 제제 전체)' })
  async patientTransfusions(@Param('patientId') patientId: string) {
    return { data: await this.service.patientTransfusions(patientId) };
  }

  @Post('units/:unitNo/recall')
  @ApiOperation({ summary: '제제 회수/격리 — 수혈자 반환(look-back 대상)' })
  async recall(@Param('unitNo') unitNo: string, @Body() body: RecallUnitDto) {
    return { data: await this.service.recallUnit(unitNo, body.status as 'RECALLED' | 'QUARANTINED', body.reason) };
  }

  @Post('lookback/:donationId')
  @ApiOperation({ summary: 'Look-back — 헌혈번호 유래 제제 전체의 수혈자 역추적' })
  async lookback(@Param('donationId') donationId: string) {
    return { data: await this.service.lookback(donationId) };
  }

  @Get('consent-status/:patientId')
  @ApiOperation({ summary: 'HIS 수혈 동의 상태 참조(출고 전 확인 — FHIR Consent 파생상태)(T1)' })
  async consentStatus(@Param('patientId') patientId: string) {
    return { data: await this.service.hisConsentStatus(patientId) };
  }

  @Post('units/:unitNo/discard')
  @ApiOperation({ summary: '명시적 혈액 폐기(만료·손상·오염 — 사유 추적)(T2)' })
  async discard(@Param('unitNo') unitNo: string, @Body() body: DiscardUnitDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.discardUnit(unitNo, { ...body, discardedBy: user.userId }) };
  }
}
