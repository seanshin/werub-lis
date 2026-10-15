/**
 * Result (결과·검증·위험치) HTTP 컨트롤러 — 라우트 31개 (`api/v1/results`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: F-CRT:R, F-CRT:W, F-RES:R, F-RES:W, F-V2:S, F-V2:V.
 * ⚠ 서명·검증 주체는 요청 본문이 아니라 @CurrentUser(JWT)에서 얻는다 — 클라이언트 위조 방지.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Post, Delete, Param, Body, Query, Header, UseGuards, UseInterceptors, UploadedFile, Res } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiConsumes, ApiBody } from '@nestjs/swagger';
import { ResultService } from './result.service';
import { SubmitResultDto, AckCriticalDto, CorrectResultDto, VerifyResultDto, VerifyBatchDto } from './dto/result.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { Feature, Access, LisRole } from '../../common/rbac/roles';
import { ATTACH_ANY_READ_ROLES, ATTACH_ANY_WRITE_ROLES } from './attachment-access';

/** multer 파일(로컬 타입 — @types/multer 미설치) */
interface UploadedFileLike { buffer: Buffer; originalname: string; mimetype: string; size: number }

/**
 * multer 기본값은 크기 무제한이고 memoryStorage라, 앱 레이어의 20MB 검사는 **전체를 힙에 올린 뒤**
 * 수행된다. 스트림 단계에서 끊어야 대용량 업로드로 API 프로세스를 OOM 시킬 수 없다.
 */
const UPLOAD_LIMITS = { limits: { fileSize: 20 * 1024 * 1024, files: 1 } };

// 첨부는 교차 도메인(결과·병리) — 역할 기반 접근(RolesGuard). 쓰기=임상 담당, 읽기=임상+감사.
const ATTACH_WRITE_ROLES = [LisRole.TEC, LisRole.PHY, LisRole.MIC, LisRole.PAT, LisRole.ADM];
const ATTACH_READ_ROLES = [LisRole.TEC, LisRole.PHY, LisRole.MIC, LisRole.PAT, LisRole.BB, LisRole.ADM, LisRole.AUD];
// 유전체 첨부는 유전체 직무(GEN/GC/PHY/ADM)로 별도 게이트 — 민감정보 최소권한(08 §3.3)
const GEN_ATTACH_WRITE_ROLES = [LisRole.GEN, LisRole.GC, LisRole.PHY, LisRole.ADM];
const GEN_ATTACH_READ_ROLES = [LisRole.GEN, LisRole.GC, LisRole.PHY, LisRole.ADM, LisRole.AUD];
// 수혈 이상반응 첨부: 수혈 직무. EQA 첨부: 검사 직무.
const BB_ATTACH_WRITE_ROLES = [LisRole.BB, LisRole.PHY, LisRole.ADM];
const BB_ATTACH_READ_ROLES = [LisRole.BB, LisRole.PHY, LisRole.ADM, LisRole.AUD];
const EQA_ATTACH_WRITE_ROLES = [LisRole.TEC, LisRole.PHY, LisRole.MIC, LisRole.ADM];
const EQA_ATTACH_READ_ROLES = [LisRole.TEC, LisRole.PHY, LisRole.MIC, LisRole.ADM, LisRole.AUD];

