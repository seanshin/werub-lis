/**
 * Master (마스터 관리) HTTP 컨트롤러 — 라우트 19개 (`api/v1/master`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: F-MST:R, F-MST:W, F-RES:R.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Post, Patch, Put, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { MasterService } from './master.service';
import {
  CreateTestDto,
  UpdateTestDto,
  UpsertReferenceRangeDto,
  UpsertCodeMappingDto,
  UpsertPanelDto,
  UpsertQcMaterialDto,
  UpsertQcTargetDto,
} from './dto/master.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Feature, Access } from '../../common/rbac/roles';
import { IsArray, ArrayNotEmpty, ArrayMaxSize, ValidateNested, IsOptional, IsString, IsIn, IsBoolean, MaxLength } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * 마스터 관리 API — 조회는 F-MST:R(TEC/ADM/AUD), 변경은 F-MST:W(ADM).
 * 기획 22 §6-3 (P1). 변경 전건은 AuditInterceptor가 자동 기록.
 */
class BulkCodeMappingRowDto {
  @IsOptional() @IsString() lisCode?: string;
  @IsOptional() @IsString() hisCode?: string;
  @IsOptional() @IsString() loinc?: string;
  @IsOptional() @IsString() ediCode?: string;
  @IsOptional() @IsIn(['USE', 'STOP']) status?: string;
}
class BulkCodeMappingDto {
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => BulkCodeMappingRowDto) rows!: BulkCodeMappingRowDto[];
}

/**
 * 결과항목 반입 행 — 인라인 타입이면 ValidationPipe가 붙지 않아 비문자열·초장문이
 * 그대로 마스터로 흘러들었다(2026-07-30 보안 검토). 코드류는 서비스에서 CODE_ID_PATTERN으로
 * 한 번 더 검증하고, 여기서는 타입·길이를 막는다.
 */
class BulkResultItemRowDto {
  @IsOptional() @IsString() @MaxLength(40) ediCode?: string;
  @IsOptional() @IsString() @MaxLength(40) testCode?: string;
  @IsOptional() @IsString() @MaxLength(200) name?: string;
  @IsOptional() @IsString() @MaxLength(40) loinc?: string;
  @IsOptional() @IsString() @MaxLength(100) specimenType?: string;
  @IsOptional() @IsString() @MaxLength(200) panelName?: string;
}
class BulkResultItemsDto {
  @IsArray() @ArrayNotEmpty() @ArrayMaxSize(20000) @ValidateNested({ each: true }) @Type(() => BulkResultItemRowDto) rows!: BulkResultItemRowDto[];
  @IsOptional() @IsBoolean() createTests?: boolean;
}

