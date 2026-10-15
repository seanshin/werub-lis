/**
 * pathology 모듈 배선(NestJS DI).
 *
 * 컨트롤러: PathologyController.
 * 프로바이더: PathologyService.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { PathologyController } from './pathology.controller';
import { PathologyService } from './pathology.service';

@Module({
  controllers: [PathologyController],
  providers: [PathologyService],
})
export class PathologyModule {}
