/**
 * settings 모듈 배선(NestJS DI).
 *
 * 컨트롤러: SettingsController.
 * 프로바이더: SettingsService, NotifyChannelTester.
 * 의존 모듈: AuditModule.
 * 외부 공개: SettingsService — 다른 모듈이 주입해 쓴다.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Global, Module } from '@nestjs/common';
import { SettingsService } from './settings.service';
import { SettingsController } from './settings.controller';
import { NotifyChannelTester } from './notify-tester.service';
import { AuditModule } from '../audit/audit.module';

/**
 * 운영 설정 — 위험치 통보·운영 감시 등 여러 모듈이 읽으므로 @Global.
 * (매 소비 모듈에 import를 추가하는 것보다, 설정 조회를 어디서든 되게 두는 편이
 *  "이 모듈만 옛 env를 읽고 있었다" 같은 누락을 구조적으로 막는다.)
 */
@Global()
@Module({
  imports: [AuditModule],
  controllers: [SettingsController],
  providers: [SettingsService, NotifyChannelTester],
  exports: [SettingsService],
})
export class SettingsModule {}
