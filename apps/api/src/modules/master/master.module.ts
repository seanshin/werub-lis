/**
 * master 모듈 배선(NestJS DI).
 *
 * 컨트롤러: MasterController.
 * 프로바이더: MasterService.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { MasterController } from './master.controller';
import { MasterService } from './master.service';

@Module({
  controllers: [MasterController],
  providers: [MasterService],
})
export class MasterModule {}
