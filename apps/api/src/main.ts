/**
 * API 부트스트랩 — 전역 파이프·가드·인터셉터·보안 헤더를 여기서 한 번에 건다.
 *
 * 보안·관측 설정이 흩어지면 새 모듈에서 조용히 빠진다. 그래서 전역으로만 건다:
 * helmet · CORS 화이트리스트 · ValidationPipe(whitelist) · correlation id · 감사 인터셉터.
 * ⚠ `trust proxy` 미설정 시 모든 요청이 도커 게이트웨이 단일 IP로 보여 레이트리밋이
 *   전 병원 공용 버킷이 되고 감사 IP가 무의미해진다(`TRUST_PROXY_HOPS`).
 * Swagger는 운영에서 차단한다 — 전체 API 표면·스키마 노출은 정보 수집의 출발점이다.
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AllExceptionsFilter } from './common/filters/all-exceptions.filter';
import { makeLogger } from './common/logging/json-logger';
import { requestIdMiddleware } from './common/request-id';
import { trustProxyHops } from './common/trust-proxy';

// 서버 타임존 (HIS 규약)
process.env.TZ = 'Asia/Seoul';

async function bootstrap(): Promise<void> {
  // 운영은 구조화(JSON) 로거 — 수집·검색·알림 파이프라인 친화(C4 관측성)
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { logger: makeLogger() });

  // 리버스 프록시(nginx) 뒤에서 동작 — 신뢰 홉 수를 지정해야 req.ip가 실제 클라이언트가 된다.
  //   미설정 시 모든 요청이 도커 게이트웨이 단일 IP로 보여 ①레이트리밋이 전 병원 공용 버킷이 되고
  //   ②감사로그 IP가 무의미해진다. TRUST_PROXY_HOPS로 프록시 단수 조정(기본 1 = nginx 1대).
  app.set('trust proxy', trustProxyHops(process.env.TRUST_PROXY_HOPS));

  // JSON 본문 한도 — 기본 100kB면 코드셋 대량 반입(예: ICD-O 수천 행, 스타터셋 없음)이
  //   컨트롤러 도달 전에 raw 413으로 죽어 CATALOG_MAX_ROWS(5000) 안내가 뜨지 않는다.
  //   행 수 상한·인증·역할 게이트가 있으므로 5000행을 여유 있게 담을 4mb로 상향(그 이상은 도메인 가드가 차단).
  app.useBodyParser('json', { limit: '4mb' });

  app.use(helmet());
  app.use(requestIdMiddleware); // correlation id — 모든 응답에 x-request-id, 예외 로그에 rid 결속(P2)
  app.enableCors({
    origin: (process.env.CORS_ORIGIN || 'http://localhost:3100').split(','),
    credentials: true,
    // x-attachment-integrity: 근거 문서가 저장 후 교체됐는지 **화면이 읽어 경고**할 수 있게 한다.
    //   노출하지 않으면 방어가 서버 로그에만 존재한다(2026-07-30 적대 검토).
    exposedHeaders: ['x-request-id', 'x-attachment-integrity'],
  });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: false }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  // Swagger (/api/docs) — 프로덕션 게이팅: 운영에선 전체 API 표면·스키마 노출 차단(정보수집 방지).
  //   개발/스테이징은 노출, 운영은 ENABLE_SWAGGER=true 명시 시에만.
  const swaggerOn = process.env.NODE_ENV !== 'production' || process.env.ENABLE_SWAGGER === 'true';
  if (swaggerOn) {
    const config = new DocumentBuilder()
      .setTitle('LIS API')
      .setDescription('검사정보시스템 API — HIS·PACS 연계 및 유전체 검사 통합')
      .setVersion('0.1.0')
      .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);
  }

  // 무중단 배포: SIGTERM 시 진행 중 요청 드레인·DB 연결 정리 후 종료
  app.enableShutdownHooks();

  const port = Number(process.env.PORT || 4100);
  await app.listen(port);
  console.log(`LIS API listening on http://localhost:${port}${swaggerOn ? ' (docs: /api/docs)' : ' (docs disabled)'}`);
}

// 처리되지 않은 거부·예외는 Node 기본 정책상 프로세스를 죽인다. 죽는 것 자체보다
// **원인이 어디에도 안 남는 것**이 문제라, 종료 전에 반드시 기록한다.
process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandledRejection:', reason instanceof Error ? reason.stack : reason);
});
process.on('uncaughtException', (err) => {
  console.error('[fatal] uncaughtException:', err.stack ?? err);
});

void bootstrap().catch((e) => {
  console.error('[fatal] 부팅 실패:', e instanceof Error ? e.stack : e);
  process.exit(1);
});
