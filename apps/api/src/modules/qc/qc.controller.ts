/**
 * QC (정도관리) HTTP 컨트롤러 — 라우트 7개 (`api/v1/qc`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: 역할 게이트(LisRole.TEC, LisRole.PHY, LisRole.ADM).
 * ⚠ 서명·검증 주체는 요청 본문이 아니라 @CurrentUser(JWT)에서 얻는다 — 클라이언트 위조 방지.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Post, Get, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNumber, IsOptional, IsIn, IsArray } from 'class-validator';
import { QcService } from './qc.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { LisRole } from '../../common/rbac/roles';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { QC_REVIEW_VERDICTS } from '../../domain/enums';

class SubmitQcDto {
  @IsString() qcCode!: string;
  @IsString() instrument!: string;
  @IsString() testCode!: string;
  @IsNumber() value!: number;
  @IsOptional() @IsString() lot?: string;
}

class LotCrossoverDto {
  @IsString() qcCode!: string;
  @IsString() instrument!: string;
  @IsString() testCode!: string;
  @IsString() lot!: string;
  @IsOptional() @IsArray() values?: number[];
  @IsOptional() @IsNumber() mean?: number;
  @IsOptional() @IsNumber() sd?: number;
}

class QcReviewDto {
  @IsString() period!: string; // YYYY-MM
  @IsOptional() @IsString() scope?: string;
  @IsOptional() @IsString() instrument?: string;
  @IsIn(QC_REVIEW_VERDICTS as unknown as string[]) verdict!: string;
  @IsOptional() @IsString() note?: string;
}

@ApiTags('QC (정도관리)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(LisRole.TEC, LisRole.PHY, LisRole.ADM)
@Controller('api/v1/qc')
export class QcController {
  constructor(private readonly service: QcService) {}

  @Post('results')
  @ApiOperation({ summary: 'QC 측정 등록 + Westgard 판정(로트별)' })
  async submit(@Body() body: SubmitQcDto) {
    return { data: await this.service.submitQc(body) };
  }

  @Post('lot-crossover')
  @ApiOperation({ summary: 'QC 로트 크로스오버 — 신로트 목표(mean/SD) 확립(평행검사값 또는 직접지정)' })
  async lotCrossover(@Body() body: LotCrossoverDto) {
    return { data: await this.service.establishLotTarget(body) };
  }

  @Get('status')
  @ApiOperation({ summary: '당일 검사 QC 상태(결과 확정 차단 여부)' })
  async status(@Query('testCode') testCode: string) {
    return { data: await this.service.getStatus(testCode) };
  }

  @Get('results')
  @ApiOperation({ summary: 'QC 측정 로그 — 최근 측정 목록(값·판정·로트, 검사·장비·기간·판정 필터)' })
  async results(
    @Query('testCode') testCode?: string,
    @Query('instrument') instrument?: string,
    @Query('verdict') verdict?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    return { data: await this.service.listResults({ testCode, instrument, verdict, from, to, limit: limit ? Number(limit) : undefined }) };
  }

  @Get('monthly-summary')
  @ApiOperation({ summary: '월간 QC 요약(verdict 집계·리뷰 상태) — 월간 리뷰 근거' })
  async monthly(@Query('period') period: string, @Query('testCode') testCode?: string, @Query('instrument') instrument?: string) {
    return { data: await this.service.monthlySummary(period, testCode, instrument) };
  }

  @Post('review')
  @ApiOperation({ summary: '월간 QC 리뷰 사인오프(감독자 검토·승인) — 인증 요건' })
  async review(@Body() body: QcReviewDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.recordReview({ ...body, reviewedBy: user.userId }) };
  }

  @Get('reviews')
  @ApiOperation({ summary: 'QC 리뷰 목록' })
  async reviews(@Query('period') period?: string) {
    return { data: await this.service.listReviews(period) };
  }
}
