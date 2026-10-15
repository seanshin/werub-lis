/**
 * NGS (종양 시퀀싱 Run/QC·체세포 소견) HTTP 컨트롤러 — 라우트 11개 (`api/v1/ngs`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: 역할 게이트(LisRole.GEN, LisRole.ADM).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Post, Delete, Param, Body, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NgsService } from './ngs.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { LisRole } from '../../common/rbac/roles';
import { IsString, IsOptional, IsIn, IsNumber, Min, Max, IsArray } from 'class-validator';

class CreateRunDto {
  @IsString() runName!: string;
  @IsOptional() @IsString() flowcell?: string;
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) specimenNos?: string[];
  @IsOptional() @IsString() panelCode?: string;
}
class CompleteRunDto {
  @IsOptional() @IsIn(['RUNNING', 'COMPLETE', 'FAILED']) status?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) q30?: number;
  @IsOptional() @IsNumber() @Min(0) totalReads?: number;
  @IsOptional() @IsNumber() @Min(0) meanCoverage?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(100) uniformityPct?: number;
}
class AddFindingDto {
  @IsOptional() @IsString() runId?: string;
  @IsOptional() @IsString() genomicOrderId?: string;
  @IsIn(['VARIANT', 'FUSION', 'CNV', 'TMB', 'MSI']) category!: string;
  @IsOptional() @IsString() gene?: string;
  @IsOptional() @IsString() alteration?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) vaf?: number; // 서비스가 분율(0~1)·백분율 모두 수용
  @IsOptional() @IsIn(['TIER_I', 'TIER_II', 'TIER_III', 'TIER_IV']) tier?: string; // AMP/ASCO/CAP
  @IsOptional() @IsString() therapy?: string;
  @IsOptional() @IsString() note?: string;
}

class UpsertNgsPanelDto {
  @IsString() panelCode!: string;
  @IsString() name!: string;
  @IsOptional() @IsString() platform?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) q30Min?: number | null;
  @IsOptional() @IsNumber() @Min(0) meanCoverageMin?: number | null;
  @IsOptional() @IsNumber() @Min(0) @Max(100) uniformityMin?: number | null;
  @IsOptional() @IsString() note?: string;
}

@ApiTags('NGS (종양 시퀀싱 Run/QC·체세포 소견)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(LisRole.GEN, LisRole.ADM)
@Controller('api/v1/ngs')
export class NgsController {
  constructor(private readonly service: NgsService) {}

  @Get('panels')
  @ApiOperation({ summary: 'NGS 패널 목록(패널별 QC 임계) — 미등록 패널은 기본 임계로 판정' })
  async listPanels() {
    return { data: await this.service.listPanels() };
  }

  @Post('panels')
  @ApiOperation({ summary: 'NGS 패널 등록·수정(Q30·coverage·uniformity 임계)' })
  async upsertPanel(@Body() body: UpsertNgsPanelDto, @Req() req: { user?: { userId?: string } }) {
    return { data: await this.service.upsertPanel(body, req.user?.userId ?? null) };
  }

  @Get('runs')
  @ApiOperation({ summary: 'NGS 런 목록' })
  async listRuns() {
    return { data: await this.service.listRuns() };
  }

  @Post('runs')
  @ApiOperation({ summary: 'NGS 런 생성' })
  async createRun(@Body() body: CreateRunDto) {
    return { data: await this.service.createRun(body) };
  }

  @Get('runs/:runId')
  @ApiOperation({ summary: 'NGS 런 상세(QC·소견 포함)' })
  async getRun(@Param('runId') runId: string) {
    return { data: await this.service.getRun(runId) };
  }

  @Post('runs/:runId/complete')
  @ApiOperation({ summary: '런 QC 확정(Q30·reads·커버리지·균일도) → COMPLETE/FAILED' })
  async complete(@Param('runId') runId: string, @Body() body: CompleteRunDto) {
    return { data: await this.service.completeRun(runId, body) };
  }

  @Get('runs/:runId/patients')
  @ApiOperation({ summary: '런에 올린 검체의 환자 — 소견을 누구에게 보고하는지' })
  async runPatients(@Param('runId') runId: string) {
    return { data: await this.service.runPatients(runId) };
  }

  @Delete('findings/:findingId')
  @ApiOperation({ summary: '체세포 소견 삭제(오등록 정정)' })
  async deleteFinding(@Param('findingId') findingId: string) {
    return { data: await this.service.deleteFinding(findingId) };
  }

  @Post('runs/:runId/vcf')
  @ApiOperation({ summary: 'VCF 소견 자동 등록 — VCF의 GENE·AF로 체세포 VARIANT 소견 생성(HGVS·tier는 판독자 정련)' })
  async ingestVcf(@Param('runId') runId: string, @Body() body: { vcf: string }) {
    return { data: await this.service.ingestVcf(runId, body.vcf) };
  }

  @Post('tier-suggest')
  @ApiOperation({ summary: '체세포 변이 tier 제안(DRAFT·미기록) — 근거 DB(OncoKB)로 AMP/ASCO tier·표적치료 초안. 확정은 판독자' })
  async tierSuggest(@Body() body: { gene?: string; alteration?: string }) {
    return { data: await this.service.suggestTier(body.gene, body.alteration) };
  }

  @Post('findings')
  @ApiOperation({ summary: '체세포 소견 등록(변이/융합/CNV/TMB/MSI·tier)' })
  async addFinding(@Body() body: AddFindingDto) {
    return { data: await this.service.addFinding(body) };
  }
}
