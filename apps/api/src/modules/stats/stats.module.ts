/**
 * stats 모듈 배선(NestJS DI).
 *
 * 컨트롤러: StatsController.
 * 프로바이더: StatsService.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { StatsController } from './stats.controller';
import { StatsService } from './stats.service';

@Module({
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