@ApiTags('Result (결과·검증·위험치)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('api/v1/results')
export class ResultController {
  constructor(private readonly service: ResultService) {}

  @Get()
  @RequirePermission(Feature.RES, Access.R)
  @ApiOperation({ summary: '검체별 결과 조회' })
  async findBySpecimen(@Query('specimenNo') specimenNo: string) {
    return { data: await this.service.findBySpecimen(specimenNo) };
  }

  @Post()
  @RequirePermission(Feature.RES, Access.W) // 결과 입력: TEC/PHY/MIC
  @ApiOperation({ summary: '결과 등록 + 자동평가(참고치·판정·자동검증·위험치)' })
  async submit(@Body() body: SubmitResultDto, @CurrentUser() user: AuthUser) {
    // 입력 귀속은 유지(장비/문서 코드 허용)하되, 수기(MANUAL) 입력자는 인증 주체로 강제.
    const enteredBy = (body.source ?? 'MANUAL') === 'MANUAL' ? user.userId : (body.enteredBy ?? user.userId);
    return { data: await this.service.submitResult({ ...body, enteredBy }) };
  }

  @Post('specimens/:specimenNo/hil')
  @RequirePermission(Feature.RES, Access.W)
  @ApiOperation({ summary: '검체 품질 HIL 등급 기록(용혈·황달·지질혈 NONE/1+/2+/3+)(D1)' })
  async recordHil(@Param('specimenNo') specimenNo: string, @Body() body: { hemolysis?: string; icterus?: string; lipemia?: string }) {
    return { data: await this.service.recordHil(specimenNo, body) };
  }

  @Get('worklist')
  @RequirePermission(Feature.RES, Access.R)
  @ApiOperation({ summary: '검증 대기 워크리스트(위험치·델타 우선 정렬)' })
  async worklist() {
    return { data: await this.service.verificationWorklist() };
  }

  @Get('reportable')
  // 보고서 상세(report/:specimenNo)와 **같은 권한**이어야 한다 — 목록만 RPT로 막으면
  // 상세는 열리는데 목록은 403이 되어 화면이 반쪽만 동작한다.
  @RequirePermission(Feature.RES, Access.R)
  @ApiOperation({ summary: '보고 가능 검체 목록 — 확정 결과 보유 검체(보고일 기준 기간·검색)' })
  async reportable(@Query('from') from?: string, @Query('to') to?: string, @Query('q') q?: string, @Query('take') take?: string) {
    return { data: await this.service.reportableSpecimens({ from, to, q, take: take ? Number(take) : undefined }) };
  }

  @Get('report/:specimenNo')
  @RequirePermission(Feature.RES, Access.R)
  @ApiOperation({ summary: '결과보고서(환자·검사·값·참고치·판정·검증자)' })
  async report(@Param('specimenNo') specimenNo: string) {
    return { data: await this.service.report(specimenNo) };
  }

  @Get('report/:specimenNo/html')
  @RequirePermission(Feature.RES, Access.R)
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiOperation({ summary: '인쇄용 결과보고서 HTML(브라우저 PDF 출력)' })
  async reportHtml(@Param('specimenNo') specimenNo: string) {
    return this.service.reportHtml(specimenNo);
  }

  @Post('report/:specimenNo/deliver')
  @RequirePermission(Feature.RES, Access.W)
  @ApiOperation({ summary: '리포트 배포 기록(PRINT/PORTAL/PROVIDER/FAX)' })
  async deliver(@Param('specimenNo') specimenNo: string, @Body() body: { channel: string; recipient?: string; note?: string }, @CurrentUser() user: AuthUser) {
    return { data: await this.service.recordDelivery(specimenNo, { ...body, deliveredBy: user.userId }) };
  }

  @Get('report/:specimenNo/deliveries')
  @RequirePermission(Feature.RES, Access.R)
  @ApiOperation({ summary: '리포트 배포 이력' })
  async deliveries(@Param('specimenNo') specimenNo: string) {
    return { data: await this.service.listDeliveries(specimenNo) };
  }

  @Get('cumulative/:patientId')
  @RequirePermission(Feature.RES, Access.R)
  @ApiOperation({ summary: '누적(추세) 보고서 — 환자 확정결과를 검사별 시계열로' })
  async cumulative(@Param('patientId') patientId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.service.cumulativeReport(patientId, from, to) };
  }

  @Post('verify/batch')
  @RequirePermission(Feature.V2, Access.V) // 2차 검증 확정: 검증의(PHY)
  @ApiOperation({ summary: '2차 검증 일괄 확정(PENDING→VERIFIED)' })
  async verifyBatch(@Body() body: VerifyBatchDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.verifyBatch({ ...body, verifier: user.userId }) };
  }

  @Get(':resultId/evidence-context')
  @ApiOperation({ summary: '결과 근거 종합 번들 — 적용 참고치·선택근거(성별/연령)·델타·패닉임계·QC·HIL·추세 통합. 보류 사유를 수치 근거로 설명(판독 검토용, 향후 원내 LLM RAG 컨텍스트). 외부 전송 없음' })
  async evidenceContext(@Param('resultId') resultId: string) {
    return { data: await this.service.evidenceContext(resultId) };
  }

  @Post(':resultId/verify')
  @RequirePermission(Feature.V2, Access.V) // 2차 검증 확정: 검증의(PHY)
  @ApiOperation({ summary: '2차 검증 확정(PENDING→VERIFIED, HIS 발신·리플렉스)' })
  async verify(@Param('resultId') resultId: string, @Body() body: VerifyResultDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.verifyResult(resultId, { ...body, verifier: user.userId }) };
  }

  @Post(':resultId/correct')
  @RequirePermission(Feature.V2, Access.S) // 정정·확정은 검증의(PHY)
  @ApiOperation({ summary: '결과 정정(신규 버전 C 생성, 원본 보존)' })
  async correct(@Param('resultId') resultId: string, @Body() body: CorrectResultDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.correctResult(resultId, { ...body, verifier: user.userId }) };
  }

  @Get('criticals/pending')
  @RequirePermission(Feature.CRT, Access.R)
  @ApiOperation({ summary: '미확인 위험치 통보 목록(대시보드)' })
  async pending() {
    return { data: await this.service.pendingCriticals() };
  }

  @Post('criticals/:notifyId/ack')
  @RequirePermission(Feature.CRT, Access.W) // 위험치 통보/확인
  @ApiOperation({ summary: '위험치 통보 확인(폐루프 완료)' })
  async ack(@Param('notifyId') notifyId: string, @Body() body: AckCriticalDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.ackCritical(notifyId, { ...body, ackBy: user.userId }) };
  }

  @Post('criticals/:notifyId/dispatch')
  @RequirePermission(Feature.CRT, Access.W)
  @ApiOperation({ summary: '위험치 통보 실채널 재발송(webhook/SMS 게이트웨이)' })
  async dispatch(@Param('notifyId') notifyId: string) {
    return { data: await this.service.dispatchCritical(notifyId) };
  }

  // ── 검사결과 첨부 문서(PDF·이미지) ──────────────────────────
  @Post('specimens/:specimenNo/attachments')
  @UseGuards(RolesGuard)
  @Roles(...ATTACH_WRITE_ROLES)
  @UseInterceptors(FileInterceptor('file', UPLOAD_LIMITS))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, note: { type: 'string' } } } })
  @ApiOperation({ summary: '검사결과 문서/이미지 첨부(PDF·PNG·JPEG·WEBP, ≤20MB)' })
  async addAttachment(
    @Param('specimenNo') specimenNo: string,
    @UploadedFile() file: UploadedFileLike,
    @Body('note') note: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return { data: await this.service.addAttachment({ specimenNo }, file, note, user?.userId) };
  }

  @Get('specimens/:specimenNo/attachments')
  @UseGuards(RolesGuard)
  @Roles(...ATTACH_READ_ROLES)
  @ApiOperation({ summary: '검체 첨부 목록(메타데이터)' })
  async listAttachments(@Param('specimenNo') specimenNo: string) {
    return { data: await this.service.listAttachments({ specimenNo }) };
  }

  // ── 병리 케이스 첨부 ──
  @Post('pathology/:spNo/attachments')
  @UseGuards(RolesGuard)
  @Roles(...ATTACH_WRITE_ROLES)
  @UseInterceptors(FileInterceptor('file', UPLOAD_LIMITS))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, note: { type: 'string' } } } })
  @ApiOperation({ summary: '병리 케이스 문서/이미지 첨부(PDF·이미지, ≤20MB)' })
  async addPathologyAttachment(
    @Param('spNo') spNo: string,
    @UploadedFile() file: UploadedFileLike,
    @Body('note') note: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return { data: await this.service.addAttachment({ spNo }, file, note, user?.userId) };
  }

  @Get('pathology/:spNo/attachments')
  @UseGuards(RolesGuard)
  @Roles(...ATTACH_READ_ROLES)
  @ApiOperation({ summary: '병리 케이스 첨부 목록(메타데이터)' })
  async listPathologyAttachments(@Param('spNo') spNo: string) {
    return { data: await this.service.listAttachments({ spNo }) };
  }

  // ── 유전체 오더 첨부(수탁 PDF 결과지 등 — 자동 인터페이스 부재 시 문서 경로) ──
  @Post('genomic/:genomicOrderId/attachments')
  @UseGuards(RolesGuard)
  @Roles(...GEN_ATTACH_WRITE_ROLES)
  @UseInterceptors(FileInterceptor('file', UPLOAD_LIMITS))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, note: { type: 'string' } } } })
  @ApiOperation({ summary: '유전체 오더 문서 첨부(수탁 PDF 결과지·이미지, ≤20MB)' })
  async addGenomicAttachment(
    @Param('genomicOrderId') genomicOrderId: string,
    @UploadedFile() file: UploadedFileLike,
    @Body('note') note: string | undefined,
    @CurrentUser() user: AuthUser,
  ) {
    return { data: await this.service.addAttachment({ genomicOrderId }, file, note, user?.userId) };
  }

  @Get('genomic/:genomicOrderId/attachments')
  @UseGuards(RolesGuard)
  @Roles(...GEN_ATTACH_READ_ROLES)
  @ApiOperation({ summary: '유전체 오더 첨부 목록(메타데이터)' })
  async listGenomicAttachments(@Param('genomicOrderId') genomicOrderId: string) {
    return { data: await this.service.listAttachments({ genomicOrderId }) };
  }

  // ── 수혈 이상반응 첨부(이상반응 조사서·외부검사 결과지) ──
  @Post('transfusion-reactions/:reactionId/attachments')
  @UseGuards(RolesGuard)
  @Roles(...BB_ATTACH_WRITE_ROLES)
  @UseInterceptors(FileInterceptor('file', UPLOAD_LIMITS))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, note: { type: 'string' } } } })
  @ApiOperation({ summary: '수혈 이상반응 문서 첨부(조사서·외부검사 PDF·이미지, ≤20MB)' })
  async addReactionAttachment(@Param('reactionId') reactionId: string, @UploadedFile() file: UploadedFileLike, @Body('note') note: string | undefined, @CurrentUser() user: AuthUser) {
    return { data: await this.service.addAttachment({ reactionId }, file, note, user?.userId) };
  }

  @Get('transfusion-reactions/:reactionId/attachments')
  @UseGuards(RolesGuard)
  @Roles(...BB_ATTACH_READ_ROLES)
  @ApiOperation({ summary: '수혈 이상반응 첨부 목록' })
  async listReactionAttachments(@Param('reactionId') reactionId: string) {
    return { data: await this.service.listAttachments({ reactionId }) };
  }

  // ── EQA 서베이 첨부(외부 정도관리 성적서) ──
  @Post('eqa/:eqaId/attachments')
  @UseGuards(RolesGuard)
  @Roles(...EQA_ATTACH_WRITE_ROLES)
  @UseInterceptors(FileInterceptor('file', UPLOAD_LIMITS))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, note: { type: 'string' } } } })
  @ApiOperation({ summary: 'EQA 외부 정도관리 성적서 첨부(PDF·이미지, ≤20MB)' })
  async addEqaAttachment(@Param('eqaId') eqaId: string, @UploadedFile() file: UploadedFileLike, @Body('note') note: string | undefined, @CurrentUser() user: AuthUser) {
    return { data: await this.service.addAttachment({ eqaId }, file, note, user?.userId) };
  }

  @Get('eqa/:eqaId/attachments')
  @UseGuards(RolesGuard)
  @Roles(...EQA_ATTACH_READ_ROLES)
  @ApiOperation({ summary: 'EQA 첨부 목록' })
  async listEqaAttachments(@Param('eqaId') eqaId: string) {
    return { data: await this.service.listAttachments({ eqaId }) };
  }

  // ── 법정감염병 신고 첨부(보건소 신고 서류 스캔/사진 — 완료 근거) ──
  @Post('notifiable/:reportId/attachments')
  @UseGuards(RolesGuard)
  @Roles(...ATTACH_WRITE_ROLES)
  @UseInterceptors(FileInterceptor('file', UPLOAD_LIMITS))
  @ApiConsumes('multipart/form-data')
  @ApiBody({ schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, note: { type: 'string' } } } })
  @ApiOperation({ summary: '법정감염병 신고 서류 첨부(스캔/사진, PDF·이미지, ≤20MB)' })
  async addReportAttachment(@Param('reportId') reportId: string, @UploadedFile() file: UploadedFileLike, @Body('note') note: string | undefined, @CurrentUser() user: AuthUser) {
    return { data: await this.service.addAttachment({ reportId }, file, note, user?.userId) };
  }

  @Get('notifiable/:reportId/attachments')
  @UseGuards(RolesGuard)
  @Roles(...ATTACH_READ_ROLES)
  @ApiOperation({ summary: '법정감염병 신고 첨부 목록' })
  async listReportAttachments(@Param('reportId') reportId: string) {
    return { data: await this.service.listAttachments({ reportId }) };
  }

  @Get('attachments/:attachmentId/download')
  @UseGuards(RolesGuard)
  @Roles(...ATTACH_ANY_READ_ROLES) // 1차 가드(넓게) — 실제 도메인 격리는 서비스가 레코드 기준으로 재검증
  @ApiOperation({ summary: '첨부 원본 다운로드/미리보기' })
  async downloadAttachment(@Param('attachmentId') attachmentId: string, @Res() res: Response, @CurrentUser() user: AuthUser) {
    const a = await this.service.getAttachment(attachmentId, user?.roles ?? []);
    res.setHeader('Content-Type', a.mimeType);
    res.setHeader('Content-Length', a.sizeBytes);
    // 이미지·PDF는 미리보기(inline), 안전한 파일명 인코딩
    res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(a.filename)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.end(a.data);
  }

  @Delete('attachments/:attachmentId')
  @UseGuards(RolesGuard)
  @Roles(...ATTACH_ANY_WRITE_ROLES) // 1차 가드(넓게) — 도메인별 삭제 권한은 서비스가 재검증
  @ApiOperation({ summary: '첨부 삭제' })
  async deleteAttachment(@Param('attachmentId') attachmentId: string, @CurrentUser() user: AuthUser) {
    return { data: await this.service.deleteAttachment(attachmentId, user?.roles ?? []) };
  }
}
