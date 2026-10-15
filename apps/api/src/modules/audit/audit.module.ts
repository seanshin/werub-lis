/**
 * audit 모듈 배선(NestJS DI).
 *
 * 컨트롤러: AuditController.
 * 프로바이더: AuditService, AuditChainService.
 * 외부 공개: AuditChainService — 다른 모듈이 주입해 쓴다.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { AuditChainService } from './audit-chain.service';

@Module({
  controllers: [AuditController],
  providers: [AuditService, AuditChainService],
  exports: [AuditChainService], // 전역 AuditInterceptor가 주입해 체인 append
})
export class AuditModule {}
