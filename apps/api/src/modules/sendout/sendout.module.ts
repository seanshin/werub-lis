/**
 * sendout 모듈 배선(NestJS DI).
 *
 * 컨트롤러: SendoutController.
 * 프로바이더: SendoutService.
 * 의존 모듈: ResultModule.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { SendoutController } from './sendout.controller';
import { SendoutService } from './sendout.service';
import { ResultModule } from '../result/result.module';

@Module({
  imports: [ResultModule], // 위탁 회신값을 정본 결과 경로로 적재(판정·위험치·델타 공유)
  controllers: [SendoutController],
  providers: [SendoutService],
})
export class SendoutModule {}
