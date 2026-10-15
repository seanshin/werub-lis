/**
 * instrument 모듈 배선(NestJS DI).
 *
 * 컨트롤러: InstrumentController.
 * 프로바이더: InstrumentService.
 * 의존 모듈: ResultModule.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { InstrumentController } from './instrument.controller';
import { InstrumentService } from './instrument.service';
import { ResultModule } from '../result/result.module';

@Module({
  imports: [ResultModule], // 결과 수집 파이프라인 재사용(수기·자동 공통)
  controllers: [InstrumentController],
  providers: [InstrumentService],
})
export class InstrumentModule {}
