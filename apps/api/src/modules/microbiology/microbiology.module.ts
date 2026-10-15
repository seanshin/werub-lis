/**
 * microbiology 모듈 배선(NestJS DI).
 *
 * 컨트롤러: MicrobiologyController.
 * 프로바이더: MicrobiologyService.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { MicrobiologyController } from './microbiology.controller';
import { MicrobiologyService } from './microbiology.service';

@Module({
  controllers: [MicrobiologyController],
  providers: [MicrobiologyService],
})
export class MicrobiologyModule {}
