#!/usr/bin/env bash
# LIS 로컬 CI 게이트 — git push srv 전 필수 실행(개시 전 백로그 C1).
# typecheck·lint·unit·build를 순차 실행, 하나라도 실패하면 비0 종료(푸시 금지 신호).
# E2E는 DB가 필요하므로 기본 제외 — CI_RUN_E2E=1 + DATABASE_URL(테스트 DB) 지정 시에만 실행.
# 사용: ./infra/scripts/ci.sh   (실패 시 exit≠0)
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

FAIL=0
step() { # $1=이름  $2...=명령  — 실패 시 게이트 차단
  local name="$1"; shift
  echo ""; echo "▶ $name"
  if "$@"; then echo "  ✓ $name"; else echo "  ✗ $name 실패"; FAIL=1; fi
}
soft() { # $1=이름  $2...=명령  — 실패해도 경고만(게이트 비차단). 툴 미구성 등.
  local name="$1"; shift
  echo ""; echo "▶ $name (soft)"
  if "$@"; then echo "  ✓ $name"; else echo "  ⚠ $name 경고(비차단) — 미구성/미설치 가능"; fi
}

step "api typecheck"  npx tsc --noEmit -p apps/api/tsconfig.json
step "web typecheck"  npm run --silent typecheck --workspace=apps/web
# lint: eslint.config.mjs(D2) 활성화 완료(C1) — api+web 통합 flat config, 위반 0. 차단 게이트.
# ★--max-warnings=0 (2026-07-30). 경고를 비차단으로 두니 8건이 쌓였고, 그중 하나가 실제 결함이었다 —
#   `react-hooks/exhaustive-deps` 경고가 위탁 화면의 **기간 필터가 통째로 무시되던 버그**를 정확히
#   가리키고 있었는데 아무도 보지 않았다(웹은 테스트 하네스가 없어 lint가 유일한 탐지 수단이다).
#   경고가 쌓이면 신규 경고가 묻힌다 — 0을 유지해야 다음 경고가 눈에 띈다.
step "lint(eslint)"   npx eslint --max-warnings=0 "apps/api/src/**/*.ts" "apps/api/test/**/*.ts" "apps/web/src/**/*.{ts,tsx}"
step "api unit"       npm run --silent test --workspace=apps/api
step "build(turbo)"   npm run --silent build
# compose env 배선 — 미등재 키는 .env에 넣어도 컨테이너 미전달(잠복 블로커). 차단 게이트.
step "compose env"    ./infra/scripts/check-compose-env.sh
# nav 도달성 — 신규 화면이 사이드바/진입점 없이 배포되는 것 방지(2026-07-24 사고). 차단 게이트.
step "nav coverage"   ./infra/scripts/check-nav-coverage.sh
# 마이그레이션 커버리지 — schema 모델에 마이그레이션 누락 시 prod에 테이블 안 생김(첫 호출 500). 차단.
step "migration cov"   ./infra/scripts/check-migration-coverage.sh
# .env 셸 소싱 금지 — 값에 공백 있으면 배포가 죽음(2026-07-24 사고). 차단.
step "env sourcing"    ./infra/scripts/check-no-env-sourcing.sh
# 파일럿 정리 분류 — 신규 테이블이 개시 정리에서 지울지/남길지 미분류로 새는 것 방지. 차단.
step "cleanup cov"     ./infra/scripts/check-cleanup-coverage.sh
step "seed ext facts"  ./infra/scripts/check-seed-external-facts.sh
# 색 대비 — 토큰을 손으로 고치면 대비가 조용히 깨진다(라이트 warn 2.96:1 전례, 11px 배지 판독불가).
#   "바꿀 때 재측정" 규칙을 사람 기억에 맡기지 않는다. 차단.
step "color contrast"  node ./infra/scripts/check-contrast.mjs
# 색 토큰 사용 — Tailwind는 미정의 색으로 유틸을 만들면 클래스를 생성하지 않는다(무경고).
#   `bg-brand text-white` 버튼이 흰 배경에 흰 글자로 사라져 있었다(수혈·QC 4곳). 차단.
step "color tokens"    node ./infra/scripts/check-color-tokens.mjs
# 환자 병합 커버리지 — patientId 신설 테이블이 병합에서 누락되면 청구 오귀속·이력 분절. 차단.
step "merge coverage"  ./infra/scripts/check-merge-coverage.sh

if [ "${CI_RUN_E2E:-0}" = "1" ]; then
  if [ -n "${DATABASE_URL:-}" ]; then
    step "api e2e"    npm run --silent test:e2e --workspace=apps/api
  else
    echo ""; echo "▶ api e2e — DATABASE_URL 미지정 → 건너뜀(서버 E2E로 검증)"
  fi
fi

echo ""
if [ "$FAIL" -eq 0 ]; then
  echo "✅ CI 통과 — push 가능"
else
  echo "❌ CI 실패 — 위 항목 수정 후 재실행(push 금지)"
fi
exit "$FAIL"
