/**
 * reflex 모듈 배선(NestJS DI).
 *
 * 컨트롤러: ReflexController.
 * 프로바이더: ReflexService.
 * 외부 공개: ReflexService — 다른 모듈이 주입해 쓴다.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { ReflexController } from './reflex.controller';
import { ReflexService } from './reflex.service';

@Module({
  controllers: [ReflexController],
  providers: [ReflexService],
  exports: [ReflexService],
})
export class ReflexModule {}
