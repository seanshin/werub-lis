/**
 * Reflex (반사검사 프로토콜) HTTP 컨트롤러 — 라우트 15개 (`api/v1/reflex/protocols`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: 역할 게이트(...AUTHOR).
 * ⚠ 서명·검증 주체는 요청 본문이 아니라 @CurrentUser(JWT)에서 얻는다 — 클라이언트 위조 방지.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth, ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsNumber, IsIn, Matches } from 'class-validator';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
import { ReflexService } from './reflex.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { LisRole } from '../../common/rbac/roles';

class ReflexDto {
  @ApiProperty({ example: '갑상선 반사검사(TSH→FT4)' }) @IsString() name!: string;
  @ApiProperty({ example: 'CHE-TSH' }) @IsString() whenTestCode!: string;
  @ApiProperty({ enum: ['>=', '<=', '>', '<', 'BETWEEN', 'OUT_OF_REF', 'FLAG'] }) @IsIn(['>=', '<=', '>', '<', 'BETWEEN', 'OUT_OF_REF', 'FLAG']) operator!: string;
  @ApiPropertyOptional() @IsOptional() @IsNumber() threshold?: number;
  @ApiPropertyOptional({ description: 'BETWEEN 상한' }) @IsOptional() @IsNumber() thresholdHigh?: number;
  @ApiPropertyOptional({ enum: ['H', 'HH', 'L', 'LL'] }) @IsOptional() @IsString() flag?: string;
  @ApiProperty({ description: '후속검사코드(콤마구분)', example: 'CHE-FT4' }) @IsString() addTestCodes!: string;
  @ApiPropertyOptional() @IsOptional() @IsString() priority?: string;
  @ApiPropertyOptional({ description: 'YYYY-MM-DD' }) @IsOptional() @Matches(ISO_DATE, { message: 'effectiveFrom은 YYYY-MM-DD' }) effectiveFrom?: string;
  @ApiPropertyOptional({ description: 'YYYY-MM-DD' }) @IsOptional() @Matches(ISO_DATE, { message: 'effectiveTo는 YYYY-MM-DD' }) effectiveTo?: string;
  @ApiPropertyOptional({ description: '개정하는 선행 프로토콜ID(계보) — 활성화 시 선행 자동 SUPERSEDED' }) @IsOptional() @IsString() supersedesProtocolId?: string;
}
class NoteDto { @ApiPropertyOptional() @IsOptional() @IsString() note?: string; }
class CommitteeDto { @ApiProperty({ example: 'LAB-2026-014' }) @IsString() committeeNo!: string; }
class ActivateDto { @ApiPropertyOptional({ description: 'HIS 등록/수용 참조' }) @IsOptional() @IsString() hisRef?: string; }
class ResolveRejectionDto {
  @ApiProperty({ example: 'RX-O-260714-XXXX-CHE-HBA1C' }) @IsString() mcid!: string;
  @ApiProperty({ enum: ['cancel', 'keep'] }) @IsIn(['cancel', 'keep']) action!: 'cancel' | 'keep';
}

const READ = [LisRole.TEC, LisRole.PHY, LisRole.MIC, LisRole.ADM, LisRole.AUD];
const AUTHOR = [LisRole.TEC, LisRole.PHY, LisRole.ADM];

@ApiTags('Reflex (반사검사 프로토콜)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('api/v1/reflex/protocols')
export class ReflexController {
  constructor(private readonly service: ReflexService) {}

  @Get()
  @Roles(...READ)
  @ApiOperation({ summary: 'Reflex 프로토콜 목록' })
  async list(@Query('status') status?: string) {
    return { data: await this.service.list(status) };
  }

  @Get('report')
  @Roles(...READ)
  @ApiOperation({ summary: 'Reflex 실행 QI 리포트(프로토콜별 빈도·승인/반려율·추세)' })
  async report(@Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.service.report(from, to) };
  }

  @Get('rejections')
  @Roles(...READ)
  @ApiOperation({ summary: 'HIS 의사 반려된 Reflex add-on 목록(취소/유지 처리 대상)' })
  async rejections() {
    return { data: await this.service.listRejections() };
  }

  @Post('rejections/resolve')
  @Roles(...AUTHOR)
  @ApiOperation({ summary: '반려 해소 — 후속검사 취소(cancel) 또는 유지(keep)' })
  async resolveRejection(@Body() body: ResolveRejectionDto, @CurrentUser() u: AuthUser) {
    return { data: await this.service.resolveRejection(body.mcid, body.action, u?.userId) };
  }

  @Get(':id')
  @Roles(...READ)
  @ApiOperation({ summary: 'Reflex 프로토콜 상세(이력 포함)' })
  async get(@Param('id') id: string) {
    return { data: await this.service.get(id) };
  }

  @Post()
  @Roles(...AUTHOR)
  @ApiOperation({ summary: '프로토콜 초안 작성' })
  async create(@Body() body: ReflexDto, @CurrentUser() u: AuthUser) {
    return { data: await this.service.create(body, u?.userId) };
  }

  @Patch(':id')
  @Roles(...AUTHOR)
  @ApiOperation({ summary: '초안/반려 프로토콜 수정' })
  async update(@Param('id') id: string, @Body() body: ReflexDto, @CurrentUser() u: AuthUser) {
    return { data: await this.service.update(id, body, u?.userId) };
  }

  // ── 승인 라이프사이클 ──
  @Post(':id/submit')
  @Roles(...AUTHOR)
  @ApiOperation({ summary: '전문의 검토 제출(DRAFT→PENDING_SPECIALIST)' })
  async submit(@Param('id') id: string, @CurrentUser() u: AuthUser) { return { data: await this.service.submit(id, u?.userId) }; }

  @Post(':id/specialist-approve')
  @Roles(LisRole.PHY, LisRole.ADM)
  @ApiOperation({ summary: '전문의 승인(→PENDING_COMMITTEE)' })
  async specialist(@Param('id') id: string, @Body() b: NoteDto, @CurrentUser() u: AuthUser) { return { data: await this.service.specialistApprove(id, u?.userId, b.note) }; }

  @Post(':id/reject')
  @Roles(LisRole.PHY, LisRole.ADM)
  @ApiOperation({ summary: '반려(→REJECTED)' })
  async reject(@Param('id') id: string, @Body() b: NoteDto, @CurrentUser() u: AuthUser) { return { data: await this.service.reject(id, u?.userId, b.note) }; }

  @Post(':id/committee')
  @Roles(LisRole.ADM)
  @ApiOperation({ summary: '위원회 의결 기록(→PENDING_HIS)' })
  async committee(@Param('id') id: string, @Body() b: CommitteeDto, @CurrentUser() u: AuthUser) { return { data: await this.service.committee(id, b.committeeNo, u?.userId) }; }

  @Post(':id/activate')
  @Roles(LisRole.ADM)
  @ApiOperation({ summary: 'HIS 등록·수용 확인 → ACTIVE(실행 가능)' })
  async activate(@Param('id') id: string, @Body() b: ActivateDto, @CurrentUser() u: AuthUser) { return { data: await this.service.activate(id, b.hisRef ?? '', u?.userId) }; }

  @Post(':id/suspend')
  @Roles(LisRole.ADM)
  @ApiOperation({ summary: '일시 중지(ACTIVE→SUSPENDED)' })
  async suspend(@Param('id') id: string, @Body() b: NoteDto, @CurrentUser() u: AuthUser) { return { data: await this.service.suspend(id, u?.userId, b.note) }; }

  @Post(':id/resume')
  @Roles(LisRole.ADM)
  @ApiOperation({ summary: '재개(SUSPENDED→ACTIVE)' })
  async resume(@Param('id') id: string, @CurrentUser() u: AuthUser) { return { data: await this.service.resume(id, u?.userId) }; }

  @Post(':id/retire')
  @Roles(LisRole.ADM)
  @ApiOperation({ summary: '폐기(→RETIRED)' })
  async retire(@Param('id') id: string, @Body() b: NoteDto, @CurrentUser() u: AuthUser) { return { data: await this.service.retire(id, u?.userId, b.note) }; }
}
