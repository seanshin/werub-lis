#!/usr/bin/env bash
# HIS S-3 대상 토큰(X-Target-Token) 검증 — LIS 서명이 HIS에서 유효한지 실측.
#
# 왜 필요한가: HIS가 permissive(토큰 미동봉 통과)여도 **토큰이 있으면 검증**하므로,
# enforce 플립 전에 우리 서명이 맞는지 미리 확인할 수 있다. 플립 후 교차검증에도 그대로 쓴다.
# 기대: 정상 200 / 위조·만료·대상불일치 401.
#
# 사용: ./infra/scripts/his-target-token-check.sh [patientUuid]
set -uo pipefail

ENV_FILE="${ENV_FILE:-$HOME/lis/infra/docker/.env}"
UUID="${1:-00000000-0000-4000-a000-000000d0055a}"

KEY=$(grep "^HIS_INTEGRATION_KEY=" "$ENV_FILE" | cut -d= -f2-)
# 토큰 서명은 분리 시크릿 우선(HIS lis.targetTokenSecret과 대칭). 미설정 시 인증 키 폴백.
TOKSEC=$(grep "^HIS_TARGET_TOKEN_SECRET=" "$ENV_FILE" | cut -d= -f2-)
[ -n "$TOKSEC" ] || TOKSEC="$KEY"
BASE=$(grep "^HIS_INTEGRATION_BASE=" "$ENV_FILE" | cut -d= -f2-)
if [ -z "$BASE" ]; then
  BASE=$(grep "^HIS_FHIR_BASE=" "$ENV_FILE" | cut -d= -f2- | sed "s|/fhir.*||")/api/v1
fi
[ -n "$KEY" ] || { echo "!! HIS_INTEGRATION_KEY 미설정"; exit 1; }

# ★시크릿을 argv에 두지 않는다(2026-07-30 보안 검토).
#   `openssl -hmac "$TOKSEC"`와 `curl -H "x-integration-key: $KEY"`는 공유 호스트의
#   다른 계정이 `ps auxww` 한 번으로 회수할 수 있다 — 회전 직후 이 스크립트가 도는 순간이
#   가장 위험했다. 서명은 env(=/proc/PID/environ, 소유자만 읽기)로, 헤더는 600 설정파일로 넘긴다.
sign() { TOKSEC="$TOKSEC" MSG="$1.$2" python3 -c '
import hmac, hashlib, os
print(hmac.new(os.environ["TOKSEC"].encode(), os.environ["MSG"].encode(), hashlib.sha256).hexdigest())'; }

CURL_CFG="$(mktemp)"; chmod 600 "$CURL_CFG"
trap 'rm -f "$CURL_CFG"' EXIT
printf 'header = "x-integration-key: %s"\n' "$KEY" > "$CURL_CFG"

call() { # $1=토큰  → HTTP 코드
  curl -s -o /dev/null -w "%{http_code}" -K "$CURL_CFG" \
    "$BASE/integration/lis/consent/status?patientId=$UUID&category=TRANSFUSION" \
    -H "X-Target-Token: $1"
}

NOW=$(date +%s); EXP=$((NOW + 300)); OLD=$((NOW - 60))
declare -a NAMES=("정상 토큰" "서명 위조" "만료 토큰" "대상 불일치")
declare -a TOKENS=("$UUID.$EXP.$(sign "$UUID" "$EXP")" "$UUID.$EXP.deadbeef" "$UUID.$OLD.$(sign "$UUID" "$OLD")" "other-uuid.$EXP.$(sign "$UUID" "$EXP")")
declare -a WANT=(200 401 401 401)

fail=0
for i in "${!NAMES[@]}"; do
  code=$(call "${TOKENS[$i]}")
  if [ "$code" = "${WANT[$i]}" ]; then echo "  ✓ ${NAMES[$i]}: $code"; else echo "  ✗ ${NAMES[$i]}: $code (기대 ${WANT[$i]})"; fail=1; fi
done
[ "$fail" = 0 ] && echo "✅ S-3 토큰 규격 일치 — enforce 플립 안전" || echo "❌ 불일치 — 플립 전 원인 확인 필요"
exit $fail
