/**
 * Pathology (병리) HTTP 컨트롤러 — 라우트 35개 (`api/v1/pathology`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: 역할 게이트(LisRole.PAT, LisRole.ADM).
 * ⚠ 서명·검증 주체는 요청 본문이 아니라 @CurrentUser(JWT)에서 얻는다 — 클라이언트 위조 방지.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Post, Patch, Delete, Param, Body, Query, UseGuards, Header, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsOptional, IsIn, IsObject, IsNumber, IsBoolean, Min, Max } from 'class-validator';
import { PathologyService } from './pathology.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { LisRole } from '../../common/rbac/roles';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';
import { STAIN_ORDER_TYPES, CONCORDANCE_VALUES } from '../../domain/enums';

/**
 * 병리 보고서의 signer는 Provider(의사 마스터) FK다. 로그인 계정에 연결된 Provider를 서버가
 * 유도해 서명자로 쓴다 — 클라이언트가 지정하게 두면 타 판독의 명의의 최종 진단을 만들 수 있다.
 * 연결이 없으면 서명 자체를 막는다(관리자가 /admin/users에서 계정↔판독의를 연결해야 함).
 */
function signerOf(user: AuthUser): string {
  if (!user?.providerId) {
    throw new ForbiddenException(
      '서명하려면 계정에 판독의(Provider)가 연결돼 있어야 합니다 — 관리자에게 계정↔판독의 연결을 요청하세요',
    );
  }
  return user.providerId;
}

/**
 * 서명·초안 본문. `signer`는 DTO에 두지 않는다 — 서버가 @CurrentUser로 결정한다.
 * 클라이언트가 서명자를 지정하면 타 판독의 명의의 최종 진단을 만들 수 있어 부인방지가 무너진다.
 */
class SignReportDto {
  @IsString() spNo!: string;
  @IsString() findings!: string;
  @IsString() diagnosis!: string;
  @IsOptional() @IsString() snomed?: string;
  @IsOptional() @IsObject() synoptic?: Record<string, string>;
  @IsOptional() @IsString() synopticProtocol?: string;
}
class GrossingDto {
  @IsString() grossDesc!: string;
}
class BlockDto {
  @IsString() label!: string;
  @IsOptional() @IsString() tissue?: string;
}
class SlideDto {
  @IsIn(['HE', 'SPECIAL', 'IHC']) stain!: string;
  @IsOptional() @IsString() stainDetail?: string;
}
class AmendDto {
  @IsString() findings!: string;
  @IsString() diagnosis!: string;
  @IsString() reason!: string;
  // 개정 시 기준으로 삼은 버전(낙관적 동시성). 지정하면 그 버전에 대해서만 반영되고, 그사이 다른 개정이
  // 있었으면 409. 미지정 시 서버가 현재 버전을 기준으로 잡는다(하위호환).
  @IsOptional() @IsNumber() baseVersion?: number;
}
class UpdateCaseInfoDto {
  @IsOptional() @IsString() clinicalInfo?: string;
  @IsOptional() @IsString() requestingProvider?: string;
  @IsOptional() @IsString() specimenSite?: string;
  @IsOptional() @IsString() caseType?: string;
}
class AddendumDto {
  @IsString() content!: string;
}
class StainOrderDto {
  @IsIn(STAIN_ORDER_TYPES as unknown as string[]) orderType!: string;
  @IsOptional() @IsString() blockId?: string;
  @IsOptional() @IsString() detail?: string;
  @IsOptional() @IsString() note?: string;
}
class StainStatusDto {
  @IsString() status!: string; // 정본 열거 검증은 서비스(updateStainOrder)
}
class AssignDto {
  @IsString() assignedTo!: string;
}
class ConsultRequestDto {
  @IsString() consultType!: string; // 정본 열거 검증은 서비스(requestConsult)
  @IsOptional() @IsString() consultant?: string;
  @IsOptional() @IsString() question?: string;
}
class ConsultRespondDto {
  @IsString() opinion!: string;
}
class RejectCaseDto {
  @IsString() reason!: string;
}
class CriticalDiagnosisDto {
  @IsString() diagnosisType!: string;
  @IsString() summary!: string;
  @IsOptional() @IsString() notifyTarget?: string;
  @IsOptional() @IsString() notifyMethod?: string;
}
class SpecimenPartDto {
  @IsString() partLabel!: string;
  @IsOptional() @IsString() specimenType?: string;
  @IsOptional() @IsString() site?: string;
  @IsOptional() @IsString() description?: string;
}
class IhcDto {
  @IsString() marker!: string;
  @IsOptional() @IsString() slideId?: string;
  @IsOptional() @IsString() result?: string;
  @IsOptional() @IsString() intensity?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(100) percentPos?: number;
  @IsOptional() @IsString() score?: string;
  @IsOptional() @IsString() interpretation?: string;
}
class DeliverDto {
  @IsString() channel!: string; // 정본 열거 검증은 서비스(deliverReport)
  @IsOptional() @IsString() recipient?: string;
  @IsOptional() @IsString() note?: string;
}
class CytologyDto {
  @IsString() specimenType!: string;
  @IsOptional() @IsString() adequacy?: string;
  @IsOptional() @IsString() adequacyNote?: string;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() diagnosis?: string;
  @IsOptional() @IsString() status?: string; // 정본 열거 검증은 서비스(upsertCytology)
  @IsOptional() @IsBoolean() amend?: boolean; // 서명된 보고 개정(덮어쓰기 아님)
}
class ScanBlockDto {
  @IsString() event!: string; // 정본 열거 검증은 서비스(scanBlock)
  @IsOptional() @IsString() location?: string;
}
class ScanSlideDto {
  @IsString() event!: string; // 정본 열거 검증은 서비스(scanSlide)
  @IsOptional() @IsString() location?: string;
  @IsOptional() @IsString() wsiRef?: string;
}
class StagingDto {
  @IsOptional() @IsString() pT?: string;
  @IsOptional() @IsString() pN?: string;
  @IsOptional() @IsString() pM?: string;
  @IsOptional() @IsString() stageGroup?: string;
  @IsOptional() @IsString() icdoTopo?: string;
  @IsOptional() @IsString() icdoMorph?: string;
}
class LinkCaseDto {
  @IsString() caseSpNo!: string;
  @IsOptional() @IsString() blockId?: string;
}
class FrozenDto {
  @IsString() frozenDx!: string;
  @IsOptional() @IsIn(CONCORDANCE_VALUES as unknown as string[]) concordance?: string;
}

