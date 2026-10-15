/**
 * src 모듈 배선(NestJS DI).
 *
 * 프로바이더: { provide: APP_INTERCEPTOR, useClass: AuditInterceptor }, { provide: APP_GUARD, useClass: AppThrottlerGuard }, // 인증은 기본 차단(default-deny) — 면제는 @Public()을 붙인 핸들러만.     // 순서 주의: throttler가 먼저 평가돼야 미인증 무차별 요청도 레이트리밋에 걸린다.     { provide: APP_GUARD, useClass: JwtAuthGuard }.
 * 의존 모듈: ConfigModule.forRoot({ isGlobal: true }), // 전역 속도 제한: 기본 분당 120회(과도 트래픽·스캐닝 방어)     ThrottlerModule.forRoot({       throttlers: [{ ttl: 60000, limit: 120 }.
 * 배선만 담당하며 로직은 두지 않는다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_INTERCEPTOR, APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppThrottlerGuard } from './common/guards/app-throttler.guard';
import { JwtAuthGuard } from './common/guards/jwt-auth.guard';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { AuditInterceptor } from './common/interceptors/audit.interceptor';
import { PrismaModule } from './infrastructure/prisma/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { HealthModule } from './modules/health/health.module';
import { PatientModule } from './modules/patient/patient.module';
import { OrderModule } from './modules/order/order.module';
import { ResultModule } from './modules/result/result.module';
import { TransfusionModule } from './modules/transfusion/transfusion.module';
import { QcModule } from './modules/qc/qc.module';
import { GenomicModule } from './modules/genomic/genomic.module';
import { MicrobiologyModule } from './modules/microbiology/microbiology.module';
import { PathologyModule } from './modules/pathology/pathology.module';
import { NotificationModule } from './modules/notification/notification.module';
import { MasterModule } from './modules/master/master.module';
import { InstrumentModule } from './modules/instrument/instrument.module';
import { StatsModule } from './modules/stats/stats.module';
import { EqaModule } from './modules/eqa/eqa.module';
import { AuditModule } from './modules/audit/audit.module';
import { SendoutModule } from './modules/sendout/sendout.module';
import { BillingModule } from './modules/billing/billing.module';
import { MolecularModule } from './modules/molecular/molecular.module';
import { NgsModule } from './modules/ngs/ngs.module';
import { AdminModule } from './modules/admin/admin.module';
import { SettingsModule } from './modules/settings/settings.module';
import { CatalogModule } from './modules/catalog/catalog.module';
import { IntegrationModule } from './integration/integration.module';
import { ReflexModule } from './modules/reflex/reflex.module';
import { BarcodeModule } from './modules/barcode/barcode.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { TerminologyModule } from './modules/terminology/terminology.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // 전역 속도 제한: 기본 분당 120회(과도 트래픽·스캐닝 방어)
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60000, limit: 120 }],
      skipIf: () => process.env.THROTTLER_DISABLED === 'true', // E2E에서 rate limit 비활성화
    }),
    EventEmitterModule.forRoot(),
    ScheduleModule.forRoot(),
    PrismaModule,
    AuthModule,
    HealthModule,
    PatientModule,
    OrderModule,
    ResultModule,
    TransfusionModule,
    QcModule,
    GenomicModule,
    MicrobiologyModule,
    PathologyModule,
    NotificationModule,
    MasterModule,
    InstrumentModule,
    StatsModule,
    EqaModule,
    AuditModule,
    SendoutModule,
    BillingModule,
    MolecularModule,
    NgsModule,
    AdminModule,
    SettingsModule,
    CatalogModule,
    IntegrationModule,
    ReflexModule,
    BarcodeModule,
    DashboardModule,
    TerminologyModule,
  ],
  providers: [
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
    { provide: APP_GUARD, useClass: AppThrottlerGuard },
    // 인증은 기본 차단(default-deny) — 면제는 @Public()을 붙인 핸들러만.
    // 순서 주의: throttler가 먼저 평가돼야 미인증 무차별 요청도 레이트리밋에 걸린다.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
  ],
})
export class AppModule {}
