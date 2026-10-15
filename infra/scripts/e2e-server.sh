#!/usr/bin/env bash
# 서버 E2E 게이트 — 반드시 별도 lis_test DB에서만 실행(운영 lis DB 절대 미접근).
# 로컬 개발기엔 Postgres가 없어 E2E는 서버(deploy@203.0.113.10:22)의 lis-postgres 컨테이너 lis_test로 돈다.
# 사용: 서버 ~/his-backup/weruby/lis 에서  ./infra/scripts/e2e-server.sh   (deploy.sh --build 전에 자동 호출됨)
#   ※경로·호스트는 2026-09-09 서버 이관 반영 — docs/서버이관_2026-09-09.md
#
# ★안전장치: DATABASE_URL은 이 스크립트가 lis_test로 **고정**한다(인자로 안 받는다).
#   db push --force-reset가 데이터를 지우므로, 운영 lis로 향할 여지를 구조적으로 차단.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/infra/docker/.env"
[[ -f "$ENV_FILE" ]] || { echo "!! $ENV_FILE 없음 — E2E 게이트 실행 불가"; exit 1; }

NET="${E2E_NETWORK:-lis_default}"
echo ">> E2E 게이트(lis_test, network=$NET) — 운영 DB 미접근, --force-reset로 초기화"

# ★컨테이너를 호출자 권한으로 돌린다 — 기본(root)로 두면 마운트된 워크트리에 root 소유
#   node_modules/.prisma가 생겨 이후 호스트에서의 npm 조작이 EACCES로 막힌다.
#   HOME·npm 캐시는 /tmp로 돌린다(컨테이너 안 홈이 없다).
docker run --rm --network "$NET" --user "$(id -u):$(id -g)" \
  -e HOME=/tmp -e npm_config_cache=/tmp/.npm \
  -v "$ROOT":/app -w /app/apps/api --env-file "$ENV_FILE" node:22 sh -c '
  # ★의존성이 없으면 스스로 설치한다.
  #   2026-09-09 서버 이관에서 실제로 걸렸다 — 백업에 node_modules가 빠져 복구된 워크트리에는
  #   없었는데, 이미지 빌드는 컨테이너 안에서 자체 설치하므로 이 결핍이 **배포 직전 게이트에서야**
  #   `sh: 1: vitest: not found`로 드러났다. 게이트는 새 호스트에서도 그냥 돌아야 한다.
  if [ ! -x /app/node_modules/.bin/vitest ]; then
    echo ">> node_modules 없음 — 워크스페이스 루트에서 npm ci 수행(최초 1회, 수 분)"
    (cd /app && npm ci) || { echo "!! npm ci 실패 — 게이트 중단"; exit 1; }
  fi
  # ★lis_test 고정 — 운영 lis 절대 금지
  export DATABASE_URL="postgresql://lis:${DB_PASSWORD:-lis}@lis-postgres:5432/lis_test?schema=public"
  # "미구성 가정" 테스트(HIS/PACS 미연동·ERP 미구성)를 위해 관련 env를 언셋(--env-file 유입 차단)
  # ★실 발신 차단(2026-07-30 보안 검토): CRITICAL/OPS 웹훅·HIS 통합 키가 남으면
  #   운영 .env에 실 채널을 주입한 날부터 배포마다 테스트가 실 온콜 채널·실 HIS로 발신한다.
  unset HIS_FHIR_BASE HIS_FHIR_TOKEN_URL HIS_CLIENT_ID HIS_CLIENT_SECRET HIS_FHIR_SCOPES \
        HIS_ORDER_POLL HIS_REFLEX_POLL HIS_REFLEX_RETRY HIS_MLLP_HOST HIS_MLLP_PORT \
        PACS_BASE PACS_USER PACS_PASSWORD PACS_MLLP_HOST PACS_MLLP_PORT \
        ERP_BILLING_URL ERP_BILLING_SECRET \
        CRITICAL_WEBHOOK_URL CRITICAL_WEBHOOK_SECRET CRITICAL_WEBHOOK_ALLOW_HTTP OPS_WEBHOOK_URL \
        HIS_INTEGRATION_BASE HIS_INTEGRATION_KEY HIS_TARGET_TOKEN_SECRET HIS_REFLEX_WEBHOOK_TOKEN
  npx prisma generate >/dev/null 2>&1          # 스키마 변경 반영(구 클라이언트 500 방지)
  npx prisma db push --force-reset --skip-generate --accept-data-loss >/dev/null 2>&1
  npm run --silent test:e2e
'
echo ">> ✅ E2E 게이트 통과"
