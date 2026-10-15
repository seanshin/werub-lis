/**
 * Billing (청구 데이터 파운데이션) HTTP 컨트롤러 — 라우트 7개 (`api/v1/billing`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: F-BIL:R, F-BIL:W.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Post, Param, Query, Body, UseGuards } from '@nestjs/common';
import { IsOptional, IsString } from 'class-validator';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { BillingService } from './billing.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Feature, Access } from '../../common/rbac/roles';

class TransmitDto {
  @IsOptional() @IsString() orderId?: string;
}

@ApiTags('Billing (청구 데이터 파운데이션)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('api/v1/billing')
export class BillingController {
  constructor(private readonly service: BillingService) {}

  @Get('unbilled')
  @RequirePermission(Feature.BIL, Access.R)
  @ApiOperation({ summary: '미청구(CAPTURED) 목록' })
  async unbilled() {
    return { data: await this.service.unbilled() };
  }

  @Post('capture/:orderId')
  @RequirePermission(Feature.BIL, Access.W)
  @ApiOperation({ summary: '오더 확정결과 청구 대상 캡처(멱등)' })
  async capture(@Param('orderId') orderId: string) {
    return { data: await this.service.captureOrder(orderId) };
  }

  @Post('claim-batch')
  @RequirePermission(Feature.BIL, Access.W)
  @ApiOperation({ summary: '청구 배치 생성(stub — 심평원 EDI 파일은 규격 대기, 대상 집계만)' })
  async claimBatch(@Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.service.createClaimBatch(from, to) };
  }

  @Post('transmit')
  @RequirePermission(Feature.BIL, Access.W)
  @ApiOperation({ summary: 'ERP 청구 전송 — CAPTURED를 오더별 메시지(1메시지=1오더)로 HMAC 송신. 미구성 시 PENDING 스테이징' })
  async transmit(@Body() body: TransmitDto) {
    return { data: await this.service.transmit({ orderId: body?.orderId }) };
  }

  @Get('claims')
  @RequirePermission(Feature.BIL, Access.R)
  @ApiOperation({ summary: '청구 전송 상태 목록(반송 워크리스트 — status 필터)' })
  async claims(@Query('status') status?: string) {
    return { data: await this.service.listClaims(status) };
  }

  @Post('claims/:claimId/poll')
  @RequirePermission(Feature.BIL, Access.W)
  @ApiOperation({ summary: 'ERP 처리상태 폴링(GET .../lis/billing/{id}) — ACCEPTED/REJECTED 반영' })
  async poll(@Param('claimId') claimId: string) {
    return { data: await this.service.pollClaim(claimId) };
  }

  @Post('sweep')
  @RequirePermission(Feature.BIL, Access.W)
  @ApiOperation({ summary: '청구 전송 자율화 수동 실행 — PENDING 재전송 + SENT 폴링(크론과 동일). ERP 미구성이면 skip' })
  async sweep() {
    return { data: await this.service.sweep() };
  }
}
