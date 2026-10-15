/**
 * patient 모듈 배선(NestJS DI).
 *
 * 컨트롤러: PatientController.
 * 프로바이더: PatientService.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { PatientController } from './patient.controller';
import { PatientService } from './patient.service';

@Module({
  controllers: [PatientController],
  providers: [PatientService],
})
export class PatientModule {}
