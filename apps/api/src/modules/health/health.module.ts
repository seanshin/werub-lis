/**
 * health 모듈 배선(NestJS DI).
 *
 * 컨트롤러: HealthController, MetricsController.
 * 의존 모듈: IntegrationModule.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { MetricsController } from './metrics.controller';
import { IntegrationModule } from '../../integration/integration.module';

@Module({
  imports: [IntegrationModule], // /metrics가 IntegrationHealthService(연계 게이지) 주입
  controllers: [HealthController, MetricsController],
})
export class HealthModule {}
