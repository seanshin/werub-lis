/**
 * Barcode (바코드 스캔 설정) HTTP 컨트롤러 — 라우트 2개 (`api/v1/barcode/config`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: F-MST:W.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Put, Body, UseGuards, Req } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, Min, IsIn, MaxLength } from 'class-validator';
import { BarcodeService } from './barcode.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Feature, Access } from '../../common/rbac/roles';
import { AUTO_SUBMIT_MODES } from '../../domain/enums';

class UpdateBarcodeConfigDto {
  @IsOptional() @IsBoolean() trimWhitespace?: boolean;
  @IsOptional() @IsString() prefixStrip?: string;
  @IsOptional() @IsString() suffixStrip?: string;
  // 이 정규식은 저장 후 **모든 검사자 브라우저**에서 스캔 1건마다 실행된다(fetchBarcodeConfig).
  // 파국적 백트래킹 패턴(예: `(a+)+$`)이 저장되면 전 검사실 스캔이 동시에 멈추므로 길이를 제한하고,
  // 서비스 계층에서 컴파일·실행 시간을 검사한다.
  @IsOptional() @IsString() @MaxLength(64) stripPattern?: string;
  @IsOptional() @IsInt() @Min(0) minLength?: number;
  @IsOptional() @IsInt() @Min(0) maxLength?: number;
  @IsOptional() @IsIn(AUTO_SUBMIT_MODES as unknown as string[]) autoSubmit?: string;
  @IsOptional() @IsInt() @Min(1) autoSubmitLen?: number;
  @IsOptional() @IsInt() @Min(100) idleMs?: number;
  @IsOptional() @IsBoolean() beep?: boolean;
}

@ApiTags('Barcode (바코드 스캔 설정)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('api/v1/barcode/config')
export class BarcodeController {
  constructor(private readonly service: BarcodeService) {}

  @Get()
  @ApiOperation({ summary: '바코드 스캔 설정 조회(전 인증자 — 스캔 정규화 공용)' })
  async get() {
    return { data: await this.service.getConfig() };
  }

  @Put()
  @RequirePermission(Feature.MST, Access.W) // 설정 변경은 관리자(마스터)
  @ApiOperation({ summary: '바코드 스캔 설정 변경(정규화 규칙·스캔 동작)' })
  async update(@Body() body: UpdateBarcodeConfigDto, @Req() req: { user?: { userId?: string } }) {
    return { data: await this.service.updateConfig(body, req.user?.userId) };
  }
}
