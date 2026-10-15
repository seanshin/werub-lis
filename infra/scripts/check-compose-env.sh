#!/usr/bin/env bash
# compose env 배선 검증 — 코드가 읽는 process.env 키가 docker-compose.prod.yml의
# api `environment:`에 등재돼 있는지 확인한다.
#
# 왜: prod compose는 env_file을 쓰지 않아 `environment:`에 명시한 키만 컨테이너에 도달한다.
# 미등재 키는 운영자가 .env에 넣어도 조용히 전달되지 않는다(과거 CRITICAL_WEBHOOK_URL
# 위험치 채널 잠복 미발화, HIS_INTEGRATION_KEY 어댑터 영구 "미구성" 사례).
#
# 예외(EXEMPT)는 아래 목록에 사유와 함께만 추가할 것.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
COMPOSE="infra/docker/docker-compose.prod.yml"

# 컨테이너 이미지·런타임이 이미 보장하는 키(=.env 주입 대상이 아님)
EXEMPT=(
  NODE_ENV            # apps/api/Dockerfile에서 production 고정
  TZ                  # Dockerfile + main.ts에서 Asia/Seoul 고정
  THROTTLER_DISABLED  # 테스트 전용 스위치(운영 미사용)
  HIS_MLLP_HOST       # MLLP 폐기(HIS↔LIS는 FHIR 전용) — 연동 규격서(ICD)
  HIS_MLLP_PORT       # 상동
)

used=$(grep -rhoE "process\.env\.[A-Z0-9_]+" apps/api/src | sed 's/process\.env\.//' | sort -u)
wired=$(grep -oE "^ +[A-Z0-9_]+:" "$COMPOSE" | tr -d ' :' | sort -u)

missing=()
for k in $used; do
  grep -qx "$k" <<<"$wired" && continue
  [[ " ${EXEMPT[*]} " == *" $k "* ]] && continue
  missing+=("$k")
done

if [ ${#missing[@]} -eq 0 ]; then
  echo "compose env 배선 OK (코드 $(wc -w <<<"$used")키 검사)"
  exit 0
fi

echo "compose env 미배선 — .env에 넣어도 컨테이너에 전달되지 않음:"
printf '  - %s\n' "${missing[@]}"
echo "→ $COMPOSE 의 api environment:에 'KEY: \${KEY:-}' 형태로 추가하거나,"
echo "  런타임이 보장하는 키면 이 스크립트의 EXEMPT에 사유와 함께 등재할 것."
exit 1
