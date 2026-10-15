#!/usr/bin/env bash
# 파일럿 정리 분류 완전성 검증 — schema.prisma의 모든 @@map 테이블이
# pilot-cleanup.sql에서 '정리(TRUNCATE)' 또는 '보존' 중 하나로 **명시 분류**돼 있는지 확인한다.
#
# 왜: 개시 전 파일럿 정리는 "무엇을 지우고 무엇을 남기나"를 테이블 단위로 정해야 한다.
# 새 테이블을 추가하고 분류를 빠뜨리면, 정리 때 조용히 살아남거나(데모가 실개시에 섞임)
# 반대로 실수로 지워진다(설정 소실). 어느 리스트에도 없는 테이블 = 결정 안 된 사고 후보.
# 새 모델을 만들면 이 가드가 "정리냐 보존이냐"를 강제한다.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
SCHEMA="apps/api/prisma/schema.prisma"
SQL="infra/scripts/pilot-cleanup.sql"

declared=$(grep -oE '@@map\("[a-z_]+"\)' "$SCHEMA" | sed -E 's/@@map\("//;s/"\)//' | sort -u)
# 스크립트에 이름이 등장하면 분류된 것으로 본다(TRUNCATE 리스트 또는 보존 SELECT의 IN 목록).
# 단어 경계로 매칭해 부분일치(catalog_item vs catalog_item_x) 오탐 방지.

missing=()
while IFS= read -r t; do
  [ -z "$t" ] && continue
  grep -qE "(^|[^a-z_])${t}([^a-z_]|\$)" "$SQL" || missing+=("$t")
done <<<"$declared"

if [ ${#missing[@]} -eq 0 ]; then
  echo "파일럿 정리 분류 OK ($(wc -l <<<"$declared" | tr -d ' ')개 테이블 전수 분류됨)"
  exit 0
fi

echo "파일럿 정리 미분류 — 개시 정리 시 지울지/남길지 안 정해진 테이블:"
printf '  - %s\n' "${missing[@]}"
echo "→ $SQL 에서 결정할 것:"
echo "  · 파일럿 데이터(지움)  → ② TRUNCATE 목록 + ① DRY-RUN '정리 대상' IN 목록에 추가"
echo "  · 설정/마스터(남김)    → '보존 대상' IN 목록에 추가"
exit 1
