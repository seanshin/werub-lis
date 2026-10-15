/**
 * qc 모듈 배선(NestJS DI).
 *
 * 컨트롤러: QcController.
 * 프로바이더: QcService.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { QcController } from './qc.controller';
import { QcService } from './qc.service';

@Module({
  controllers: [QcController],
  providers: [QcService],
})
export class QcModule {}
