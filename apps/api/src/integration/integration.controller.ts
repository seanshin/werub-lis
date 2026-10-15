/**
 * Integration (HL7 연계) HTTP 컨트롤러 — 라우트 26개 (`api/v1/integration/hl7`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: 역할 게이트(LisRole.ADM).
 * ⚠ 서명·검증 주체는 요청 본문이 아니라 @CurrentUser(JWT)에서 얻는다 — 클라이언트 위조 방지.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Post, Get, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiBody, ApiProperty } from '@nestjs/swagger';
import { IsString, IsArray, IsOptional } from 'class-validator';
import { IntegrationService } from './integration.service';
import { IntegrationHealthService } from './integration-health.service';
import { LabCodeCatalogService } from './lab-code-catalog.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { LisRole } from '../common/rbac/roles';
import { CurrentUser, AuthUser } from '../common/decorators/current-user.decorator';

class InboundHl7Dto {
  @ApiProperty({ description: 'HL7 원문(세그먼트 구분 \\r)' })
  @IsString()
  message!: string;
}

class CutoverPreflightDto {
  @ApiProperty({ description: '실 병리번호 목록(accession ≤16 검증)', example: ['SP-2026-0456', 'C-2026-0042'], required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  spNos?: string[];

  @ApiProperty({ description: '실 PatientID 목록(PID-3 바이트 보존 검증)', example: ['00123456', '9-12345'], required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  patientIds?: string[];
}

class RetryHl7Dto {
  @ApiProperty({ description: '재적재할 로그ID 목록(생략 시 FAILED 전체)', required: false })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  logIds?: string[];
}

class RequeueDlqDto {
  @ApiProperty({ description: '특정 메시지제어ID만 재큐(생략 시 전체 DLQ)', required: false })
  @IsOptional()
  @IsString()
  mcid?: string;
}

@ApiTags('Integration (HL7 연계)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(LisRole.ADM) // 연계 운영은 관리자 (08 F-IF)
@Controller('api/v1/integration/hl7')
export class IntegrationController {
  constructor(
    private readonly service: IntegrationService,
    private readonly health: IntegrationHealthService,
    private readonly catalog: LabCodeCatalogService,
  ) {}

  @Get('health/monitor')
  @ApiOperation({ summary: '연계 운영 감시 지표(DLQ 적재·발신 정체·위험치 미전달)와 임계 판정' })
  async healthMonitor() {
    return { data: await this.health.status() };
  }

  @Post('inbound')
  @ApiOperation({ summary: '처방 수신(OML^O21) → 오더 생성, ACK 반환' })
  @ApiBody({
    schema: {
      example: {
        message:
          'MSH|^~\\&|HIS|HOSP|LIS|HOSP|20260712091500||OML^O21|MSG001|P|2.5.1\rPID|1||1234567^^^HOSP^MR||홍^길동||19800101|M\rORC|NW|H123\rOBR|1|H123||CBC^일반혈액^L|||20260712091500|||||||||||||||||R',
      },
    },
  })
  async inbound(@Body() body: InboundHl7Dto) {
    return { data: await this.service.processInbound(body.message) };
  }

  @Get('oru/:specimenNo')
  @ApiOperation({ summary: '결과 발신 ORU^R01 생성(검체 단위)' })
  async oru(@Param('specimenNo') specimenNo: string) {
    return { data: { message: await this.service.buildOruForSpecimen(specimenNo) } };
  }

  @Post('oru/:specimenNo/send-mllp')
  @ApiOperation({ summary: '결과 ORU를 HL7 MLLP로 실제 전송(HIS_MLLP_HOST/PORT)' })
  async sendMllp(@Param('specimenNo') specimenNo: string) {
    return { data: await this.service.sendResultViaMllp(specimenNo) };
  }

  @Get('fhir/:specimenNo')
  @ApiOperation({ summary: '결과 → FHIR DiagnosticReport 생성(HIS §B.3 형식)' })
  async fhir(@Param('specimenNo') specimenNo: string) {
    return { data: await this.service.buildFhirBundle(specimenNo) };
  }

  @Post('fhir/:specimenNo/send-his')
  @ApiOperation({ summary: '결과 DiagnosticReport를 HIS FHIR로 실제 전송(스테이징 큐)' })
  async sendHis(@Param('specimenNo') specimenNo: string) {
    return { data: await this.service.sendResultToHis(specimenNo) };
  }

  @Post('mwl/:spNo/send')
  @Roles(LisRole.PAT, LisRole.ADM) // 병리 판독의도 MWL 송신(임상 기능) — 클래스 ADM 제한 override
  @ApiOperation({ summary: '병리 오더 → PACS 모달리티 워크리스트(ORM^O01) 전송' })
  async sendMwl(@Param('spNo') spNo: string) {
    return { data: await this.service.sendPathologyWorklist(spNo) };
  }

  @Post('mwl/:spNo/cancel')
  @Roles(LisRole.PAT, LisRole.ADM) // 병리도 취소 트리거
  @ApiOperation({ summary: '병리 워크리스트 취소(ORC-1=CA) → PACS worklist CANCELLED' })
  async cancelMwl(@Param('spNo') spNo: string) {
    return { data: await this.service.cancelPathologyWorklist(spNo) };
  }

  @Post('his/poll-orders')
  @ApiOperation({ summary: 'HIS 검사 오더 폴링(수동 트리거) — ServiceRequest(LAB)→LIS 오더 생성' })
  async pollHis() {
    return { data: await this.service.pollHisOrders() };
  }

  @Post('his/lab-codes/import')
  @Roles(LisRole.ADM)
  @ApiOperation({ summary: 'HIS 검사코드 카탈로그 반입(H1) — 전량 또는 증분(?incremental=1). 페이징 정확성 자체 검증' })
  async importLabCodes(@Query('incremental') incremental?: string) {
    return { data: await this.catalog.importCatalog({ incremental: incremental === '1' || incremental === 'true' }) };
  }

  @Get('his/lab-codes/coverage')
  @ApiOperation({ summary: '카탈로그 대비 LIS 매핑 커버리지 — 미적재 오더 건수 포함' })
  async labCodeCoverage() {
    return { data: await this.catalog.coverage() };
  }

  @Get('his/lab-codes/search')
  @ApiOperation({ summary: 'HIS 검사코드 검색(코드 접두·명칭) — 매핑 등록 보조' })
  async searchLabCodes(@Query('q') q?: string) {
    return { data: await this.catalog.search(q ?? '') };
  }

  @Get('his/dropped-orders')
  @ApiOperation({ summary: '미적재 HIS 오더 대기열(미매핑·환자불명) — 워터마크가 지나가 재폴링되지 않는 건' })
  async droppedOrders(@Query('take') take?: string) {
    return { data: await this.service.listDroppedOrders(take ? Number(take) : 100) };
  }

  @Post('his/dropped-orders/retry')
  @Roles(LisRole.ADM)
  @ApiOperation({ summary: '미적재 HIS 오더 재적재 — 코드매핑·환자정보 보정 후 실행' })
  async retryDropped() {
    return { data: await this.service.retryDroppedOrders() };
  }

  @Get('his/hl7-failed-orders')
  @ApiOperation({ summary: 'HL7 푸시(IF-03) 수신 실패 오더 — 재폴링이 없어 보정해도 저절로 안 들어오는 유실분' })
  async hl7FailedOrders(@Query('take') take?: string) {
    return { data: await this.service.listFailedHl7Orders(take ? Number(take) : 100) };
  }

  @Post('his/hl7-failed-orders/retry')
  @Roles(LisRole.ADM)
  @ApiOperation({ summary: 'HL7 푸시 실패 오더 재적재 — 코드매핑 보정 후 실행(logIds 생략 시 전체). 최초 수신과 동일 경로·멱등' })
  async retryHl7Failed(@Body() body: RetryHl7Dto) {
    return { data: await this.service.retryFailedHl7Orders({ logIds: body?.logIds }) };
  }

  @Get('logs')
  @ApiOperation({ summary: '최근 연계 로그(interface_log) — 연계 운영 콘솔' })
  async logs(@Query('direction') direction?: string, @Query('take') take?: string) {
    return { data: await this.service.recentLogs(direction, take ? Number(take) : 50) };
  }

  @Get('reflex/outbound')
  @ApiOperation({ summary: 'Reflex 양방향 오더 아웃바운드 현황(STAGED/발신/실패)' })
  async reflexOutbound() {
    return { data: await this.service.listReflexOutbound() };
  }

  @Post('reflex/flush')
  @ApiOperation({ summary: 'Reflex 양방향 오더 재발신 — STAGED/FAILED 일괄 HIS 발신(자격증명 수령 후 턴키)' })
  async reflexFlush() {
    return { data: await this.service.flushReflexOrders() };
  }

  @Post('reflex/poll-preorders')
  @ApiOperation({ summary: '[초안] Reflex PreOrder 승인상태 폴링 — HIS 의사 승인/반려 결과 반영' })
  async reflexPollPreOrders() {
    return { data: await this.service.pollReflexPreOrders() };
  }

  @Post('results/retry')
  @ApiOperation({ summary: '결과 발신 실패분 재시도 — HIS 다운 복구 후 유실 없이 재발신(FAILED, 임계 초과 시 DLQ)' })
  async resultsRetry() {
    return { data: await this.service.retryFailedResultSends() };
  }

  @Post('reflex/retry')
  @ApiOperation({ summary: 'Reflex 발신 실패분 수동 재시도 — FAILED만(임계 초과 시 DLQ)' })
  async reflexRetry() {
    return { data: await this.service.retryFailedOutbound() };
  }

  @Post('reflex/requeue-dlq')
  @ApiOperation({ summary: 'Reflex DLQ 재큐 — 격리 건을 FAILED로 복귀(사람 개입 후 재발신)' })
  async reflexRequeueDlq(@Body() body: RequeueDlqDto) {
    return { data: await this.service.requeueReflexDlq(body?.mcid) };
  }

  @Post('pacs/cutover-preflight')
  @ApiOperation({ summary: '컷오버 프리플라이트 — 실 병리번호·PID 즉석 검증(①accession ≤16, ②PID 바이트보존)' })
  @ApiBody({ schema: { example: { spNos: ['SP-2026-0456', 'SP-2026-10000'], patientIds: ['00123456', '9-12345', '100023456'] } } })
  cutoverPreflight(@Body() body: CutoverPreflightDto) {
    return { data: this.service.cutoverPreflight(body.spNos ?? [], body.patientIds ?? []) };
  }

  @Get('pacs/viewer-link/:spNo')
  @Roles(LisRole.PAT, LisRole.ADM) // 병리 판독의도 조회(임상 기능) — 클래스 ADM 제한 override
  @ApiOperation({ summary: '병리 PACS 뷰어 링크 조회(QIDO→UID→딥링크, P4)' })
  async viewerLink(@Param('spNo') spNo: string) {
    return { data: await this.service.getPathologyViewerLink(spNo) };
  }

  @Post('pacs/viewer-link/:spNo/confirm')
  @Roles(LisRole.PAT, LisRole.ADM)
  @ApiOperation({ summary: 'WSI 열람 종단 확인 기록(③) — viewer-link found 시 확인자·시각 기록' })
  async confirmViewer(@Param('spNo') spNo: string, @CurrentUser() user: AuthUser) {
    return { data: await this.service.confirmWsiView(spNo, user.userId) };
  }
}
