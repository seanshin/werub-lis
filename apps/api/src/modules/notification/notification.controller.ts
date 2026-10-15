/**
 * Notification (알림) HTTP 컨트롤러 — 라우트 4개 (`api/v1/notifications`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: 역할 게이트(LisRole.RCP, LisRole.TEC, LisRole.PHY, LisRole.PAT, LisRole.).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Post, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationService } from './notification.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { LisRole } from '../../common/rbac/roles';

@ApiTags('Notification (알림)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
// 운영 알림(QC위반·내성균 등)은 임상 직무 열람 — 명시적 역할(default-allow 제거)
@Roles(LisRole.RCP, LisRole.TEC, LisRole.PHY, LisRole.PAT, LisRole.MIC, LisRole.BB, LisRole.GEN, LisRole.GC, LisRole.ADM, LisRole.AUD)
@Controller('api/v1/notifications')
export class NotificationController {
  constructor(private readonly service: NotificationService) {}

  @Get('badge')
  @ApiOperation({ summary: '미확인 건수(사이드바 배지 전용 — 개수만, PHI 없음)' })
  async badge() {
    return { data: await this.service.badgeCounts() };
  }

  @Get('pending')
  @ApiOperation({ summary: '미확인 알림 목록(QC위반·내성균 등 — 민감 유형은 역할 가시성 적용)' })
  async pending(@CurrentUser() user: AuthUser, @Query('ntype') ntype?: string) {
    return { data: await this.service.findPending(user.roles ?? [], ntype) };
  }

  @Get('history')
  @ApiOperation({ summary: '확인 처리된 알림 이력(최근 100 · 확인자는 감사로그 — 역할 가시성 적용)' })
  async history(@CurrentUser() user: AuthUser, @Query('ntype') ntype?: string) {
    return { data: await this.service.findHistory(user.roles ?? [], ntype) };
  }

  @Post(':notifyId/ack')
  @ApiOperation({ summary: '알림 확인' })
  async ack(@Param('notifyId') notifyId: string) {
    return { data: await this.service.ack(notifyId) };
  }
}
