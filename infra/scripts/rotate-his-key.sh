#!/usr/bin/env bash
# HIS 통합 시크릿 회전 — 회전 창(window)을 최소화하는 한 명령.
#
# 왜 필요한가: HIS `assertLisKey`는 단일 키 비교라, HIS가 키를 회전한 순간부터
# LIS가 새 값으로 재기동할 때까지 **동의 조회가 401(available:false → 수기 폴백)** 이 된다.
# 손으로 하면 .env 편집·재기동·검증에 수 분이 걸린다. 이 스크립트는 그 구간을 수십 초로 줄인다.
#
# ★구축팀은 평문 시크릿을 취급하지 않는다 — 이 스크립트도 **값을 출력하지 않는다**(md5 지문만).
#   운영자가 HIS에서 받은 파일을 ~/secrets/에 두면, 스크립트는 읽어서 반영만 한다.
#
# 사용:
#   ./infra/scripts/rotate-his-key.sh ~/secrets/lis-integration-key.env          # integrationKey 회전(②)
#   ./infra/scripts/rotate-his-key.sh ~/secrets/lis-target-token.env --token     # 토큰 시크릿 회전(③)
#
# 입력 파일 형식(둘 중 하나):
#   HIS_INTEGRATION_KEY=<값>        (또는)        <값>만 한 줄
set -euo pipefail

SRC="${1:-}"
MODE="${2:-}"
ENV_FILE="${ENV_FILE:-$HOME/lis/infra/docker/.env}"
COMPOSE="$HOME/lis/infra/docker/docker-compose.prod.yml"

[ -n "$SRC" ] && [ -f "$SRC" ] || { echo "!! 시크릿 파일 없음: ${SRC:-(미지정)}"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "!! .env 없음: $ENV_FILE"; exit 1; }

if [ "$MODE" = "--token" ]; then
  KEYNAME="HIS_TARGET_TOKEN_SECRET"; LABEL="S-3 토큰 서명 시크릿(③)"
else
  KEYNAME="HIS_INTEGRATION_KEY";     LABEL="통합 인증 키(②)"
fi

# 값 추출 — KEY=VALUE 형식이면 그 값, 아니면 파일 첫 줄 전체
NEW=$(grep -m1 "^${KEYNAME}=" "$SRC" 2>/dev/null | cut -d= -f2- || true)
[ -n "$NEW" ] || NEW=$(head -1 "$SRC")
NEW=$(printf '%s' "$NEW" | tr -d '\r\n')
[ -n "$NEW" ] || { echo "!! 값이 비었다: $SRC"; exit 1; }

fp() { printf '%s' "$1" | md5sum | cut -c1-12; }
OLD=$(grep -m1 "^${KEYNAME}=" "$ENV_FILE" | cut -d= -f2- || true)

echo ">> $LABEL 회전"
# ★값을 절대 찍지 않는다. `${OLD:+A}${OLD:-B}`는 OLD가 설정돼 있으면 A와 **OLD 자신**을
#   둘 다 내보낸다(`:-`는 설정된 값을 그대로 반환) — 실제로 이 줄에서 키가 유출됐다(2026-07-29).
if [ -n "$OLD" ]; then echo "   현재 md5: $(fp "$OLD")"; else echo "   현재: (미설정)"; fi
echo "   신규 md5: $(fp "$NEW")   ← HIS와 이 값이 일치하는지 교차확인"
if [ "$OLD" = "$NEW" ]; then echo ">> 값이 동일 — 회전 불필요. 종료"; exit 0; fi

cp -p "$ENV_FILE" "${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
if grep -q "^${KEYNAME}=" "$ENV_FILE"; then
  # 값에 / & 가 있어도 안전하도록 구분자 회피 + 리터럴 치환
  tmp=$(mktemp); NEWVAL="$NEW" KN="$KEYNAME" awk -F= 'BEGIN{k=ENVIRON["KN"];v=ENVIRON["NEWVAL"]}
    $1==k {print k "=" v; next} {print}' "$ENV_FILE" > "$tmp" && mv "$tmp" "$ENV_FILE"
else
  printf '%s=%s\n' "$KEYNAME" "$NEW" >> "$ENV_FILE"
fi
chmod 600 "$ENV_FILE"
echo ">> .env 반영(백업 보관). api 재기동 — 이 구간이 회전 창이다"

docker compose -p lis --env-file "$ENV_FILE" -f "$COMPOSE" up -d --no-deps api >/dev/null 2>&1
until curl -sf -o /dev/null http://127.0.0.1:4101/api/v1/health; do sleep 1; done
echo ">> api healthy"

echo ">> 검증(S-3 교차검증 — 정상 200 / 위조·만료·대상불일치 401 기대)"
"$HOME/lis/infra/scripts/his-target-token-check.sh" || { echo "!! ❌ 검증 실패 — HIS 키 일치 여부·enforce 상태 확인"; exit 1; }
echo ">> ✅ 회전 완료·검증 통과"

# 검증까지 통과했으면 옛 값은 더 이상 필요 없다. 회전 사유가 "노출"인 경우 백업에 남은
# 구 시크릿이 그대로 서버에 쌓이는 것이 문제라(2026-07-30 보안 검토), 방금 만든 백업만
# 남기고 이전 세대는 지운다. 롤백 창은 직전 1세대로 충분하다.
find "$(dirname "$ENV_FILE")" -maxdepth 1 -name "$(basename "$ENV_FILE").bak-*" -type f \
  | sort | head -n -1 | while read -r old; do shred -u "$old" 2>/dev/null || rm -f "$old"; done
echo ">> 이전 세대 .env 백업 정리(직전 1세대만 보존)"
