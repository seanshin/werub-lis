/**
 * admin 모듈 배선(NestJS DI).
 *
 * 컨트롤러: LifecycleController, UserAdminController, SeedCleanupController, GoLiveController.
 * 프로바이더: LifecycleService, UserAdminService, SignoffService, SeedCleanupService, GoLiveService.
 * 의존 모듈: AuditModule · IntegrationModule(시드 정리의 PACS 워크리스트 선취소).
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { LifecycleController } from './lifecycle.controller';
import { LifecycleService } from './lifecycle.service';
import { UserAdminController } from './user-admin.controller';
import { UserAdminService } from './user-admin.service';
import { SignoffService } from './signoff.service';
import { SeedCleanupController } from './seed-cleanup.controller';
import { SeedCleanupService } from './seed-cleanup.service';
import { GoLiveController } from './golive.controller';
import { GoLiveService } from './golive.service';
import { GoLiveAttachmentController } from './golive-attachment.controller';
import { GoLiveAttachmentService } from './golive-attachment.service';
import { AuditModule } from '../audit/audit.module';
import { IntegrationModule } from '../../integration/integration.module';

@Module({
  imports: [AuditModule, IntegrationModule],
  controllers: [LifecycleController, UserAdminController, SeedCleanupController, GoLiveController, GoLiveAttachmentController],
  providers: [LifecycleService, UserAdminService, SignoffService, SeedCleanupService, GoLiveService, GoLiveAttachmentService],
})
export class AdminModule {}
