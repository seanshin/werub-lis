/**
 * Integration (HL7 연계) HTTP 컨트롤러 — 라우트 1개 (`api/v1/integration/hl7/reflex/webhook`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Post, Body, Headers } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { ApiTags, ApiOperation, ApiHeader } from '@nestjs/swagger';
import { IntegrationService } from './integration.service';
import { IsString, IsOptional, IsArray, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

class WebhookIdentifierDto {
  @IsOptional() @IsString() system?: string;
  @IsOptional() @IsString() value?: string;
}
class ReflexCallbackDto {
  @IsOptional() @IsString() id?: string;
  @IsOptional() @IsString() mcid?: string;
  @IsOptional() @IsArray() @ValidateNested({ each: true }) @Type(() => WebhookIdentifierDto) identifier?: WebhookIdentifierDto[];
  @IsOptional() @IsString() status?: string;
}

/**
 * [R-5 대안] Reflex PreOrder 승인/거절 웹훅 수신 (HIS→LIS push).
 * JWT 미적용(HIS 서버가 호출) — 대신 `x-reflex-webhook-token` 공유 시크릿으로 게이트.
 * HIS_REFLEX_WEBHOOK_TOKEN 미설정 시 503(비활성) — R-5가 웹훅으로 확정될 때만 켜짐.
 * 폴링 경로(`/reflex/poll-preorders`)와 상호 배타 아님(둘 다 동일 매핑 적용, 멱등).
 */
@ApiTags('Integration (HL7 연계)')
// 면제 사유: HIS 서버가 호출하므로 JWT 미적용. 대신 x-reflex-webhook-token 공유 시크릿으로 게이트하며
//   토큰 미설정 시 503(fail-closed)·비교는 상수시간. 아래 컨트롤러 주석 참조.
@Public()
@Controller('api/v1/integration/hl7/reflex/webhook')
export class ReflexWebhookController {
  constructor(private readonly service: IntegrationService) {}

  @Post()
  @ApiHeader({ name: 'x-reflex-webhook-token', description: '공유 시크릿(HIS_REFLEX_WEBHOOK_TOKEN)' })
  @ApiOperation({ summary: 'Reflex PreOrder 승인/거절 웹훅(HIS→LIS push, 토큰 게이트)' })
  async callback(
    @Headers('x-reflex-webhook-token') token: string,
    @Body() body: ReflexCallbackDto,
  ) {
    return { data: await this.service.applyReflexCallback(token, body) };
  }
}
