/**
 * terminology 모듈 배선(NestJS DI).
 *
 * 컨트롤러: TerminologyController.
 * 프로바이더: TerminologyService.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { TerminologyController } from './terminology.controller';
import { TerminologyService } from './terminology.service';

@Module({
  controllers: [TerminologyController],
  providers: [TerminologyService],
})
export class TerminologyModule {}