@ApiTags('Master (마스터 관리)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('api/v1/master')
export class MasterController {
  constructor(private readonly service: MasterService) {}

  // ── 검사항목 ──
  @Get('tests')
  @RequirePermission(Feature.MST, Access.R)
  @ApiOperation({ summary: '검사항목 목록(도메인 필터)' })
  async listTests(@Query('domain') domain?: string) {
    return { data: await this.service.listTests(domain) };
  }

  @Post('tests')
  @RequirePermission(Feature.MST, Access.W)
  @ApiOperation({ summary: '검사항목 등록' })
  async createTest(@Body() body: CreateTestDto) {
    return { data: await this.service.createTest(body) };
  }

  @Post('seed-derived-tests')
  @RequirePermission(Feature.MST, Access.W)
  @ApiOperation({ summary: '계산검사(eGFR·LDL·anion gap·보정칼슘) 입력·출력 검사+참고치 멱등 시딩' })
  async seedDerived() {
    return { data: await this.service.seedDerivedTests() };
  }

  @Patch('tests/:testCode')
  @RequirePermission(Feature.MST, Access.W)
  @ApiOperation({ summary: '검사항목 수정(명칭·LOINC·단위·상태)' })
  async updateTest(@Param('testCode') testCode: string, @Body() body: UpdateTestDto) {
    return { data: await this.service.updateTest(testCode, body) };
  }

  // ── 참고치 ──
  @Get('tests/:testCode/reference-ranges')
  @RequirePermission(Feature.MST, Access.R)
  @ApiOperation({ summary: '검사항목별 참고치 목록' })
  async listRR(@Param('testCode') testCode: string) {
    return { data: await this.service.listReferenceRanges(testCode) };
  }

  @Post('reference-ranges')
  @RequirePermission(Feature.MST, Access.W)
  @ApiOperation({ summary: '참고치 등록(성별·연령 구간·정상/위험치)' })
  async createRR(@Body() body: UpsertReferenceRangeDto) {
    return { data: await this.service.createReferenceRange(body) };
  }

  @Patch('reference-ranges/:rrId')
  @RequirePermission(Feature.MST, Access.W)
  @ApiOperation({ summary: '참고치 수정' })
  async updateRR(@Param('rrId') rrId: string, @Body() body: UpsertReferenceRangeDto) {
    return { data: await this.service.updateReferenceRange(rrId, body) };
  }

  @Delete('reference-ranges/:rrId')
  @RequirePermission(Feature.MST, Access.W)
  @ApiOperation({ summary: '참고치 삭제' })
  async deleteRR(@Param('rrId') rrId: string) {
    return { data: await this.service.deleteReferenceRange(rrId) };
  }

  // ── 코드매핑 ──
  @Get('code-mappings')
  @RequirePermission(Feature.MST, Access.R)
  @ApiOperation({ summary: 'HIS/LOINC/EDI 코드매핑 목록' })
  async listCM() {
    return { data: await this.service.listCodeMappings() };
  }

  @Put('code-mappings/:lisCode')
  @RequirePermission(Feature.MST, Access.W)
  @ApiOperation({ summary: '코드매핑 등록·수정(upsert)' })
  async upsertCM(@Param('lisCode') lisCode: string, @Body() body: UpsertCodeMappingDto) {
    return { data: await this.service.upsertCodeMapping(lisCode, body) };
  }

  @Post('code-mappings/bulk')
  @RequirePermission(Feature.MST, Access.W)
  @ApiOperation({ summary: 'HIS/EDI 코드매핑 대량 반입(CSV rows) — 멱등 upsert, 오류행 보고. ?dryRun=1이면 미적용·차이만 반환' })
  async bulkCM(@Body() body: BulkCodeMappingDto, @Query('dryRun') dryRun?: string) {
    return { data: await this.service.bulkImportCodeMappings(body?.rows ?? [], dryRun === '1' || dryRun === 'true') };
  }

  @Post('billing-edi/resync')
  @RequirePermission(Feature.MST, Access.W)
  @ApiOperation({ summary: '미청구 항목 EDI코드 재동기화(D5) — 실 수가코드 적재 후 캡처 스냅샷 현행화(CLAIMED은 근거 보존)' })
  async resyncBillingEdi() {
    return { data: await this.service.resyncBillingEdiCodes() };
  }

  @Post('result-items/bulk')
  @RequirePermission(Feature.MST, Access.W)
  @ApiOperation({ summary: '결과항목 EDI 반입 — 동일 edi_code 그룹으로 코드매핑+패널 자동구성(HIS 확정 구조)' })
  async bulkResultItems(@Body() body: BulkResultItemsDto) {
    return { data: await this.service.bulkImportResultItems(body?.rows ?? [], !!body?.createTests) };
  }

  // ── 패널 ──
  @Get('panels')
  @RequirePermission(Feature.MST, Access.R)
  @ApiOperation({ summary: '패널(묶음검사) 목록' })
  async listPanels() {
    return { data: await this.service.listPanels() };
  }

  @Put('panels')
  @RequirePermission(Feature.MST, Access.W)
  @ApiOperation({ summary: '패널 등록·구성항목 교체(upsert)' })
  async upsertPanel(@Body() body: UpsertPanelDto) {
    return { data: await this.service.upsertPanel(body) };
  }

  /**
   * 구성 설명(UX 기획 §2-5) — "이 값·이 목록이 무엇으로 이루어졌는가"를 화면이 팝오버로 보여준다.
   * 패널 전개·계산검사 산출식·검사 단위/참고치를 한 번에 반환(화면이 여러 API를 조합하지 않게).
   */
  @Get('explain/:kind/:id')
  // ★MST(마스터 관리)가 아니라 RES(결과) 읽기 권한 — 이 설명은 결과·검증·보고서 등 임상 화면
  //   어디서나 뜬다. MST를 요구하면 검증의(PHY)·미생물(MIC)이 403을 받아 팝오버가 죽는다(E2E가 잡음).
  //   내용(검사명·단위·참고치·패널 구성)은 이미 결과 화면에 노출되는 마스터 정보라 추가 노출이 없다.
  @RequirePermission(Feature.RES, Access.R)
  @ApiOperation({ summary: '구성 설명 — kind=panel|derived|test' })
  async explain(@Param('kind') kind: string, @Param('id') id: string) {
    return { data: await this.service.explain(kind, id) };
  }

  // ── QC 마스터 ──
  @Get('qc-targets')
  @RequirePermission(Feature.MST, Access.R)
  @ApiOperation({ summary: 'QC 목표치 목록' })
  async listQcTargets() {
    return { data: await this.service.listQcTargets() };
  }

  @Put('qc-materials')
  @RequirePermission(Feature.MST, Access.W)
  @ApiOperation({ summary: 'QC 물질 등록·수정(upsert)' })
  async upsertQcMaterial(@Body() body: UpsertQcMaterialDto) {
    return { data: await this.service.upsertQcMaterial(body) };
  }

  @Put('qc-targets')
  @RequirePermission(Feature.MST, Access.W)
  @ApiOperation({ summary: 'QC 목표치 등록·수정(장비·검사별 평균/SD)' })
  async upsertQcTarget(@Body() body: UpsertQcTargetDto) {
    return { data: await this.service.upsertQcTarget(body) };
  }
}
