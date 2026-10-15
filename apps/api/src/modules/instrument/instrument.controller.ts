/**
 * Instrument (장비 인터페이스) HTTP 컨트롤러 — 라우트 4개 (`api/v1/instruments`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: F-MST:R, F-MST:W, F-RES:W.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Post, Put, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { InstrumentService } from './instrument.service';
import { IngestPayloadDto, UpsertInstrumentMappingDto } from './dto/instrument.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Feature, Access } from '../../common/rbac/roles';

/**
 * 장비 인터페이스 API — 자동 결과 수집(협조 업체) + 매핑·통신로그.
 * 수기·문서 경로(POST /results, valueConfirm·sourceDocRef)와 동일 파이프라인으로 수렴.
 */
@ApiTags('Instrument (장비 인터페이스)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('api/v1/instruments')
export class InstrumentController {
  constructor(private readonly service: InstrumentService) {}

  @Post(':code/results')
  @RequirePermission(Feature.RES, Access.W) // 결과 수집 = 검사자(TEC)/장비 서비스계정
  @ApiOperation({ summary: '장비 원시 결과 수집(ASTM/CSV) → 자동평가 파이프라인' })
  async ingest(@Param('code') code: string, @Body() body: IngestPayloadDto) {
    return { data: await this.service.ingest(code, body.format, body.payload) };
  }

  @Get('mappings')
  @RequirePermission(Feature.MST, Access.R)
  @ApiOperation({ summary: '장비코드→검사코드 매핑 목록' })
  async listMappings(@Query('instrument') instrument?: string) {
    return { data: await this.service.listMappings(instrument) };
  }

  @Put('mappings')
  @RequirePermission(Feature.MST, Access.W)
  @ApiOperation({ summary: '장비 매핑 등록·수정(upsert)' })
  async upsertMapping(@Body() body: UpsertInstrumentMappingDto) {
    return { data: await this.service.upsertMapping(body) };
  }

  @Get('logs')
  @RequirePermission(Feature.MST, Access.R)
  @ApiOperation({ summary: '장비 통신 로그(최근순)' })
  async logs() {
    return { data: await this.service.logs() };
  }
}
