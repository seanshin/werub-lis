/**
 * order 모듈 배선(NestJS DI).
 *
 * 컨트롤러: OrderController.
 * 프로바이더: OrderService.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { OrderController } from './order.controller';
import { OrderService } from './order.service';

@Module({
  controllers: [OrderController],
  providers: [OrderService],
})
export class OrderModule {}
