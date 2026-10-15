/**
 * molecular 모듈 배선(NestJS DI).
 *
 * 컨트롤러: MolecularController.
 * 프로바이더: MolecularService.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { MolecularController } from './molecular.controller';
import { MolecularService } from './molecular.service';

@Module({
  controllers: [MolecularController],
  providers: [MolecularService],
})
export class MolecularModule {}
