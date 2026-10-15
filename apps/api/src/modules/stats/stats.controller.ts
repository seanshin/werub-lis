/**
 * Stats (통계·리포트) HTTP 컨트롤러 — 라우트 10개 (`api/v1/stats`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: F-STAT:R.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { StatsService } from './stats.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Feature, Access } from '../../common/rbac/roles';

/**
 * 통계·리포트 API — TAT·검사량·antibiogram·QC 차트·미보고. (기획 22 §6-5)
 * 권한: F-STAT:R (TEC/PHY/MIC/ADM/AUD).
 */
@ApiTags('Stats (통계·리포트)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('api/v1/stats')
export class StatsController {
  constructor(private readonly service: StatsService) {}

  @Get('tat')
  @RequirePermission(Feature.STAT, Access.R)
  @ApiOperation({ summary: 'TAT(접수→보고) 분포' })
  async tat(@Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.service.tat(from, to) };
  }

  @Get('volumes')
  @RequirePermission(Feature.STAT, Access.R)
  @ApiOperation({ summary: '검사량·재검률(도메인별)' })
  async volumes(@Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.service.volumes(from, to) };
  }

  @Get('workload')
  @RequirePermission(Feature.STAT, Access.R)
  @ApiOperation({ summary: '워크로드 — 직원별 결과입력·검증 건수(생산성)' })
  async workload(@Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.service.workload(from, to) };
  }

  @Get('section-tat')
  @RequirePermission(Feature.STAT, Access.R)
  @ApiOperation({ summary: '섹션(도메인)별 TAT 평균·중앙값' })
  async sectionTat(@Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.service.sectionTat(from, to) };
  }

  @Get('volume-trend')
  @RequirePermission(Feature.STAT, Access.R)
  @ApiOperation({ summary: '검사량 추세 — 일자별 결과 건수' })
  async volumeTrend(@Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.service.volumeTrend(from, to) };
  }

  @Get('antibiogram')
  @RequirePermission(Feature.STAT, Access.R)
  @ApiOperation({ summary: 'antibiogram(organism×antibiotic %S) + CSV — 전체 누적(기간 필터 미적용, cumulative)' })
  async antibiogram() {
    return { data: await this.service.antibiogram() };
  }

  @Get('qc-chart')
  @RequirePermission(Feature.STAT, Access.R)
  @ApiOperation({ summary: 'QC Levey-Jennings 시계열(z-score)' })
  async qcChart(
    @Query('qcCode') qcCode: string,
    @Query('instrument') instrument: string,
    @Query('testCode') testCode: string,
  ) {
    return { data: await this.service.qcChart(qcCode, instrument, testCode) };
  }

  @Get('transfusion')
  @RequirePermission(Feature.STAT, Access.R)
  @ApiOperation({ summary: '수혈 사용·폐기 통계 — C:T ratio·반납률·폐기·제제별 사용·재고(T3)' })
  async transfusion(@Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.service.transfusionStats(from, to) };
  }

  @Get('pathology-qa')
  @RequirePermission(Feature.STAT, Access.R)
  @ApiOperation({ summary: '병리 QA — 케이스량·개정률·동결 일치도·TAT·IHC/세포 볼륨(PP6)' })
  async pathologyQa(@Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.service.pathologyQa(from, to) };
  }

  @Get('pending')
  @RequirePermission(Feature.STAT, Access.R)
  @ApiOperation({ summary: '미보고·지연(검증 대기) 목록' })
  async pending(@Query('overdueHours') overdueHours?: string) {
    return { data: await this.service.pending(overdueHours ? Number(overdueHours) : 4) };
  }
}
