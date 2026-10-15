/**
 * Health HTTP 컨트롤러 — 라우트 1개 (`api/v1/metrics`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, Header, Logger, UseGuards } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { InternalOnlyGuard } from '../../common/guards/internal-only.guard';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';
import { IntegrationHealthService } from '../../integration/integration-health.service';

/**
 * Prometheus 노출 엔드포인트(C4 관측성) — 의존성 없이 text exposition 포맷 직접 생성.
 * 인증은 면제하되 **내부망(루프백·사설대역)에서만** 응답한다 — 스크레이퍼는 프록시를 거치지 말고
 * `127.0.0.1:4101`을 직접 수집할 것. 임상 위험치 미전달·DLQ 적재를 게이지로 내보내
 * 외부 알림룰(Alertmanager)로도 감시할 수 있다.
 *
 * ⚠ 노출값을 '저민감'으로 보지 말 것 — DLQ 깊이와 **미전달 위험치 건수**는 그 자체로
 *   "지금 이 검사실의 통보 체계가 밀려 있다"를 알려 주는 정찰 정보다.
 */
@ApiTags('Health')
// 면제 사유: Prometheus 스크레이퍼가 인증 없이 수집한다.
// ★소스 IP 제한을 프록시(nginx `deny all`)에만 맡겼다가, 2026-09-09 서버 이관에서 프록시가
//   Caddy로 바뀌며 그 차단이 사라져 인터넷에 200으로 열렸다. 이제 앱이 직접 막는다(이중 방어).
// ⚠ '내부'는 루프백이 아니라 **루프백+사설대역**이다 — 컨테이너는 게시 포트로 들어온 호스트 수집을
//   도커 게이트웨이(172.20.0.1) 출발지로 본다. 루프백만 허용하면 내부 수집까지 죽는다(v1.56.15 실측).
//   프록시 측 차단도 그대로 유지한다 — infra/nginx/lis.example.org.conf · docs/서버이관_2026-09-09.md §4-B
@Public()
@UseGuards(InternalOnlyGuard)
@Controller('api/v1/metrics')
export class MetricsController {
  private readonly logger = new Logger('Metrics');
  constructor(
    private readonly prisma: PrismaService,
    private readonly health: IntegrationHealthService,
  ) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4')
  @ApiOperation({ summary: 'Prometheus 지표(프로세스·DB·연계 DLQ/stuck/위험치미전달)' })
  async metrics(): Promise<string> {
    const mem = process.memoryUsage();
    let dbUp = 1;
    try { await this.prisma.$queryRaw`SELECT 1`; } catch { dbUp = 0; }

    let dlqDepth = -1, stuckOutbound = -1, undeliveredCritical = -1, oldestStuck = -1, instrumentFailed = -1, orderCancelFailed = -1, droppedOrders = -1;
    // ★수집 성공 여부를 별도 게이지로 낸다. 실패 시 -1 센티널만 내보내면, 나중에 `> N` 알림 규칙을
    //   붙였을 때 **감시가 고장 난 순간이 가장 건강한 상태로 보인다**(-1은 어떤 임계도 넘지 않는다).
    let collectOk = 0;
    try {
      const m = await this.health.metrics();
      dlqDepth = m.dlqDepth; stuckOutbound = m.stuckOutbound;
      undeliveredCritical = m.undeliveredCritical; oldestStuck = m.oldestStuckAgeMin ?? 0;
      instrumentFailed = m.instrumentFailed; orderCancelFailed = m.orderCancelFailed; droppedOrders = m.droppedOrders;
      collectOk = 1;
    } catch (e) {
      this.logger.error(`연계 지표 수집 실패: ${e instanceof Error ? e.message : e}`);
    }

    const lines = [
      g('lis_process_uptime_seconds', '프로세스 가동시간', Math.round(process.uptime())),
      g('lis_process_resident_memory_bytes', 'RSS 메모리', mem.rss),
      g('lis_nodejs_heap_used_bytes', '힙 사용', mem.heapUsed),
      g('lis_db_up', 'DB 연결(1=up)', dbUp),
      g('lis_integration_dlq_depth', 'OUTBOUND DLQ 격리 건수(-1=수집실패)', dlqDepth),
      g('lis_integration_stuck_outbound', '발신 정체 건수', stuckOutbound),
      g('lis_integration_oldest_stuck_minutes', '최고령 정체(분)', oldestStuck),
      g('lis_integration_undelivered_critical', '미확인 위험치 통보(ack 전)', undeliveredCritical),
      g('lis_integration_instrument_failed', '장비 결과 수집 실패·부분실패', instrumentFailed),
      g('lis_integration_order_cancel_failed', 'HIS 오더 취소 적용 실패(취소된 검사 계속 수행 위험)', orderCancelFailed),
      g('lis_integration_dropped_orders', '미적재 HIS 오더 대기(접수 누락 — 재폴링 안 됨)', droppedOrders),
      g('lis_metrics_collect_ok', '연계 지표 수집 성공(1=ok, 0=수집실패 → 위 값은 -1)', collectOk),
    ];
    return lines.join('') ;
  }
}

/** Prometheus gauge 한 항목(HELP/TYPE/값). */
function g(name: string, help: string, value: number): string {
  return `# HELP ${name} ${help}\n# TYPE ${name} gauge\n${name} ${value}\n`;
}
