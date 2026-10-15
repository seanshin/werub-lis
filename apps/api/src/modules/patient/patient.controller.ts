/**
 * Patient (환자) HTTP 컨트롤러 — 라우트 5개 (`api/v1/patients`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: 역할 게이트(LisRole.ADM).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { PatientService } from './patient.service';
import { CreatePatientDto, UpdatePatientDto } from './dto/patient.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { LisRole } from '../../common/rbac/roles';
import { IsString, Matches } from 'class-validator';
import { CODE_ID_PATTERN, CODE_ID_MESSAGE } from '../../common/validation';

class MergePatientDto {
  @IsString() @Matches(CODE_ID_PATTERN, { message: `sourceId: ${CODE_ID_MESSAGE}` }) sourceId!: string;
}

@ApiTags('Patient (환자)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
// 환자 조회는 임상 직무 전반이 필요 — 명시적 역할 부여(default-allow 의존 제거). 등록은 메서드에서 RCP/ADM로 재지정.
@Roles(LisRole.RCP, LisRole.TEC, LisRole.PHY, LisRole.PAT, LisRole.MIC, LisRole.BB, LisRole.GEN, LisRole.GC, LisRole.ADM, LisRole.AUD)
@Controller('api/v1/patients')
export class PatientController {
  constructor(private readonly service: PatientService) {}

  @Get()
  @ApiOperation({ summary: '환자 목록/검색(환자ID·성명 + 기간 오더활동, 100건/페이지·total)' })
  async findAll(@Query('q') q?: string, @Query('from') from?: string, @Query('to') to?: string, @Query('page') page?: string) {
    const r = await this.service.findAll(q, from, to, page ? Number(page) : 0);
    return { data: r.rows, meta: { total: r.total, page: r.page, pageSize: r.pageSize } };
  }

  @Get(':patientId')
  @ApiOperation({ summary: '환자 상세 조회(내원·오더 포함)' })
  async findOne(@Param('patientId') patientId: string) {
    return { data: await this.service.findOne(patientId) };
  }

  @Post()
  @Roles(LisRole.RCP, LisRole.ADM) // 환자 등록은 접수담당·관리자
  @ApiOperation({ summary: '환자 등록(HIS ADT 동기화 대체)' })
  async create(@Body() body: CreatePatientDto) {
    return { data: await this.service.create(body) };
  }

  @Patch(':patientId')
  @Roles(LisRole.RCP, LisRole.ADM) // 인적정보 정정도 접수담당·관리자
  @ApiOperation({ summary: '환자 인적정보 정정(성별·생년 오타 → 참고치 오분류 방지)' })
  async update(@Param('patientId') patientId: string, @Body() body: UpdatePatientDto) {
    return { data: await this.service.update(patientId, body) };
  }

  @Post(':patientId/merge')
  @Roles(LisRole.ADM) // 병합은 되돌리기 어려운 이관 — 관리자 전용
  @ApiOperation({ summary: '환자 병합(중복 등록 source → 정본 target 임상레코드 이관, source는 MERGED)' })
  async merge(@Param('patientId') patientId: string, @Body() body: MergePatientDto) {
    return { data: await this.service.merge(patientId, body.sourceId) };
  }
}
