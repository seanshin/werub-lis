/**
 * EQA (외부정도관리) HTTP 컨트롤러 — 라우트 4개 (`api/v1/eqa`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: 역할 게이트(LisRole.TEC, LisRole.PHY, LisRole.MIC, LisRole.ADM).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Post, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNumber, IsOptional } from 'class-validator';
import { EqaService } from './eqa.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { LisRole } from '../../common/rbac/roles';

class SubmitEqaDto {
  @IsString() program!: string;
  @IsString() cycle!: string;
  @IsString() testCode!: string;
  @IsString() sampleId!: string;
  @IsNumber() submittedValue!: number;
  @IsOptional() @IsString() submittedBy?: string;
}
class EvaluateEqaDto {
  @IsNumber() peerMean!: number;
  @IsNumber() peerSd!: number;
}

@ApiTags('EQA (외부정도관리)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(LisRole.TEC, LisRole.PHY, LisRole.MIC, LisRole.ADM)
@Controller('api/v1/eqa')
export class EqaController {
  constructor(private readonly service: EqaService) {}

  @Get()
  @ApiOperation({ summary: 'EQA 목록(프로그램·주기)' })
  async list(@Query('program') program?: string, @Query('cycle') cycle?: string) {
    return { data: await this.service.list(program, cycle) };
  }

  @Get('trend')
  @ApiOperation({ summary: 'SDI 추세 — 검사별 다주기 SDI 시계열·계통편향 감지' })
  async trend(@Query('program') program?: string, @Query('testCode') testCode?: string) {
    return { data: await this.service.sdiTrend(program, testCode) };
  }

  @Post()
  @ApiOperation({ summary: 'EQA 결과 제출(또래군 통계 전 PENDING)' })
  async submit(@Body() body: SubmitEqaDto) {
    return { data: await this.service.submit(body) };
  }

  @Post(':surveyId/evaluate')
  @ApiOperation({ summary: '또래군 통계 입력 → SDI·판정' })
  async evaluate(@Param('surveyId') surveyId: string, @Body() body: EvaluateEqaDto) {
    return { data: await this.service.evaluate(surveyId, body) };
  }
}
