/**
 * Order (오더·접수) HTTP 컨트롤러 — 라우트 20개 (`api/v1/orders`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 * 인가: F-ORD:R, F-RCV:R, F-RCV:W, F-RES:R, F-SPC:R, F-SPC:W.
 * ⚠ 서명·검증 주체는 요청 본문이 아니라 @CurrentUser(JWT)에서 얻는다 — 클라이언트 위조 방지.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Post, Patch, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OrderService } from './order.service';
import { ReceiveSpecimenDto, RejectSpecimenDto, CreateAliquotsDto, CorrectReceiptDto } from './dto/order.dto';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PermissionGuard } from '../../common/guards/permission.guard';
import { RequirePermission } from '../../common/decorators/require-permission.decorator';
import { Feature, Access } from '../../common/rbac/roles';
import { IsString, IsOptional, IsArray, IsBoolean, IsIn, ArrayNotEmpty, Matches } from 'class-validator';
import { CODE_ID_PATTERN, CODE_ID_MESSAGE } from '../../common/validation';
import { CurrentUser, AuthUser } from '../../common/decorators/current-user.decorator';

class CreateOrderDto {
  @IsString() @Matches(CODE_ID_PATTERN, { message: `patientId: ${CODE_ID_MESSAGE}` }) patientId!: string;
  @IsOptional() @IsString() patientName?: string;
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) testCodes!: string[];
  @IsOptional() @IsString() orderingProvider?: string;
  @IsOptional() @IsIn(['R', 'S']) priority?: string; // R=routine / S=stat(응급)
  @IsOptional() @IsBoolean() downtime?: boolean;
  @IsOptional() @IsString() downtimeReason?: string;
}

class ReconcileHisDto {
  @IsString() hisOrderNo!: string;
}

class AddOnDto {
  @IsArray() @ArrayNotEmpty() @IsString({ each: true }) testCodes!: string[];
}

class CancelOrderDto {
  @IsString() reason!: string;
}

class HoldOrderDto {
  @IsBoolean() hold!: boolean;
  @IsOptional() @IsString() reason?: string;
}

@ApiTags('Order (오더·접수)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PermissionGuard)
@Controller('api/v1/orders')
export class OrderController {
  constructor(private readonly service: OrderService) {}

  @Get()
  @RequirePermission(Feature.ORD, Access.R)
  @ApiOperation({ summary: '오더 목록 조회(상태·등록일자 범위 필터·페이지네이션)' })
  async findAll(
    @Query('status') status?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    const r = await this.service.findAll(status, skip ? Number(skip) : 0, take ? Number(take) : 50, from, to);
    return { data: r.rows, meta: { total: r.total, count: r.count, skip: r.skip, take: r.take } };
  }

  @Get('summary')
  @RequirePermission(Feature.ORD, Access.R)
  @ApiOperation({ summary: '기간별 처리 현황 요약(총건수·상태 분포·응급)' })
  async summary(@Query('status') status?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.service.summary(status, from, to) };
  }

  @Get('export')
  @RequirePermission(Feature.ORD, Access.R)
  @ApiOperation({ summary: '기간 오더 평면 내보내기(CSV용, 최대 5000건)' })
  async exportOrders(@Query('status') status?: string, @Query('from') from?: string, @Query('to') to?: string) {
    return { data: await this.service.exportOrders(status, from, to) };
  }

  // ★정적 경로는 반드시 `:orderId` 앞에 둔다 — NestJS는 선언 순서로 매칭하므로
  //   뒤에 두면 /orders/downtime/pending이 :orderId='downtime'으로 먼저 잡힌다.
  @Get('downtime/pending')
  @RequirePermission(Feature.RCV, Access.R)
  @ApiOperation({ summary: '다운타임 오더 대사 대기 목록 — HIS 복구 후 오더번호 연결 대상' })
  async downtimePending() {
    return { data: await this.service.listDowntimePending() };
  }

  @Get(':orderId')
  @RequirePermission(Feature.ORD, Access.R)
  @ApiOperation({ summary: '오더 상세(항목·검체 포함)' })
  async findOne(@Param('orderId') orderId: string) {
    return { data: await this.service.findOne(orderId) };
  }

  @Post()
  @RequirePermission(Feature.RCV, Access.W) // LIS 자체/다운타임 오더 접수: 접수담당
  @ApiOperation({ summary: 'LIS 자체 오더 생성(수기·add-on·다운타임 — HIS 오프라인 접수)' })
  async create(@Body() body: CreateOrderDto) {
    return { data: await this.service.createOrder(body) };
  }

  @Post(':orderId/cancel')
  @RequirePermission(Feature.RCV, Access.W)
  @ApiOperation({ summary: '오더 취소 — 접수 대기/보류 오더 제거(결과·접수검체 없을 때)' })
  async cancelOrder(@Param('orderId') orderId: string, @Body() body: CancelOrderDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.cancelOrder(orderId, body.reason, user.userId) };
  }

  @Post(':orderId/hold')
  @RequirePermission(Feature.RCV, Access.W)
  @ApiOperation({ summary: '오더 보류/해제 — 처방 확인 대기 등(되돌릴 수 있음)' })
  async holdOrder(@Param('orderId') orderId: string, @Body() body: HoldOrderDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.setOrderHold(orderId, body.hold, body.reason, user.userId) };
  }

  @Post(':orderId/reconcile-his')
  @RequirePermission(Feature.RCV, Access.W)
  @ApiOperation({ summary: '다운타임 오더에 HIS 오더번호 사후 연결(대사)' })
  async reconcileHis(@Param('orderId') orderId: string, @Body() body: ReconcileHisDto, @CurrentUser() user: AuthUser) {
    return { data: await this.service.reconcileHisOrderNo(orderId, body.hisOrderNo, user.userId) };
  }

  @Post('receive')
  @RequirePermission(Feature.RCV, Access.W) // 접수: RCP만 (08 매트릭스)
  @ApiOperation({ summary: '검체 접수 · 바코드 발행 · (옵션)분주 자동생성' })
  async receive(@Body() body: ReceiveSpecimenDto) {
    return { data: await this.service.receiveSpecimen(body) };
  }

  @Get(':orderId/completeness')
  @RequirePermission(Feature.ORD, Access.R)
  @ApiOperation({ summary: '오더 완결도(부분보고 추적)' })
  async completeness(@Param('orderId') orderId: string) {
    return { data: await this.service.completeness(orderId) };
  }

  @Get('specimens/worklist')
  @RequirePermission(Feature.RES, Access.R)
  @ApiOperation({ summary: '결과입력 워크리스트(진행 검체)' })
  async specimenWorklist(@Query('status') status?: string, @Query('take') take?: string) {
    return { data: await this.service.specimenWorklist(status, take ? Number(take) : 50) };
  }

  @Get('specimens/:specimenNo/entry')
  @RequirePermission(Feature.RES, Access.R)
  @ApiOperation({ summary: '결과입력 컨텍스트(검체→항목·기존결과)' })
  async specimenEntry(@Param('specimenNo') specimenNo: string) {
    return { data: await this.service.specimenEntry(specimenNo) };
  }

  @Post('specimens/:specimenNo/aliquots')
  @RequirePermission(Feature.SPC, Access.W)
  @ApiOperation({ summary: '검체 분주(Aliquot) 생성 — 분석기별 자검체' })
  async aliquots(@Param('specimenNo') specimenNo: string, @Body() body: CreateAliquotsDto) {
    return { data: await this.service.createAliquots(specimenNo, body) };
  }

  @Post('specimens/:specimenNo/add-on')
  @RequirePermission(Feature.RCV, Access.W)
  @ApiOperation({ summary: 'Add-on 추가검사 — 기존 검체에 검사 항목 추가(재채취 없이)' })
  async addOn(@Param('specimenNo') specimenNo: string, @Body() body: AddOnDto) {
    return { data: await this.service.addOnTests(specimenNo, body.testCodes) };
  }

  @Post('specimens/:specimenNo/reject')
  @RequirePermission(Feature.SPC, Access.W)
  @ApiOperation({ summary: '검체 거부(부적합) · (옵션)재채취 오더 생성' })
  async reject(@Param('specimenNo') specimenNo: string, @Body() body: RejectSpecimenDto) {
    return { data: await this.service.rejectSpecimen(specimenNo, body) };
  }

  @Get('specimens/:specimenNo/label')
  @RequirePermission(Feature.RCV, Access.W) // 라벨 발행
  @ApiOperation({ summary: '검체 라벨(ZPL) 생성 — 프린터 전송용' })
  async label(@Param('specimenNo') specimenNo: string) {
    return { data: await this.service.specimenLabel(specimenNo) };
  }

  @Get('specimens/:specimenNo/timeline')
  @RequirePermission(Feature.SPC, Access.R)
  @ApiOperation({ summary: '검체 추적 타임라인(채취·접수·분주·결과·거부)' })
  async timeline(@Param('specimenNo') specimenNo: string) {
    return { data: await this.service.specimenTimeline(specimenNo) };
  }

  @Patch('specimens/:specimenNo/receipt')
  @RequirePermission(Feature.RCV, Access.W)
  @ApiOperation({ summary: '접수 정정 — 용기·채취시각·채취자 수정(결과 전)' })
  async correctReceipt(@Param('specimenNo') specimenNo: string, @Body() body: CorrectReceiptDto) {
    return { data: await this.service.correctReceipt(specimenNo, body) };
  }

  @Post('specimens/:specimenNo/cancel-receipt')
  @RequirePermission(Feature.RCV, Access.W)
  @ApiOperation({ summary: '접수 취소 — 오접수 되돌리기(RECEIVED·결과 없음만)' })
  async cancelReceipt(@Param('specimenNo') specimenNo: string) {
    return { data: await this.service.cancelReceipt(specimenNo) };
  }
}
