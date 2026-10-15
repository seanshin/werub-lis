#!/usr/bin/env bash
# 마이그레이션 커버리지 검증 — schema.prisma의 모든 @@map 테이블에 대응하는
# CREATE TABLE 마이그레이션이 있는지 확인한다.
#
# 왜: prod는 `prisma migrate deploy`로 마이그레이션만 적용한다(db push 아님). 스키마에 모델을
# 추가하고 마이그레이션 SQL을 빠뜨리면, 로컬·E2E(db push --force-reset)에서는 통과하지만
# **운영에는 테이블이 안 생겨** 그 기능이 첫 호출에서 500을 낸다(개시 후 발견=사고).
# 이 세션에서 SystemSetting·SignoffRecord·CatalogVersion 등을 매번 수기 마이그레이션으로
# 만들었는데, 하나만 잊어도 조용히 새는 구조라 CI가 막는다.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
SCHEMA="apps/api/prisma/schema.prisma"
MIG="apps/api/prisma/migrations"

# schema.prisma가 선언한 물리 테이블(@@map)
declared=$(grep -oE '@@map\("[a-z_]+"\)' "$SCHEMA" | sed -E 's/@@map\("//;s/"\)//' | sort -u)
# 마이그레이션이 실제로 만든 테이블
created=$(grep -rhoE 'CREATE TABLE (IF NOT EXISTS )?"[a-z_]+"' "$MIG" | grep -oE '"[a-z_]+"' | tr -d '"' | sort -u)

missing=()
while IFS= read -r t; do
  [ -z "$t" ] && continue
  grep -qx "$t" <<<"$created" || missing+=("$t")
done <<<"$declared"

if [ ${#missing[@]} -eq 0 ]; then
  echo "마이그레이션 커버리지 OK ($(wc -l <<<"$declared" | tr -d ' ')개 테이블 대조)"
  exit 0
fi

echo "마이그레이션 누락 — schema에 있으나 CREATE TABLE 마이그레이션이 없는 테이블:"
printf '  - %s\n' "${missing[@]}"
echo "→ prod는 migrate deploy만 적용하므로 이 테이블은 운영에 생성되지 않는다(첫 호출 500)."
echo "  apps/api/prisma/migrations/<타임스탬프>_이름/migration.sql 에 CREATE TABLE을 추가할 것."
exit 1
