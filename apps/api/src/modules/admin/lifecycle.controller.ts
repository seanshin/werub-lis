/**
 * Admin · Lifecycle (데이터 수명주기) HTTP 컨트롤러 — 라우트 2개 (`api/v1/admin/lifecycle`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: 역할 게이트(LisRole.ADM).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { LifecycleService } from './lifecycle.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { LisRole } from '../../common/rbac/roles';

@ApiTags('Admin · Lifecycle (데이터 수명주기)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(LisRole.ADM)
@Controller('api/v1/admin/lifecycle')
export class LifecycleController {
  constructor(private readonly service: LifecycleService) {}

  @Get('status')
  @ApiOperation({ summary: '보존정책 현황(전체·경과 건수)' })
  async status() {
    return { data: await this.service.status() };
  }

  @Post('purge')
  @ApiOperation({ summary: '보존기간 경과 운영로그 정리(dryRun 기본, ?dryRun=false로 실삭제)' })
  async purge(@Query('dryRun') dryRun?: string, @CurrentUser() user?: AuthUser) {
    return { data: await this.service.purge(dryRun !== 'false', user?.userId ?? null) };
  }
}
