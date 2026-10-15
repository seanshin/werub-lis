/**
 * genomic 모듈 배선(NestJS DI).
 *
 * 컨트롤러: GenomicController.
 * 프로바이더: GenomicService.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { GenomicController } from './genomic.controller';
import { GenomicService } from './genomic.service';

@Module({
  controllers: [GenomicController],
  providers: [GenomicService],
})
export class GenomicModule {}
