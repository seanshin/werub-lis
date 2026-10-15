#!/usr/bin/env bash
# .env 셸 소싱 금지 검증 — 배포/운영 셸 스크립트가 .env를 `. .env` / `source .env`로
# 소싱하지 않는지 확인한다(실행 코드 라인만; 주석·문서 예시는 제외).
#
# 왜: docker의 --env-file은 KEY=VALUE를 문자 그대로 읽지만, 셸 소싱은 값을 해석한다.
# 값에 공백이 있으면(HIS FHIR scope "system/ServiceRequest.read system/...") 셸이 뒤 토큰을
# 명령으로 실행하려다 죽는다 — 2026-07-24 배포가 이 이유로 시작조차 못 하고 중단됐다.
# 스크립트에서 env가 필요하면 `sed -n 's/^KEY=//p'`로 개별 키만 뽑을 것.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

hits=""
for f in infra/scripts/*.sh; do
  [ "$f" = "infra/scripts/check-no-env-sourcing.sh" ] && continue
  # 주석(#로 시작)·빈 줄 제거 후, 줄 시작(또는 ;·&&)에서 `.`/`source`가 .env류를 소싱하는지
  while IFS= read -r line; do
    case "$line" in \#*|'') continue ;; esac
    # 명령 위치의 `. <파일>` 또는 `source <파일>` (파일이 .env 또는 $ENV_FILE)
    if echo "$line" | grep -qE '(^|;|&&)[[:space:]]*(\.|source)[[:space:]]+("?[^;|&]*\.env"?|"?\$\{?ENV_FILE)'; then
      hits="$hits\n  $f: $(echo "$line" | sed 's/^[[:space:]]*//')"
    fi
  done < <(sed 's/#.*//' "$f")  # 인라인 주석 제거
done

if [ -z "$hits" ]; then
  echo "env 소싱 금지 OK (배포 스크립트에 셸 소싱 없음)"
  exit 0
fi

echo ".env 셸 소싱 발견 — 값에 공백이 있으면 배포가 죽는다(2026-07-24 사고):"
printf "%b\n" "$hits"
echo "→ 셸 소싱(. / source) 대신 필요한 키만 sed로 뽑을 것: KEY=\$(sed -n 's/^KEY=//p' \"\$ENV_FILE\" | tail -1)"
exit 1
