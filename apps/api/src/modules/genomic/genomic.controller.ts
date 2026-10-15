/**
 * Genomic (유전체) HTTP 컨트롤러 — 라우트 20개 (`api/v1/genomic`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: F-GEN_RES:R, F-GEN_RES:S, F-GEN_RES:W.
 * ⚠ 서명·검증 주체는 요청 본문이 아니라 @CurrentUser(JWT)에서 얻는다 — 클라이언트 위조 방지.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Post, Param, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsBoolean, IsOptional, IsInt, IsNumber, IsObject, Min } from 'class-validator';
import { GenomicService } from './genomic.service';
import type { AcmgEvidence } from '../../domain/genomic';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { LisRole, Feature, Access } from '../../common/rbac/roles';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

class RecordConsentDto {
  @IsString() genomicOrderId!: string;
  @IsString() consentType!: string;
  @IsBoolean() secondaryFindingsOptin!: boolean;
  @IsString() signedDate!: string;
}
class SignGenomicReportDto {
  // signer는 두지 않는다 — 서버가 @CurrentUser로 결정(부인방지).
  @IsOptional() @IsString() note?: string;
}
class DeliverGenomicReportDto {
  @IsString() channel!: string; // 정본 열거 검증은 서비스(deliverGenomicReport)
  @IsOptional() @IsString() recipient?: string;
  @IsOptional() @IsString() note?: string;
}
class WithdrawConsentDto {
  @IsOptional() @IsString() reason?: string;
}
class ImportVcfDto {
  @IsString() vcf!: string;
}
class ManualVariantDto {
  @IsOptional() @IsString() gene?: string;
  @IsOptional() @IsString() hgvsC?: string;
  @IsOptional() @IsString() hgvsP?: string;
  @IsOptional() vaf?: number;
  @IsOptional() @IsString() zygosity?: string;
  @IsOptional() @IsString() chrom?: string;
  @IsOptional() @IsInt() pos?: number;
  @IsOptional() @IsString() refAllele?: string;
  @IsOptional() @IsString() altAllele?: string;
}
class AcmgDto {
  @IsOptional() @IsInt() @Min(0) pvs?: number;
  @IsOptional() @IsInt() @Min(0) strongP?: number;
  @IsOptional() @IsInt() @Min(0) moderateP?: number;
  @IsOptional() @IsInt() @Min(0) supportingP?: number;
  @IsOptional() @IsInt() @Min(0) standaloneB?: number;
  @IsOptional() @IsInt() @Min(0) strongB?: number;
  @IsOptional() @IsInt() @Min(0) supportingB?: number;
}
class AiInterpretDto {
  @IsOptional() @IsString() gene?: string;
  @IsOptional() @IsString() hgvsC?: string;
  @IsOptional() @IsString() hgvsP?: string;
  @IsOptional() @IsString() variantType?: string;
  @IsOptional() @IsString() classification?: string;
  @IsOptional() @IsObject() acmgEvidence?: AcmgEvidence;
  @IsOptional() @IsNumber() vaf?: number;
  @IsOptional() @IsString() zygosity?: string;
  @IsOptional() @IsString() testType?: string;
}
// classifier는 두지 않는다 — 서버가 @CurrentUser로 결속(부인방지). 재분류는 환자 재접촉 통보까지 유발하므로
//   판정 주체를 클라이언트가 위조하면 책임 소재가 무너진다(서명 엔드포인트와 동일 원칙).
class CurateDto {
  @IsString() classification!: string;
  @IsOptional() @IsString() evidence?: string;
}
class CorrectGeneDto {
  @IsString() gene!: string;
  @IsString() reason!: string;
}
class ReclassifyDto {
  @IsString() classification!: string;
  @IsOptional() @IsString() evidence?: string;
  @IsString() reason!: string;
}

@ApiTags('Genomic (유전체)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard, PermissionGuard)
// 권한 매트릭스(GEN_RES: GEN/GC/PHY R·W·S, AUD R)와 일치시킨다 — PHY 누락 시 검증의가 유전체 판독·서명에서
//   전 라우트 403(RolesGuard가 PermissionGuard보다 먼저 차단). 세부 R/W/S는 라우트별 @RequirePermission이 가른다.
@Roles(LisRole.GEN, LisRole.GC, LisRole.PHY, LisRole.ADM, LisRole.AUD)
@Controller('api/v1/genomic')
export class GenomicController {
  constructor(private readonly service: GenomicService) {}

  @Post('consent')
  @ApiOperation({ summary: '전자동의 등록(발송 선행 게이트)' })
  async consent(@Body() body: RecordConsentDto) {
    return { data: await this.service.recordConsent(body) };
  }

  @Post(':genomicOrderId/consent/withdraw')
  @ApiOperation({ summary: '동의 철회(환자 권리 — 이후 발송 차단)' })
  async withdrawConsent(@Param('genomicOrderId') id: string, @Body() body: WithdrawConsentDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.withdrawConsent(id, { ...body, actor: user.userId }) };
  }

  @Post(':genomicOrderId/sendout')
  @RequirePermission(Feature.GEN_RES, Access.W)
  @ApiOperation({ summary: '수탁 발송 요청(동의 게이트 검사)' })
  async sendout(@Param('genomicOrderId') id: string) {
    return { data: await this.service.requestSendout(id) };
  }

  @Get('orders')
  @RequirePermission(Feature.GEN_RES, Access.R)
  @ApiOperation({ summary: '유전체 대기 워크리스트(미해석 오더)' })
  async orders() {
    return { data: await this.service.listOrders() };
  }

  @Get(':genomicOrderId/variants')
  @RequirePermission(Feature.GEN_RES, Access.R) // 유전정보 조회 격리(08 §3.3)
  @ApiOperation({ summary: '변이·해석 조회(유전정보 최소권한)' })
  async variants(@Param('genomicOrderId') id: string) {
    return { data: await this.service.getVariants(id) };
  }

  @Get(':genomicOrderId/report')
  @RequirePermission(Feature.GEN_RES, Access.R)
  @ApiOperation({ summary: '임상 보고서 조립 — 1차/이차 소견 분류(이차소견은 동의 시에만 보고)' })
  async report(@Param('genomicOrderId') id: string) {
    return { data: await this.service.generateReport(id) };
  }

  @Post(':genomicOrderId/vcf')
  @RequirePermission(Feature.GEN_RES, Access.W)
  @ApiOperation({ summary: '수탁 VCF 결과 수신 → 변이 등록' })
  async importVcf(@Param('genomicOrderId') id: string, @Body() body: ImportVcfDto) {
    return { data: await this.service.importVcf(id, body.vcf) };
  }

  @Post(':genomicOrderId/variant')
  @RequirePermission(Feature.GEN_RES, Access.W)
  @ApiOperation({ summary: '수기 변이 단건 입력(수탁 PDF 등 비구조화 결과지 → 변이 등록)' })
  async addVariant(@Param('genomicOrderId') id: string, @Body() body: ManualVariantDto) {
    return { data: await this.service.addManualVariant(id, body) };
  }

  @Post('acmg-suggest')
  @ApiOperation({ summary: 'ACMG 근거 → 분류 제안(큐레이션 보조)' })
  acmg(@Body() body: AcmgDto) {
    return { data: this.service.acmgSuggest(body) };
  }

  @Post('ai-interpret')
  @RequirePermission(Feature.GEN_RES, Access.R)
  @ApiOperation({ summary: 'AI 해석 초안(로컬 지식기반) — 분류 제안·근거·표적치료 시사점. 자동확정 아님·전문가 검토 필수. 데이터 외부 미전송' })
  aiInterpret(@Body() body: AiInterpretDto) {
    return { data: this.service.aiInterpret(body) };
  }

  @Post('variants/:variantId/curate')
  @RequirePermission(Feature.GEN_RES, Access.W)
  @ApiOperation({ summary: '변이 큐레이션(해석 초안 DRAFT)' })
  async curate(@Param('variantId') variantId: string, @Body() body: CurateDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.curateVariant(variantId, { ...body, classifier: user.userId }) };
  }

  @Post('variants/:variantId/gene')
  @RequirePermission(Feature.GEN_RES, Access.W)
  @ApiOperation({ summary: '유전자 심볼 보정 — 정규화 불가(빈/기호뿐) 심볼만. review 버킷에 갇힌 확정 P/LP를 보고 가능하게' })
  async correctGene(@Param('variantId') variantId: string, @Body() body: CorrectGeneDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.correctVariantGene(variantId, { ...body, corrector: user.userId }) };
  }

  @Post('interpretations/:interpId/finalize')
  @RequirePermission(Feature.GEN_RES, Access.W)
  @ApiOperation({ summary: '해석 확정(DRAFT→FINAL)' })
  async finalize(@Param('interpId') interpId: string) {
    return { data: await this.service.finalizeInterpretation(interpId) };
  }

  @Get('variants/:variantId/evidence-context')
  @RequirePermission(Feature.GEN_RES, Access.R)
  @ApiOperation({ summary: '변이 근거 종합 번들 — 유전자 지식·인용 근거·이전 해석 통합(판독 검토용, 향후 온프레미스 LLM RAG 컨텍스트). 외부 전송 없음' })
  async evidenceContext(@Param('variantId') variantId: string) {
    return { data: await this.service.evidenceContext(variantId) };
  }

  @Get('reinterpret-review')
  @RequirePermission(Feature.GEN_RES, Access.R)
  @ApiOperation({ summary: '근거 drift 재해석 검토 — 확정 해석이 현재 근거 DB와 어긋나는 변이(재접촉 필요 우선). 탐지만·재분류는 사람' })
  async reinterpretReview() {
    return { data: await this.service.reinterpretReview() };
  }

  @Get('runs/:runId/qc')
  @RequirePermission(Feature.GEN_RES, Access.R)
  @ApiOperation({ summary: 'NGS 런 QC 게이트(Q30·coverage·uniformity 판정)(G2)' })
  async runQc(@Param('runId') runId: string) {
    return { data: await this.service.evaluateRunQc(runId) };
  }

  @Post(':genomicOrderId/report/sign')
  @RequirePermission(Feature.GEN_RES, Access.S)
  @ApiOperation({ summary: '유전체 보고서 서명 확정(최초→최종, 이후 개정)(G3)' })
  async signReport(@Param('genomicOrderId') id: string, @Body() _body: SignGenomicReportDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.signGenomicReport(id, { signer: user.userId }) };
  }

  @Post(':genomicOrderId/report/deliver')
  @RequirePermission(Feature.GEN_RES, Access.W)
  @ApiOperation({ summary: '유전체 보고서 배포 기록(최종/개정만·PRINT/PORTAL/PROVIDER/FAX)(G3)' })
  async deliverReport(@Param('genomicOrderId') id: string, @Body() body: DeliverGenomicReportDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.deliverGenomicReport(id, { ...body, deliveredBy: user.userId }) };
  }

  @Get(':genomicOrderId/report/deliveries')
  @RequirePermission(Feature.GEN_RES, Access.R)
  @ApiOperation({ summary: '유전체 보고서 배포 이력(G3)' })
  async reportDeliveries(@Param('genomicOrderId') id: string) {
    return { data: await this.service.listGenomicDeliveries(id) };
  }

  @Post('variants/:variantId/reclassify')
  @RequirePermission(Feature.GEN_RES, Access.W)
  @ApiOperation({ summary: '변이 재분류(기존 FINAL→SUPERSEDED, 신규 FINAL)' })
  async reclassify(@Param('variantId') variantId: string, @Body() body: ReclassifyDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.reclassify(variantId, { ...body, classifier: user.userId }) };
  }
}
