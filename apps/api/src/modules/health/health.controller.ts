/**
 * Health HTTP 컨트롤러 — 라우트 2개 (`api/v1/health`).
 *
 * 비즈니스 로직은 같은 폴더의 서비스에 위임하고, 여기서는 인가·검증·응답 형태만 책임진다.
 * 모든 응답은 `{ data }` 봉투로 감싼다(목록 페이지네이션은 `{ data, meta }`).
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Controller, Get, ServiceUnavailableException, Logger } from '@nestjs/common';
import { Public } from '../../common/decorators/public.decorator';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@ApiTags('Health')
// 면제 사유: 로드밸런서·컨테이너 헬스체크가 인증 없이 호출한다. 반환은 up/down·타임스탬프뿐(PHI 없음).
@Public()
@Controller('api/v1/health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);
  constructor(private readonly prisma: PrismaService) {}

  /** 라이브니스 — 프로세스 생존만(DB 무관). 오케스트레이터 재시작 판단용. */
  @Get('live')
  @ApiOperation({ summary: '라이브니스(프로세스 생존)' })
  live() {
    return { data: { status: 'ok', ts: new Date().toISOString() } };
  }

  /** 레디니스 — DB 연결 실패 시 503(트래픽 제외·배포 게이트 차단). */
  @Get()
  @ApiOperation({ summary: '레디니스 체크(DB 연결 포함) — DB 다운 시 503' })
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch (e) {
      this.logger.error(`헬스체크 DB 연결 실패: ${e instanceof Error ? e.message : e}`);
      throw new ServiceUnavailableException({ status: 'error', db: 'down', ts: new Date().toISOString() });
    }
    return { data: { status: 'ok', db: 'up', ts: new Date().toISOString() } };
  }
}
