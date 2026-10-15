# LIS API 프로덕션 이미지 (빌드 컨텍스트 = 리포 루트)
FROM node:20-alpine AS build
WORKDIR /app
# 워크스페이스 매니페스트 먼저(캐시 최적화)
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/
# npm ci: lockfile 고정 설치(재현 가능한 빌드). npm install은 semver 범위 내 최신을 끌어와
# '검증한 이미지'와 '배포된 이미지'가 달라질 수 있고, 공급망 침해 시 lockfile 방어선이 무력해진다.
RUN npm ci
# 소스
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN npx prisma generate --schema apps/api/prisma/schema.prisma
# @lis/shared를 먼저 CJS로 빌드한다. API는 tsc 산출물이라 런타임에 require('@lis/shared')를
# 하므로, 원시 TS만 있으면 컨테이너가 MODULE_NOT_FOUND로 죽는다(v1.4.0 배포에서 실제 발생).
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=apps/api

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV TZ=Asia/Seoul
COPY --from=build --chown=node:node /app/node_modules ./node_modules
# node_modules/@lis/shared는 워크스페이스 심링크(→ ../../packages/shared)다.
# 심링크만 복사되고 대상이 없으면 기동 즉시 MODULE_NOT_FOUND.
COPY --from=build --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=build --chown=node:node /app/packages/shared/package.json ./packages/shared/
COPY --from=build --chown=node:node /app/apps/api/dist ./apps/api/dist
COPY --from=build --chown=node:node /app/apps/api/package.json ./apps/api/
COPY --from=build --chown=node:node /app/apps/api/prisma ./apps/api/prisma
WORKDIR /app/apps/api
# 비-root 실행 — 공유 호스트(HIS 등 타 서비스 동거)에서 컨테이너 탈출 시 피해를 줄인다.
USER node
EXPOSE 4100
# 시작 시 리뷰된 마이그레이션 적용(prisma migrate deploy — 이력·롤백·데이터손실 방지) 후 기동.
# 기존 db push 운영 DB는 0_init을 baseline(migrate resolve --applied)으로 채택해 전환함.
# 향후 스키마 변경: 로컬 `prisma migrate dev --name X` → 커밋 → 기동 시 자동 적용.
# RUN_MIGRATIONS=off면 마이그레이션을 건너뛰고 기동만 — blue-green green 컨테이너용(스키마 변경은
# 전환 전 1회 별도 적용, 부팅 경합·blue와의 동시 적용 회피). 미설정(기본)=적용(표준 compose 배포).
CMD ["sh", "-c", "if [ \"$RUN_MIGRATIONS\" = off ]; then echo '[start] RUN_MIGRATIONS=off — 마이그레이션 생략'; else npx prisma migrate deploy; fi && node dist/main"]
