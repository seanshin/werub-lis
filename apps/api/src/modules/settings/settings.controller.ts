/**
 * Admin · Settings (운영 설정) HTTP 컨트롤러 — 라우트 3개 (`api/v1/admin/settings`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: 역할 게이트(LisRole.ADM).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Body, Controller, Get, Param, Post, Put, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { SettingsService } from './settings.service';
import { NotifyChannelTester } from './notify-tester.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { LisRole } from '../../common/rbac/roles';

class SetSettingDto {
  @IsString() value!: string;
}

/**
 * 운영 설정 화면 API — ADM 전용.
 * 값은 마스킹해서 내보낸다(서명 키는 아예 안 내보낸다). 변경은 감사 체인에 남는다.
 */
@ApiTags('Admin · Settings (운영 설정)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(LisRole.ADM)
@Controller('api/v1/admin/settings')
export class SettingsController {
  constructor(
    private readonly service: SettingsService,
    private readonly tester: NotifyChannelTester,
  ) {}

  @Get()
  @ApiOperation({ summary: '운영 설정 목록(값은 마스킹·출처 DB/ENV 표시)' })
  async list() {
    return { data: await this.service.list() };
  }

  @Put(':key')
  @ApiOperation({ summary: '설정 저장(빈 값이면 해제) — 재기동 없이 즉시 반영' })
  async set(@Param('key') key: string, @Body() dto: SetSettingDto, @Req() req: { user?: { userId?: string } }) {
    return { data: await this.service.set(key, dto.value ?? '', req.user?.userId ?? null) };
  }

  /**
   * 테스트 발송 — 설정만 저장하고 끝내면 "넣었는데 실제로 도달하는지"를 개시일에야 안다.
   * 환자 정보는 싣지 않는다(합성 페이로드).
   */
  @Post('test/:channel')
  @ApiOperation({ summary: '통보 채널 테스트 발송(critical|ops) — 환자정보 없는 합성 페이로드' })
  async test(@Param('channel') channel: string, @Req() req: { user?: { userId?: string } }) {
    return { data: await this.tester.send(channel, req.user?.userId ?? null) };
  }
}
