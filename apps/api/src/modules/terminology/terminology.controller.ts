/**
 * Terminology (진단·SNOMED 코드 마스터) HTTP 컨트롤러 — 라우트 7개 (`api/v1/terminology`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: F-MST:R, F-MST:W.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Body, Controller, Get, Param, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength, IsArray, ArrayNotEmpty, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { TerminologyService } from './terminology.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Feature, Access } from '../../common/rbac/roles';
import { USE_STATUSES } from '../../domain/enums';

class UpsertTerminologyDto {
  @IsOptional() @IsIn(['SNOMED', 'ICD-O', 'LOCAL', 'snomed', 'icd-o', 'local']) system?: string;
  @IsString() @MaxLength(64) code!: string;
  @IsString() @MaxLength(255) term!: string;
  @IsOptional() @IsString() @MaxLength(255) termKo?: string;
  @IsOptional() @IsString() @MaxLength(32) category?: string;
  @IsOptional() @IsIn(['USE', 'STOP']) status?: string;
}

class EditTerminologyDto {
  @IsOptional() @IsString() system?: string;
  @IsOptional() @IsString() @MaxLength(64) code?: string;
  @IsOptional() @IsString() @MaxLength(255) term?: string;
  @IsOptional() @IsString() @MaxLength(255) termKo?: string;
  @IsOptional() @IsString() @MaxLength(32) category?: string;
  @IsOptional() @IsIn(['USE', 'STOP']) status?: string;
}

class BulkTerminologyDto {
  @IsArray() @ArrayNotEmpty() @ValidateNested({ each: true }) @Type(() => UpsertTerminologyDto) rows!: UpsertTerminologyDto[];
}
class SetStatusDto {
  @IsIn(USE_STATUSES as unknown as string[]) status!: string; // 이력 보존 — 하드삭제 없음
}

@ApiTags('Terminology (진단·SNOMED 코드 마스터)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('api/v1/terminology')
export class TerminologyController {
  constructor(private readonly service: TerminologyService) {}

  @Get()
  @ApiOperation({ summary: '코드 자동완성 검색(전 인증자 — 판독 입력 공용)' })
  async search(@Query('q') q?: string, @Query('system') system?: string, @Query('category') category?: string) {
    return { data: await this.service.search(q, system, category) };
  }

  @Get('list')
  @RequirePermission(Feature.MST, Access.R)
  @ApiOperation({ summary: '코드 관리 목록(전 상태)' })
  async list(@Query('system') system?: string, @Query('category') category?: string, @Query('status') status?: string, @Query('q') q?: string) {
    return { data: await this.service.list(system, category, status, q) };
  }

  @Post()
  @RequirePermission(Feature.MST, Access.W)
  @ApiOperation({ summary: '코드 등록' })
  async create(@Body() body: UpsertTerminologyDto, @Req() req: { user?: { userId?: string } }) {
    return { data: await this.service.create(body, req.user?.userId) };
  }

  @Post('seed-starter')
  @RequirePermission(Feature.MST, Access.W)
  @ApiOperation({ summary: '병리 대표 SNOMED 스타터셋 시딩(멱등)' })
  async seed(@Req() req: { user?: { userId?: string } }) {
    return { data: await this.service.seedStarter(req.user?.userId) };
  }

  @Post('bulk')
  @RequirePermission(Feature.MST, Access.W)
  @ApiOperation({ summary: '용어 코드 대량 반입(CSV rows) — KHIS SNOMED 정식셋 등, 멱등 upsert·오류행 보고' })
  async bulk(@Body() body: BulkTerminologyDto, @Req() req: { user?: { userId?: string } }) {
    return { data: await this.service.bulkImport(body?.rows ?? [], req.user?.userId) };
  }

  @Put(':codeId')
  @RequirePermission(Feature.MST, Access.W)
  @ApiOperation({ summary: '코드 수정' })
  async update(@Param('codeId') codeId: string, @Body() body: EditTerminologyDto) {
    return { data: await this.service.update(codeId, body) };
  }

  @Put(':codeId/status')
  @RequirePermission(Feature.MST, Access.W)
  @ApiOperation({ summary: '사용 중지/재개(하드 삭제 대신 상태 전환)' })
  async setStatus(@Param('codeId') codeId: string, @Body() body: SetStatusDto) {
    return { data: await this.service.setStatus(codeId, body?.status) };
  }
}
