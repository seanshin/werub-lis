/**
 * Molecular (분자진단/PCR) HTTP 컨트롤러 — 라우트 7개 (`api/v1/molecular`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: 역할 게이트(LisRole.MIC, LisRole.ADM).
 * ⚠ 서명·검증 주체는 요청 본문이 아니라 @CurrentUser(JWT)에서 얻는다 — 클라이언트 위조 방지.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Post, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { MolecularService } from './molecular.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { LisRole } from '../../common/rbac/roles';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

@ApiTags('Molecular (분자진단/PCR)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(LisRole.MIC, LisRole.ADM)
@Controller('api/v1/molecular')
export class MolecularController {
  constructor(private readonly service: MolecularService) {}

  @Get('assays')
  @ApiOperation({ summary: 'assay 카탈로그(패널별 타깃·Ct 컷오프) — 미등록이어도 결과 입력은 막지 않는다' })
  async assays(@Query('panelCode') panelCode?: string) {
    return { data: await this.service.listAssays(panelCode) };
  }

  @Post('assays')
  @ApiOperation({ summary: 'assay 등록·수정 — 키트 문서의 타깃·판정 한계를 검사실이 직접 입력' })
  async upsertAssay(
    @Body() body: { panelCode: string; target: string; assayName?: string; ctCutoff?: number | null; equivocalFrom?: number | null; note?: string },
    @CurrentUser() user: AuthUser,
  ) {
    return { data: await this.service.upsertAssay(body, user.userId) };
  }

  @Delete('assays/:panelCode/:target')
  @ApiOperation({ summary: 'assay 삭제(오등록 정정)' })
  async deleteAssay(@Param('panelCode') panelCode: string, @Param('target') target: string) {
    return { data: await this.service.deleteAssay(panelCode, target) };
  }

  @Post('results')
  @ApiOperation({ summary: '분자검사(PCR) 결과 등록 — 타깃·Ct·검출유무·정량. 법정감염병 타깃 검출 시 신고 연동' })
  async record(@Body() body: { specimenNo: string; target: string; detection: string; panelCode?: string; assay?: string; ct?: number; quantValue?: string; quantUnit?: string; interpretation?: string; status?: string }, @CurrentUser() user: AuthUser) {
    return { data: await this.service.record({ ...body, reportedBy: user.userId }) };
  }

  @Post('interpret-suggest')
  @ApiOperation({ summary: '판정 해석 제안(DRAFT·미기록) — 검출유무+Ct+assay 카탈로그로 초안. 확정은 검사자' })
  async interpretSuggest(@Body() body: { target: string; detection: string; panelCode?: string; ct?: number }) {
    return { data: await this.service.interpretSuggest(body) };
  }

  @Get('specimen/:specimenNo')
  @ApiOperation({ summary: '검체별 분자검사 결과' })
  async bySpecimen(@Param('specimenNo') specimenNo: string) {
    return { data: await this.service.listBySpecimen(specimenNo) };
  }

  @Get('detected')
  @ApiOperation({ summary: '최근 검출(DETECTED) 워크리스트' })
  async detected(@Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.service.detectedRecent(from, to) };
  }
}
