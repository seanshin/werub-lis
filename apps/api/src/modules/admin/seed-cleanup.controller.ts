/**
 * Admin · Seed Cleanup (시드 정리) HTTP 컨트롤러 — 라우트 3개 (`api/v1/admin/seed-cleanup`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 인가: 역할 게이트(LisRole.ADM).
 *
 * ⚠ 삭제는 비가역이다. 미리보기(GET)로 건수를 확인하고, 그 응답의 `confirmPhrase`를
 *   그대로 실어야 실행된다. 실 환자 데이터가 있으면 서버가 거부한다(우회 수단 없음).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Body, Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsIn, IsString } from 'class-validator';
import { SeedCleanupService, CLEANABLE_BATCHES } from './seed-cleanup.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { LisRole } from '../../common/rbac/roles';

class SeedBackfillDto {
  /** 설치 가이드에 적힌 문구를 **사람이 직접** 입력한다(응답으로 돌려주지 않는다). */
  @IsString() confirmPhrase!: string;
  /** 백필도 2인 승인 대상 — 실 데이터를 '시드'로 만드는 조작이라 정리만큼 위험하다. */
  @IsString() approverId!: string;
}

class SeedCleanupRequestDto {
  @IsIn([...CLEANABLE_BATCHES]) batch!: string;
  /** 미리보기 응답의 confirmPhrase를 그대로 — 오클릭 방지. */
  @IsString() confirmPhrase!: string;
}

@ApiTags('Admin · Seed Cleanup (시드 정리)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(LisRole.ADM)
@Controller('api/v1/admin/seed-cleanup')
export class SeedCleanupController {
  constructor(private readonly service: SeedCleanupService) {}

  @Get('real-data')
  @ApiOperation({ summary: '실 환자 데이터 감지 — 시드로 등록되지 않은 환자·오더가 있는가' })
  async realData() {
    return { data: await this.service.detectRealData() };
  }

  @Get('preview')
  @ApiOperation({ summary: '정리 대상 미리보기(읽기 전용) — 엔티티별 건수·차단 여부·확인 문구' })
  async preview(@Query('batch') batch: string) {
    return { data: await this.service.preview(batch) };
  }

  @Get('backfill/preview')
  @ApiOperation({ summary: '백필 미리보기 — 추적 이전 데이터의 미등록 건수(읽기 전용)' })
  async backfillPreview() {
    return { data: await this.service.backfillPreview() };
  }

  @Post('backfill')
  @ApiOperation({ summary: '백필 실행 — 미등록 트랜잭션 행을 site-pilot으로 등록(삭제 없음). 확인 문구 필수' })
  async backfill(@Body() body: SeedBackfillDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.backfill(body.confirmPhrase, user?.userId ?? null, body.approverId) };
  }

  @Get('runs')
  @ApiOperation({ summary: '전환 실행 이력 — 비가역 작업의 전/후 스냅샷(차단된 시도 포함)' })
  async runs(@Query('limit') limit?: string) {
    return { data: await this.service.runs(Number(limit) || 50) };
  }

  @Get('requests')
  @ApiOperation({ summary: '승인 대기 중인 정리 요청 — 승인자가 무엇을 승인하는지 보고 결정한다' })
  async requests() {
    return { data: await this.service.pendingRequests() };
  }

  @Post('request')
  @ApiOperation({ summary: '① 정리 요청 — 실데이터·확인문구 통과 시 승인 대기 건 생성(실행하지 않는다)' })
  async request(@Body() body: SeedCleanupRequestDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.request(body.batch, body.confirmPhrase, user?.userId ?? null) };
  }

  @Post('approve/:runId')
  @ApiOperation({ summary: '② 승인·실행 — **승인자 본인 토큰**으로 호출. 요청자와 같으면 거부' })
  async approve(@Param('runId') runId: string, @CurrentUser() user: AuthUser) {
    return { data: await this.service.approveAndExecute(runId, user?.userId ?? null) };
  }
}
