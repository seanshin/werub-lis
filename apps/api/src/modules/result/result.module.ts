/**
 * result 모듈 배선(NestJS DI).
 *
 * 컨트롤러: ResultController.
 * 프로바이더: ResultService, CriticalNotifierService.
 * 의존 모듈: ReflexModule.
 * 외부 공개: ResultService — 다른 모듈이 주입해 쓴다.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { ResultController } from './result.controller';
import { ResultService } from './result.service';
import { CriticalNotifierService } from './critical-notifier.service';
import { ReflexModule } from '../reflex/reflex.module';

@Module({
  imports: [ReflexModule], // Reflex 엔진(승인 프로토콜) 주입
  controllers: [ResultController],
  providers: [ResultService, CriticalNotifierService],
  exports: [ResultService], // 장비 인터페이스 등 다른 모듈에서 결과 수집 재사용
})
export class ResultModule {}
