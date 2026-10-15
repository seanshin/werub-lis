# LIS Web 프로덕션 이미지 (빌드 컨텍스트 = 리포 루트)
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
# lockfile 고정 설치(재현 가능한 빌드)
RUN npm ci
COPY packages/shared packages/shared
COPY apps/web apps/web
# same-origin(nginx 프록시) → 상대경로 fetch. 절대 URL 필요 시 빌드 arg로 override.
ARG NEXT_PUBLIC_API_URL=""
ENV NEXT_PUBLIC_API_URL=${NEXT_PUBLIC_API_URL}
# 데모 계정 패널·자동입력 — 기본 OFF(보안). 파일럿 시 빌드 arg로 "1" 주입, 실 개시 전 반드시 "".
ARG NEXT_PUBLIC_DEMO=""
ENV NEXT_PUBLIC_DEMO=${NEXT_PUBLIC_DEMO}
# @lis/shared를 먼저 CJS로 빌드한다. API는 tsc 산출물이라 런타임에 require('@lis/shared')를
# 하므로, 원시 TS만 있으면 컨테이너가 MODULE_NOT_FOUND로 죽는다(v1.4.0 배포에서 실제 발생).
RUN npm run build --workspace=packages/shared
RUN npm run build --workspace=apps/web

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV TZ=Asia/Seoul
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/apps/web/.next ./apps/web/.next
COPY --from=build --chown=node:node /app/apps/web/package.json ./apps/web/
COPY --from=build --chown=node:node /app/apps/web/next.config.ts ./apps/web/
# ★정적 자산(public/) — 빠뜨리면 next start가 404를 내는데 화면은 그대로 뜬다.
#   서체가 404면 조용히 시스템 글꼴로 폴백돼 "배포는 됐는데 인상만 다른" 상태가 되고,
#   아무도 오류를 못 본다(2026-07-29 실제로 겪음 — public/이 비어 있어 잠복해 있었다).
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public
WORKDIR /app/apps/web
# 비-root 실행(공유 호스트 격리)
USER node
EXPOSE 3100
CMD ["npx", "next", "start", "-p", "3100"]
