#!/usr/bin/env bash
# LIS 설치 검증 — "떴다"가 아니라 "쓸 수 있다"를 확인한다.
#
# install.sh가 마지막에 호출하고, 이후에도 단독 실행할 수 있다(설치 후 점검·인수인계).
# 읽기 전용 — 아무 상태도 바꾸지 않는다.
#
# 사용: ./infra/install/verify.sh
set -uo pipefail

API="http://127.0.0.1:4101"
WEB="http://127.0.0.1:3101"
fail=0
ok()  { echo "  ✓ $1"; }
bad() { echo "  ✗ $1"; fail=$((fail+1)); }

echo ">> 설치 검증"

# 1. 기동 -------------------------------------------------------------------
for c in lis-postgres lis-api lis-web; do
  if docker ps --format '{{.Names}}' | grep -q "^${c}$"; then ok "$c 기동"; else bad "$c 미기동"; fi
done

code=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/v1/health" || echo 000)
[ "$code" = 200 ] && ok "health 200" || bad "health $code"

code=$(curl -s -o /dev/null -w '%{http_code}' "$WEB/" || echo 000)
[ "$code" = 200 ] && ok "web 200" || bad "web $code"

# 2. 인증 기본값 차단 ---------------------------------------------------------
# 무인증 접근이 열려 있으면 설치가 아니라 사고다.
for p in /api/v1/patients /api/v1/orders /api/v1/audit/verify; do
  code=$(curl -s -o /dev/null -w '%{http_code}' "$API$p" || echo 000)
  [ "$code" = 401 ] && ok "무인증 401 $p" || bad "무인증 응답 $code $p (401이어야 한다)"
done

# 3. 운영 노출 금지 표면 ------------------------------------------------------
code=$(curl -s -o /dev/null -w '%{http_code}' "$API/api/docs" || echo 000)
if [ "$code" = 404 ] || [ "$code" = 401 ]; then ok "Swagger 비노출($code)"; else bad "Swagger가 열려 있다($code)"; fi

# 4. 스키마·데이터 ------------------------------------------------------------
tables=$(docker exec lis-postgres psql -U lis -d lis -tAc \
  "select count(*) from information_schema.tables where table_schema='public'" 2>/dev/null || echo 0)
[ "${tables:-0}" -ge 50 ] && ok "스키마 적재(${tables} 테이블)" || bad "테이블 ${tables}개 — 마이그레이션 확인"

roles=$(docker exec lis-postgres psql -U lis -d lis -tAc "select count(*) from role" 2>/dev/null || echo 0)
[ "${roles:-0}" -ge 10 ] && ok "역할 ${roles}종" || bad "역할 ${roles}종 — 시드 확인"

admins=$(docker exec lis-postgres psql -U lis -d lis -tAc \
  "select count(*) from user_role where role_code='ADM'" 2>/dev/null || echo 0)
[ "${admins:-0}" -ge 1 ] && ok "관리자 계정 ${admins}개" || bad "관리자 계정 없음 — 로그인 불가"

tests=$(docker exec lis-postgres psql -U lis -d lis -tAc "select count(*) from test_master" 2>/dev/null || echo 0)
[ "${tests:-0}" -ge 1 ] && ok "검사 마스터 ${tests}종" || bad "검사 마스터 없음 — 접수 불가"

# 5. 시크릿 위생 --------------------------------------------------------------
ENV_FILE="$(cd "$(dirname "$0")/../.." && pwd)/infra/docker/.env"
if [ -f "$ENV_FILE" ]; then
  perm=$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%A' "$ENV_FILE" 2>/dev/null)
  [ "$perm" = 600 ] && ok ".env 권한 600" || bad ".env 권한 $perm (600이어야 한다)"
  # 값은 출력하지 않는다 — 길이·설정 여부만 본다
  for k in DB_PASSWORD JWT_SECRET; do
    len=$(grep -m1 "^${k}=" "$ENV_FILE" | cut -d= -f2- | tr -d '\r\n' | wc -c | tr -d ' ')
    [ "${len:-0}" -ge 32 ] && ok "$k 길이 충분" || bad "$k 미설정이거나 너무 짧다"
  done
else
  bad ".env 없음"
fi

# 6. 백업 스케줄 --------------------------------------------------------------
# "설치했는데 백업이 안 돌고 있었다"를 설치 검증이 잡아준다.
ROOT_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
if command -v crontab >/dev/null 2>&1 && crontab -l 2>/dev/null | grep -qF "${ROOT_DIR}/infra/scripts/backup.sh"; then
  ok "백업 cron 등록됨"
  # 등록만으로는 부족하다 — 실제 산출물이 있는지 본다.
  BK_DIR="${LIS_BACKUP_DIR:-$HOME/backups/lis}"
  if [ -d "$BK_DIR" ] && [ -n "$(ls -A "$BK_DIR" 2>/dev/null)" ]; then
    ok "백업 파일 존재($(ls -1 "$BK_DIR" | wc -l | tr -d ' ')개)"
  else
    echo "  · 백업 파일 없음 — 첫 실행 전이면 정상. 03:00 이후 재확인할 것"
  fi
else
  bad "백업 cron 미등록 — 백업이 돌지 않는다"
fi

# 7. 개시 전 상태 안내(실패 아님) ----------------------------------------------
echo ">> 개시 전 잔여(설치 실패 아님 — 값·결재 대기)"
wh=$(docker exec lis-postgres psql -U lis -d lis -tAc \
  "select coalesce(value,'') from system_setting where key='CRITICAL_WEBHOOK_URL'" 2>/dev/null || echo "")
case "$wh" in
  "")        echo "  · 위험치 통보 채널 미설정 — /admin/settings (개시 차단 항목)" ;;
  */_seed/*) echo "  · 위험치 통보 채널이 **시드 sink** — 실 채널로 교체 필요(개시 차단)" ;;
  *)         echo "  · 위험치 통보 채널 설정됨 — 테스트 발송으로 도달 확인 권장" ;;
esac
demo=$(docker exec lis-postgres psql -U lis -d lis -tAc \
  "select count(*) from app_user where user_id in ('U01','U02','U03','U04','U05','U06','U07','U08') and status='ACTIVE'" 2>/dev/null || echo 0)
[ "${demo:-0}" -gt 0 ] && echo "  · 데모 계정 ${demo}개 활성 — 운영 설치라면 개시 전 폐기(체크리스트 B1)"

echo
if [ "$fail" = 0 ]; then echo "✅ 설치 검증 통과"; else echo "❌ 실패 ${fail}건 — 위 ✗ 항목 조치"; fi
exit "$fail"
