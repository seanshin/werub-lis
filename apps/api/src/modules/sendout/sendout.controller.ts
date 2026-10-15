/**
 * Sendout (외부검사 위탁) HTTP 컨트롤러 — 라우트 6개 (`api/v1/sendout`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: F-SEND:R, F-SEND:W.
 * ⚠ 서명·검증 주체는 요청 본문이 아니라 @CurrentUser(JWT)에서 얻는다 — 클라이언트 위조 방지.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Post, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { SendoutService } from './sendout.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Feature, Access } from '../../common/rbac/roles';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { IsString, IsOptional } from 'class-validator';

class SendoutResultDto {
  @IsString() resultValue!: string;
  @IsOptional() @IsString() resultUnit?: string;
  @IsOptional() @IsString() note?: string;
}
class SendoutCancelDto {
  @IsOptional() @IsString() reason?: string;
}

@ApiTags('Sendout (외부검사 위탁)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('api/v1/sendout')
export class SendoutController {
  constructor(private readonly service: SendoutService) {}

  @Get()
  @RequirePermission(Feature.SEND, Access.R)
  @ApiOperation({ summary: '위탁 목록 — 미회신 기본, 기간(from/to·의뢰일) 지정 시 회신분 포함' })
  async list(@Query('status') status?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.service.list(status, from, to) };
  }

  @Get('specimen/:specimenNo')
  @RequirePermission(Feature.SEND, Access.R)
  @ApiOperation({ summary: '검체별 위탁 이력' })
  async bySpecimen(@Param('specimenNo') specimenNo: string) {
    return { data: await this.service.listBySpecimen(specimenNo) };
  }

  @Post()
  @RequirePermission(Feature.SEND, Access.W)
  @ApiOperation({ summary: '외부검사 위탁 의뢰 등록' })
  async request(@Body() body: { specimenNo: string; testCode: string; referralLab: string; note?: string }, @CurrentUser() user: AuthUser) {
    return { data: await this.service.request({ ...body, requestedBy: user.userId }) };
  }

  @Post(':sendoutId/sent')
  @RequirePermission(Feature.SEND, Access.W)
  @ApiOperation({ summary: '위탁 발송 처리(REQUESTED→SENT)' })
  async sent(@Param('sendoutId') sendoutId: string) {
    return { data: await this.service.markSent(sendoutId) };
  }

  @Post(':sendoutId/result')
  @RequirePermission(Feature.SEND, Access.W)
  @ApiOperation({ summary: '위탁 결과 회신 기록(SENT→RESULTED)' })
  async result(@Param('sendoutId') sendoutId: string, @Body() body: SendoutResultDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.recordResult(sendoutId, { ...body, resultedBy: user.userId }) };
  }

  /**
   * 미발송 노화 점검 수동 실행 — 크론(매일 09:00)과 같은 로직.
   * 크론만 두면 도입 직후·설정 변경 후 동작을 확인할 방법이 없다(다음 날까지 대기).
   * 운영에서도 "지금 한 번 보자"가 필요하다 — 폴링·청구 sweep과 같은 패턴.
   */
  @Post('stale-check')
  @RequirePermission(Feature.SEND, Access.R)
  @ApiOperation({ summary: '미발송 위탁 노화 점검(수동) — 크론과 동일. 대상 있으면 알림 생성' })
  async staleCheck() {
    await this.service.staleSendoutAlert();
    return { data: { ran: true } };
  }

  @Post(':sendoutId/cancel')
  @RequirePermission(Feature.SEND, Access.W)
  @ApiOperation({ summary: '위탁 취소' })
  async cancel(@Param('sendoutId') sendoutId: string, @Body() body: SendoutCancelDto) {
    return { data: await this.service.cancel(sendoutId, body?.reason) };
  }
}
