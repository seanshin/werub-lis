/**
 * Audit (감사추적) HTTP 컨트롤러 — 라우트 4개 (`api/v1/audit`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: F-AUD:R.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Query, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { AuditService } from './audit.service';
import { AuditChainService } from './audit-chain.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Feature, Access } from '../../common/rbac/roles';

@ApiTags('Audit (감사추적)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('api/v1/audit')
export class AuditController {
  constructor(
    private readonly service: AuditService,
    private readonly chain: AuditChainService,
  ) {}

  @Get('verify')
  @RequirePermission(Feature.AUD, Access.R)
  @ApiOperation({ summary: '감사 해시체인 무결성 검증(변조·삭제·재정렬 탐지)' })
  async verify() {
    return { data: await this.chain.verify() };
  }

  @Get('summary')
  @RequirePermission(Feature.AUD, Access.R)
  @ApiOperation({ summary: '기간 요약 — 액션별·사용자별·실패·민감·심야 접근·일자별 추이' })
  async summary(@Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.service.summary({ from, to }) };
  }

  @Get('patient/:patientId')
  @RequirePermission(Feature.AUD, Access.R)
  @ApiOperation({ summary: '환자별 열람·변경 이력 — 검체·오더·병리·유전체 경유 접근까지 포함' })
  async patientAccess(@Param('patientId') patientId: string, @Query('from') from?: string, @Query('to') to?: string, @Query('take') take?: string) {
    return { data: await this.service.patientAccess(patientId, { from, to, take: take ? Number(take) : undefined }) };
  }

  @Get()
  @RequirePermission(Feature.AUD, Access.R)
  @ApiOperation({ summary: '감사로그 검색 — 사용자·액션·대상·민감·실패(4xx/5xx)·기간·페이지' })
  async query(
    @Query('userId') userId?: string,
    @Query('action') action?: string,
    @Query('target') target?: string,
    @Query('sensitive') sensitive?: string,
    @Query('failed') failed?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    return {
      data: await this.service.query({
        userId,
        action,
        target,
        sensitive: sensitive == null ? undefined : sensitive === 'true',
        failedOnly: failed === 'true',
        from,
        to,
        skip: skip ? Number(skip) : undefined,
        take: take ? Number(take) : undefined,
      }),
    };
  }
}
