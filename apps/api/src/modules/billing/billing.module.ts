/**
 * billing 모듈 배선(NestJS DI).
 *
 * 컨트롤러: BillingController.
 * 프로바이더: BillingService.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

@Module({
  controllers: [BillingController],
  providers: [BillingService],
})
export class BillingModule {}
