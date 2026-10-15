/**
 * Admin · Go-Live (개시 전환 센터) HTTP 컨트롤러 — 라우트 5개 (`api/v1/admin/golive`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 인가: 역할 게이트(LisRole.ADM · 조회는 AUD 포함 — 감사자가 준비도를 봐야 한다).
 *
 * ⚠ **최종 승인은 여기 두지 않는다.** `api/v1/admin/golive/approve`는 UserAdminController가
 *   이미 점유하고 있어(같은 경로), 여기에 또 만들면 **먼저 등록된 쪽이 이겨 새 게이트가
 *   조용히 무시된다**(실측으로 겪음). 승인은 그 컨트롤러가 GoLiveService.approve를 호출한다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Body, Controller, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { GoLiveService } from './golive.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { LisRole } from '../../common/rbac/roles';

class SiteProfileDto {
  @IsString() @MaxLength(32) siteCode!: string;
  @IsOptional() @IsString() @MaxLength(100) siteName?: string;
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) capabilities!: string[];
  /** 개시 차단 항목을 제외하는 구성이면 사유 필수(NA와 같은 원칙). */
  @IsOptional() @IsString() @MaxLength(500) reason?: string;
}

class TaskStatusDto {
  @IsIn(['OPEN', 'DONE', 'NA']) status!: 'OPEN' | 'DONE' | 'NA';
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsString() @MaxLength(500) naReason?: string;
}

@ApiTags('Admin · Go-Live (개시 전환 센터)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(LisRole.ADM, LisRole.AUD)
@Controller('api/v1/admin/golive')
export class GoLiveController {
  constructor(private readonly service: GoLiveService) {}

  @Get('checklist')
  @ApiOperation({ summary: '개시 전환 체크리스트 — 사이트 프로파일에 맞는 항목만·자동 판정 포함' })
  async checklist() {
    return { data: await this.service.checklist() };
  }

  @Get('profile')
  @ApiOperation({ summary: '사이트 프로파일 조회(미설정이면 전 기능 활성으로 간주)' })
  async profile() {
    return { data: await this.service.profile() };
  }

  @Get('export')
  @ApiOperation({ summary: '준비도 내보내기 — 상태만(PHI 미포함). 원격 접속 없이 검수용' })
  async exportSnapshot() {
    return { data: await this.service.exportSnapshot() };
  }

  @Get('keys')
  @ApiOperation({ summary: '개시 필수 키 묶음 — 판정만(값 미반환). 입력은 /admin/settings' })
  async keys() {
    return { data: await this.service.keys() };
  }

  @Put('profile')
  @Roles(LisRole.ADM)
  @ApiOperation({ summary: '사이트 프로파일 저장 — capabilities에 없는 기능의 항목은 생성되지 않는다' })
  async saveProfile(@Body() body: SiteProfileDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.saveProfile(body, user?.userId ?? null) };
  }

  @Post('tasks/:code')
  @Roles(LisRole.ADM)
  @ApiOperation({ summary: '항목 상태 변경(수동 항목만 — 자동 판정 항목은 400). NA는 사유 필수' })
  async setStatus(@Param('code') code: string, @Body() body: TaskStatusDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.setStatus(code, body, user?.userId ?? null) };
  }
}
