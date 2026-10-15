/**
 * notification 모듈 배선(NestJS DI).
 *
 * 컨트롤러: NotificationController.
 * 프로바이더: NotificationService.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { NotificationController } from './notification.controller';
import { NotificationService } from './notification.service';

@Module({
  controllers: [NotificationController],
  providers: [NotificationService],
})
export class NotificationModule {}
