/**
 * Admin · Catalog (표준 코드셋 반입) HTTP 컨트롤러 — 라우트 6개 (`api/v1/admin/catalogs`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: 역할 게이트(LisRole.MIC, LisRole.ADM).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Body, Controller, Delete, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { CatalogService } from './catalog.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { LisRole } from '../../common/rbac/roles';

class ImportCatalogDto {
  @IsString() version!: string;
  @IsOptional() @IsString() standard?: string;
  @IsOptional() @IsString() effectiveDate?: string;
  @IsString() csv!: string;
  @IsOptional() @IsString() note?: string;
}

/**
 * 표준 코드셋 반입 — 반입(DRAFT) → 차이 확인 → 활성화.
 * 판정 기준을 바꾸는 행위라 미생물검사실(MIC)·관리자만.
 */
@ApiTags('Admin · Catalog (표준 코드셋 반입)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(LisRole.MIC, LisRole.ADM)
@Controller('api/v1/admin/catalogs')
export class CatalogController {
  constructor(private readonly service: CatalogService) {}

  @Get()
  @ApiOperation({ summary: '카탈로그·버전 목록(활성 버전 표시 — 없으면 코드 스타터셋으로 동작)' })
  async list() {
    return { data: await this.service.list() };
  }

  @Post(':catalogId/import')
  @ApiOperation({ summary: '개정판 반입 — 항상 DRAFT. 응답에 활성 버전과의 차이를 함께 준다' })
  async import(@Param('catalogId') catalogId: string, @Body() dto: ImportCatalogDto, @Req() req: { user?: { userId?: string } }) {
    return { data: await this.service.import(catalogId, dto, req.user?.userId ?? null) };
  }

  @Get(':catalogId/diff')
  @ApiOperation({ summary: '활성 버전 대비 차이(활성 버전이 없으면 코드 스타터셋과 비교)' })
  async diff(@Param('catalogId') catalogId: string, @Query('version') version: string) {
    return { data: await this.service.diff(catalogId, version) };
  }

  @Get(':catalogId/items')
  @ApiOperation({ summary: '버전 항목 조회' })
  async items(@Param('catalogId') catalogId: string, @Query('version') version: string) {
    return { data: await this.service.items(catalogId, version) };
  }

  @Post(':catalogId/activate')
  @ApiOperation({ summary: '활성화 — 이전 활성 버전은 RETIRED로 남긴다(판정 근거 소명)' })
  async activate(@Param('catalogId') catalogId: string, @Body() body: { version: string }, @Req() req: { user?: { userId?: string } }) {
    return { data: await this.service.activate(catalogId, body?.version, req.user?.userId ?? null) };
  }

  @Delete(':catalogId/versions/:version')
  @ApiOperation({ summary: '초안(DRAFT) 버전 삭제 — 활성/이전 버전은 이력이라 불가' })
  async deleteDraft(@Param('catalogId') catalogId: string, @Param('version') version: string) {
    return { data: await this.service.deleteDraft(catalogId, version) };
  }
}
