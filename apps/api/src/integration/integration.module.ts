/**
 * integration 모듈 배선(NestJS DI).
 *
 * 컨트롤러: IntegrationController, ReflexWebhookController.
 * 프로바이더: IntegrationService, IntegrationHealthService, LabCodeCatalogService.
 * 외부 공개: IntegrationHealthService · IntegrationService — 다른 모듈이 주입해 쓴다.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { IntegrationController } from './integration.controller';
import { ReflexWebhookController } from './reflex-webhook.controller';
import { IntegrationService } from './integration.service';
import { IntegrationHealthService } from './integration-health.service';
import { LabCodeCatalogService } from './lab-code-catalog.service';
import { AuditModule } from '../modules/audit/audit.module';

@Module({
  imports: [AuditModule], // 폴링 경로의 환자 재귀속·취소 전파를 감사 체인에 남긴다
  controllers: [IntegrationController, ReflexWebhookController],
  providers: [IntegrationService, IntegrationHealthService, LabCodeCatalogService],
  // IntegrationService: 시드 정리가 삭제 **전에** PACS 워크리스트 취소 ORM을 보내야 한다(고아 방지).
  exports: [IntegrationHealthService, IntegrationService], // HealthModule /metrics가 연계 게이지 주입
})
export class IntegrationModule {}
