/**
 * Microbiology (미생물) HTTP 컨트롤러 — 라우트 14개 (`api/v1/microbiology`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: 역할 게이트(LisRole.MIC, LisRole.ADM).
 * ⚠ 서명·검증 주체는 요청 본문이 아니라 @CurrentUser(JWT)에서 얻는다 — 클라이언트 위조 방지.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Post, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsOptional, IsArray } from 'class-validator';
import { MicrobiologyService } from './microbiology.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { LisRole } from '../../common/rbac/roles';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

class RecordIsolateDto {
  @IsString() cultureId!: string;
  @IsString() organism!: string;
  @IsOptional() @IsString() snomed?: string;
  @IsArray() susceptibilities!: { antibiotic: string; mic: string; interpretation?: string }[];
  @IsOptional() @IsString() reporter?: string;
}

class RecordGramDto {
  @IsString() cultureId!: string;
  @IsString() gramStain!: string;
  @IsOptional() @IsString() reporter?: string;
}

class NoGrowthDto {
  @IsString() cultureId!: string;
  @IsOptional() @IsString() reporter?: string;
}

class MarkNotifiedDto {
  @IsOptional() @IsString() note?: string;
  @IsOptional() @IsString() reportNo?: string;
}
class RejectCultureDto {
  @IsString() reason!: string;
}
class CreateCultureDto {
  @IsString() specimenNo!: string;
  @IsOptional() @IsString() medium?: string;
  @IsOptional() @IsString() source?: string;
}

@ApiTags('Microbiology (미생물)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(LisRole.MIC, LisRole.ADM)
@Controller('api/v1/microbiology')
export class MicrobiologyController {
  constructor(private readonly service: MicrobiologyService) {}

  @Get('cultures')
  @ApiOperation({ summary: '배양 목록 — scope=pending(대기·기본)/completed(완료)/all(전체)' })
  async listCultures(@Query('scope') scope?: string) {
    const s = scope === 'completed' || scope === 'all' ? scope : 'pending';
    return { data: await this.service.listCultures(s) };
  }

  @Post('cultures')
  @ApiOperation({ summary: '배양 등록 — 접수된 검체를 배지에 접종해 미생물 워크리스트에 올린다' })
  async createCulture(@Body() body: CreateCultureDto) {
    return { data: await this.service.createCulture(body) };
  }

  @Get('antibiogram')
  @ApiOperation({ summary: 'Antibiogram(균종×항생제 %S 누적 집계) — 경험적 항생제 선택 근거' })
  async antibiogram(@Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.service.antibiogram(from, to) };
  }

  // 감염관리 조회(MDRO line list·법정감염병 목록)는 감염관리 의사(ICP=PHY)도 열람.
  //   클래스 기본(MIC,ADM)을 메서드 레벨로 오버라이드(getAllAndOverride) — 조회만 확대, 신고 처리(write)는 MIC,ADM 유지.
  @Get('line-list')
  @Roles(LisRole.MIC, LisRole.PHY, LisRole.ADM)
  @ApiOperation({ summary: '감염관리 MDRO line list(환자·균·유형·검체·일자)' })
  async lineList(@Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.service.mdroLineList(from, to) };
  }

  @Get('notifiable')
  @Roles(LisRole.MIC, LisRole.PHY, LisRole.ADM)
  @ApiOperation({ summary: '법정감염병 신고 대기 목록(미신고)' })
  async notifiable(@Query('status') status?: string) {
    return { data: await this.service.listNotifiable(status ?? 'PENDING') };
  }

  @Post('notifiable/:reportId/notify')
  @ApiOperation({ summary: '법정감염병 신고 완료 처리' })
  async markNotified(@Param('reportId') reportId: string, @Body() body: MarkNotifiedDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.markNotified(reportId, user.userId, body?.note, body?.reportNo) };
  }

  @Get('cultures/:cultureId')
  @ApiOperation({ summary: '배양 조회(균주·감수성 포함)' })
  async getCulture(@Param('cultureId') cultureId: string) {
    return { data: await this.service.getCulture(cultureId) };
  }

  @Get('cultures/:cultureId/report')
  @ApiOperation({ summary: '배양 단계보고 이력(그람 예비→최종→개정)' })
  async report(@Param('cultureId') cultureId: string) {
    return { data: await this.service.getReport(cultureId) };
  }

  @Post('gram')
  @ApiOperation({ summary: '그람 염색 소견 기록 → 예비(중간)보고' })
  async gram(@Body() body: RecordGramDto) {
    return { data: await this.service.recordGram(body) };
  }

  @Post('isolates')
  @ApiOperation({ summary: '균 동정·감수성 등록 → 최종보고(재등록 시 개정)' })
  async record(@Body() body: RecordIsolateDto) {
    return { data: await this.service.recordIsolate(body) };
  }

  @Post('no-growth')
  @ApiOperation({ summary: '무증식(No growth) 최종보고 — 그람 선행/균주 생성 없이 배양 종결' })
  async noGrowth(@Body() body: NoGrowthDto) {
    return { data: await this.service.recordNoGrowth(body) };
  }

  @Get('isolates/:isolateId/evidence-context')
  @ApiOperation({ summary: '분리주 근거 종합 번들 — MIC→S/I/R·브레이크포인트·expert-rule·MDRO·법정감염병·과거 내성 이력 통합(판독 검토용, 향후 원내 LLM RAG 컨텍스트). 외부 전송 없음' })
  async evidenceContext(@Param('isolateId') isolateId: string) {
    return { data: await this.service.evidenceContext(isolateId) };
  }

  @Post('cultures/:cultureId/reject')
  @ApiOperation({ summary: '검체 부적합·반려(오염·부적절 채취·이송지연 — 동정 전만)(M1)' })
  async reject(@Param('cultureId') cultureId: string, @Body() body: RejectCultureDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.rejectCulture(cultureId, { ...body, rejectedBy: user.userId }) };
  }

  @Get('cultures/:cultureId/selective-ast')
  @ApiOperation({ summary: '선택적/cascade AST 보고 — 분리주별 보고 여부(억제) 주석(M2)' })
  async selectiveAst(@Param('cultureId') cultureId: string) {
    return { data: await this.service.selectiveAst(cultureId) };
  }
}
