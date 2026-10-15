/**
 * eqa 모듈 배선(NestJS DI).
 *
 * 컨트롤러: EqaController.
 * 프로바이더: EqaService.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { EqaController } from './eqa.controller';
import { EqaService } from './eqa.service';

@Module({
  controllers: [EqaController],
  providers: [EqaService],
})
export class EqaModule {}
