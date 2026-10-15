/**
 * catalog 모듈 배선(NestJS DI).
 *
 * 컨트롤러: CatalogController.
 * 프로바이더: CatalogService.
 * 의존 모듈: AuditModule.
 * 외부 공개: CatalogService — 다른 모듈이 주입해 쓴다.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Global, Module } from '@nestjs/common';
import { CatalogService } from './catalog.service';
import { CatalogController } from './catalog.controller';
import { AuditModule } from '../audit/audit.module';

/** 판정엔진(미생물 등)이 활성 카탈로그를 읽어야 하므로 @Global. */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [CatalogController],
  providers: [CatalogService],
  exports: [CatalogService],
})
export class CatalogModule {}
