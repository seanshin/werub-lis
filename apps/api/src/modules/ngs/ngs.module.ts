/**
 * ngs 모듈 배선(NestJS DI).
 *
 * 컨트롤러: NgsController.
 * 프로바이더: NgsService.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { NgsController } from './ngs.controller';
import { NgsService } from './ngs.service';

@Module({
  controllers: [NgsController],
  providers: [NgsService],
})
export class NgsModule {}