@ApiTags('Pathology (병리)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(LisRole.PAT, LisRole.ADM)
@Controller('api/v1/pathology')
export class PathologyController {
  constructor(private readonly service: PathologyService) {}

  @Get('cases')
  @ApiOperation({ summary: '병리 워크리스트 — 미완료 기본, 기간(from/to·접수일) 지정 시 완료분 포함' })
  async listCases(@Query('status') status?: string, @Query('assignedTo') assignedTo?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.service.listCases(status, assignedTo, from, to) };
  }

  @Get('cases/:spNo')
  @ApiOperation({ summary: '병리 검사·보고서 조회' })
  async getCase(@Param('spNo') spNo: string) {
    return { data: await this.service.getCase(spNo) };
  }

  @Get('cases/:spNo/tracking')
  @ApiOperation({ summary: '표본 추적(그로싱→블록→슬라이드→보고서)' })
  async tracking(@Param('spNo') spNo: string) {
    return { data: await this.service.tracking(spNo) };
  }

  @Get('cases/:spNo/evidence-context')
  @ApiOperation({ summary: '케이스 근거 종합 번들 — IHC·병기(TNM·ICD-O)·synoptic·세포병리·분자/체세포 소견 통합(판독 검토용, 향후 원내 LLM RAG 컨텍스트). 외부 전송 없음' })
  async evidenceContext(@Param('spNo') spNo: string) {
    return { data: await this.service.evidenceContext(spNo) };
  }

  @Patch('cases/:spNo/info')
  @ApiOperation({ summary: '케이스 임상정보·의뢰의·검체부위·유형 갱신(PP1)' })
  async updateInfo(@Param('spNo') spNo: string, @Body() body: UpdateCaseInfoDto) {
    return { data: await this.service.updateCaseInfo(spNo, body) };
  }

  @Post('cases/:spNo/specimens')
  @ApiOperation({ summary: '다부위 검체 part 추가(A/B/C·검체종류·부위)(PP1)' })
  async addSpecimen(@Param('spNo') spNo: string, @Body() body: SpecimenPartDto) {
    return { data: await this.service.addSpecimen(spNo, body) };
  }

  @Post('cases/:spNo/ihc')
  @ApiOperation({ summary: 'IHC/특수염색 결과 등록(marker·강도·양성%·score)(PP2)' })
  async addIhc(@Param('spNo') spNo: string, @Body() body: IhcDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.addIhcResult(spNo, { ...body, reportedBy: user.userId }) };
  }

  @Get('cases/:spNo/report.html')
  @Header('Content-Type', 'text/html; charset=utf-8')
  @ApiOperation({ summary: '병리 보고서 렌더링(인쇄/포털용 자체완결 HTML)(PP4)' })
  async reportHtml(@Param('spNo') spNo: string): Promise<string> {
    return this.service.renderReport(spNo);
  }

  @Post('cases/:spNo/deliver')
  @ApiOperation({ summary: '병리 보고서 배포 기록(PRINT/PORTAL/PROVIDER/FAX — 최종/개정만)(PP4)' })
  async deliver(@Param('spNo') spNo: string, @Body() body: DeliverDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.deliverReport(spNo, { ...body, deliveredBy: user.userId }) };
  }

  @Get('cases/:spNo/deliveries')
  @ApiOperation({ summary: '병리 보고서 배포 이력(PP4)' })
  async deliveries(@Param('spNo') spNo: string) {
    return { data: await this.service.listDeliveries(spNo) };
  }

  @Post('cases/:spNo/cytology')
  @ApiOperation({ summary: '세포병리 보고 등록·갱신(Pap/FNA·적정성·Bethesda 분류)(PP3)' })
  async cytology(@Param('spNo') spNo: string, @Body() body: CytologyDto, @CurrentUser() user: AuthUser) {
    // 서명자는 Provider 결속 계정에서 유도(미연결이면 403) — 외과 사인아웃과 동일 비신뢰 방어
    return { data: await this.service.upsertCytology(spNo, { ...body, signer: signerOf(user) }) };
  }

  @Post('blocks/:barcode/scan')
  @ApiOperation({ summary: '블록 바코드 스캔(EMBED/CUT 상태전이 + custody 로그)(PP8)' })
  async scanBlock(@Param('barcode') barcode: string, @Body() body: ScanBlockDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.scanBlock(barcode, { ...body, scannedBy: user.userId }) };
  }

  @Post('slides/:barcode/scan')
  @ApiOperation({ summary: '슬라이드 바코드 스캔(SCAN→WSI 결속/SCAN_FAIL + custody 로그)(PP8)' })
  async scanSlide(@Param('barcode') barcode: string, @Body() body: ScanSlideDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.scanSlide(barcode, { ...body, scannedBy: user.userId }) };
  }

  @Get('cases/:spNo/custody')
  @ApiOperation({ summary: '검체 관리연속성(chain-of-custody) — 블록·슬라이드·스캔 이벤트(PP8)' })
  async custody(@Param('spNo') spNo: string) {
    return { data: await this.service.custody(spNo) };
  }

  @Post('cases/:spNo/staging')
  @ApiOperation({ summary: '구조화 병기(AJCC TNM)·종양분류(ICD-O-3) 등록(PP7)' })
  async staging(@Param('spNo') spNo: string, @Body() body: StagingDto) {
    return { data: await this.service.setStaging(spNo, body) };
  }

  @Post('molecular/:molId/link')
  @ApiOperation({ summary: '분자검사 결과를 병리 케이스/블록에 결속(PP5)' })
  async linkMolecular(@Param('molId') molId: string, @Body() body: LinkCaseDto) {
    return { data: await this.service.linkMolecular(molId, body) };
  }

  // NGS 화면(유전체 판독 역할)에서 결속한다 — 병리 역할만 허용하면 결속할 사람이 없다
  @Roles(LisRole.PAT, LisRole.GEN, LisRole.ADM)
  @Post('somatic/:findingId/link')
  @ApiOperation({ summary: '체세포(NGS) 소견을 병리 케이스/블록에 결속(PP5)' })
  async linkSomatic(@Param('findingId') findingId: string, @Body() body: LinkCaseDto) {
    return { data: await this.service.linkSomatic(findingId, body) };
  }

  @Post('cases/:spNo/grossing')
  @ApiOperation({ summary: '그로싱(육안 검사) 기록' })
  async grossing(@Param('spNo') spNo: string, @Body() body: GrossingDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.recordGrossing(spNo, { ...body, grossedBy: user.userId }) };
  }

  @Post('cases/:spNo/blocks')
  @ApiOperation({ summary: '블록(포매) 생성' })
  async block(@Param('spNo') spNo: string, @Body() body: BlockDto) {
    return { data: await this.service.createBlock(spNo, body) };
  }

  @Post('blocks/:blockId/slides')
  @ApiOperation({ summary: '슬라이드 제작(H&E/특수/면역 염색)' })
  async slide(@Param('blockId') blockId: string, @Body() body: SlideDto) {
    return { data: await this.service.createSlide(blockId, body) };
  }

  @Delete('slides/:slideId')
  @ApiOperation({ summary: '슬라이드 삭제(오생성 정리)' })
  async deleteSlide(@Param('slideId') slideId: string) {
    return { data: await this.service.deleteSlide(slideId) };
  }

  @Delete('blocks/:blockId')
  @ApiOperation({ summary: '블록 삭제(슬라이드 없을 때만 — 오생성 정리)' })
  async deleteBlock(@Param('blockId') blockId: string) {
    return { data: await this.service.deleteBlock(blockId) };
  }

  @Get('synoptic-protocols')
  @ApiOperation({ summary: 'CAP synoptic 프로토콜 목록(암종별 필수요소)' })
  async synopticProtocols() {
    return { data: this.service.listSynopticProtocols() };
  }

  @Post('reports/draft')
  @ApiOperation({ summary: '2단계 사인아웃 1단계 — 전공의 초안 작성(상태 초안)' })
  async draft(@Body() body: SignReportDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.draftReport({ ...body, signer: signerOf(user) }) };
  }

  @Post('reports/sign')
  @ApiOperation({ summary: '판독전문의 전자서명 확정(초안→최종, PACS Accession 부여)' })
  async sign(@Body() body: SignReportDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.signReport({ ...body, signer: signerOf(user) }) };
  }

  @Post('reports/:spNo/amend')
  @ApiOperation({ summary: '보고서 개정(최종본 진단 수정·버전 증가·사유 기록)' })
  async amend(@Param('spNo') spNo: string, @Body() body: AmendDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.amendReport(spNo, { ...body, signer: signerOf(user) }) };
  }

  @Post('reports/:spNo/addendum')
  @ApiOperation({ summary: '추가보고(addendum) — 진단 변경 없이 IHC·분자 결과 등 덧붙임' })
  async addendum(@Param('spNo') spNo: string, @Body() body: AddendumDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.addAddendum(spNo, { ...body, addedBy: user.userId }) };
  }

  @Post('cases/:spNo/stain-orders')
  @ApiOperation({ summary: '추가 특수염색/IHC·재검(recut) 오더 요청(B)' })
  async requestStain(@Param('spNo') spNo: string, @Body() body: StainOrderDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.requestStainOrder(spNo, { ...body, requestedBy: user?.userId }) };
  }

  @Patch('stain-orders/:orderId')
  @ApiOperation({ summary: '염색 오더 상태 전이(REQUESTED→IN_PROGRESS→COMPLETED/CANCELLED)(B)' })
  async updateStain(@Param('orderId') orderId: string, @Body() body: StainStatusDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.updateStainOrder(orderId, { ...body, completedBy: user?.userId }) };
  }

  @Post('cases/:spNo/assign')
  @ApiOperation({ summary: '판독의 배정(C)' })
  async assign(@Param('spNo') spNo: string, @Body() body: AssignDto) {
    return { data: await this.service.assignCase(spNo, body.assignedTo) };
  }

  @Post('cases/:spNo/consults')
  @ApiOperation({ summary: '컨설테이션·2차 소견 요청(내부/외부)(D)' })
  async requestConsult(@Param('spNo') spNo: string, @Body() body: ConsultRequestDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.requestConsult(spNo, { ...body, requestedBy: user?.userId }) };
  }

  @Patch('consults/:consultId/respond')
  @ApiOperation({ summary: '컨설트 회신 소견 기입(D)' })
  async respondConsult(@Param('consultId') consultId: string, @Body() body: ConsultRespondDto) {
    return { data: await this.service.respondConsult(consultId, body) };
  }

  @Post('cases/:spNo/reject')
  @ApiOperation({ summary: '접수 검체 부적합·반려(보고 전만)(E)' })
  async reject(@Param('spNo') spNo: string, @Body() body: RejectCaseDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.rejectCase(spNo, { ...body, rejectedBy: user?.userId }) };
  }

  @Post('cases/:spNo/critical')
  @ApiOperation({ summary: '중요·긴급 병리 진단 통보(예상외 악성·불일치·감염 → 의뢰의 read-back)(A)' })
  async raiseCritical(@Param('spNo') spNo: string, @Body() body: CriticalDiagnosisDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.raiseCriticalDiagnosis(spNo, { ...body, raisedBy: user?.userId }) };
  }

  @Post('cases/:spNo/frozen')
  @ApiOperation({ summary: '동결절편 진단 기록(수술중)·영구절편 일치도(concordance)' })
  async frozen(@Param('spNo') spNo: string, @Body() body: FrozenDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.recordFrozen(spNo, { ...body, frozenBy: user.userId }) };
  }
}
