#!/usr/bin/env bash
# LIS 사이트 설치 — 준비된 호스트(Docker + compose) → 동작하는 LIS까지.
#
# 배포 형태: **사이트 = 서버 = DB (1:1:1)**. 멀티테넌트가 아니다.
#   근거 docs/개시전환센터_기획서.md §6.0 · docs/실서비스_서버분리_설계.md §0
#
# 이 스크립트가 하는 일 / 하지 않는 일
#   한다   : 사전점검 · .env 생성(**시크릿 자동 생성**) · 빌드 · 기동 · 마이그레이션 확인
#            · starter 시드 · **백업 cron 등록** · 스모크 검증 · 관리자 초기 비밀번호 1회 출력
#   안 한다: OS·Docker 설치 · 방화벽 · TLS 인증서 · DNS · 백업 대상 스토리지 마련
#            (그건 호스트 준비 몫 — AWS 구성은 docs/실서비스_구축절차서.md)
#
# 사용:
#   ./infra/install/install.sh --site-code <코드> --origin https://<도메인> [--with-demo] [--no-backup-cron]
#   ./infra/install/install.sh --help
#
# ★안전 원칙
#   - **기존 .env를 절대 덮어쓰지 않는다**(있으면 중단). 시크릿 유실은 되돌릴 수 없다.
#   - **DB에 데이터가 있으면 시드를 건너뛴다**(재설치로 데이터를 지우지 않는다).
#   - 시크릿에 **고정 기본값을 쓰지 않는다** — 패키지 배포에서 한 사이트 유출이
#     전 사이트 침해가 되는 것을 구조적으로 막는다(기획서 §6.2d).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
ENV_FILE="$ROOT/infra/docker/.env"
COMPOSE="$ROOT/infra/docker/docker-compose.prod.yml"
SITE_CODE=""; ORIGIN=""; WITH_DEMO=0; TRUST_HOPS="1"; BACKUP_CRON=1

die() { echo "!! $*" >&2; exit 1; }
ok()  { echo "  ✓ $*"; }

usage() {
  sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --site-code) SITE_CODE="${2:-}"; shift 2 ;;
    --origin)    ORIGIN="${2:-}"; shift 2 ;;
    --trust-proxy-hops) TRUST_HOPS="${2:-1}"; shift 2 ;;
    --with-demo) WITH_DEMO=1; shift ;;   # 평가·교육용 합성 데이터 포함(운영 설치에는 쓰지 말 것)
    --no-backup-cron) BACKUP_CRON=0; shift ;;  # 백업 스케줄을 외부(시스템 스케줄러)에서 관리할 때
    -h|--help)   usage ;;
    *) die "알 수 없는 인자: $1 (--help)" ;;
  esac
done

[ -n "$SITE_CODE" ] || die "--site-code 필요 (예: --site-code SEOUL-A). 사이트 식별·승인기록 결속용"
[ -n "$ORIGIN" ]    || die "--origin 필요 (예: --origin https://lis.hospital.kr)"
case "$ORIGIN" in https://*) ;; *) die "--origin은 https 여야 한다(환자 식별정보가 오간다): $ORIGIN" ;; esac
printf '%s' "$SITE_CODE" | grep -Eq '^[A-Za-z0-9_-]{2,32}$' || die "--site-code는 영숫자·-·_ 2~32자"

echo "=============================================="
echo " LIS 사이트 설치 — ${SITE_CODE}"
echo " 대상 origin : ${ORIGIN}"
echo " 데모 데이터 : $([ "$WITH_DEMO" = 1 ] && echo '포함(평가용)' || echo '미포함(운영 설치)')"
echo "=============================================="

# ── 1. 사전 점검 ────────────────────────────────────────────────────────────
echo ">> 1. 사전 점검"
command -v docker >/dev/null || die "docker 없음"
docker compose version >/dev/null 2>&1 || die "docker compose(v2) 없음"
docker info >/dev/null 2>&1 || die "docker 데몬에 접근 불가(권한·기동 확인)"
ok "docker $(docker --version | awk '{print $3}' | tr -d ,)"

AVAIL_KB=$(df -Pk "$ROOT" | awk 'NR==2{print $4}')
[ "$AVAIL_KB" -ge 10485760 ] || die "디스크 여유 부족(10GB 이상 필요, 현재 $((AVAIL_KB/1024/1024))GB)"
ok "디스크 여유 $((AVAIL_KB/1024/1024))GB"

for p in 4101 3101; do
  if (command -v ss >/dev/null && ss -ltn 2>/dev/null | grep -q ":${p} ") ||
     (command -v lsof >/dev/null && lsof -iTCP:"$p" -sTCP:LISTEN >/dev/null 2>&1); then
    die "포트 ${p} 사용 중 — compose 포트를 조정하거나 점유 프로세스를 정리할 것"
  fi
done
ok "포트 4101·3101 사용 가능"

# ── 2. .env 생성 (시크릿 자동 생성) ─────────────────────────────────────────
echo ">> 2. 환경 구성"
if [ -f "$ENV_FILE" ]; then
  die ".env가 이미 있다: $ENV_FILE
     설치를 계속하면 시크릿을 덮어써 기존 DB에 접근할 수 없게 된다(비가역).
     재설치라면 기존 .env를 안전한 곳에 보관한 뒤 옮기고 다시 실행할 것."
fi
command -v openssl >/dev/null || die "openssl 없음(시크릿 생성 불가)"
gen() { openssl rand -hex 32; }

umask 077
cat > "$ENV_FILE" <<EOF
# LIS 사이트 환경 — install.sh 생성 ($(date +%F))
# ★이 파일은 사이트 고유 시크릿을 담는다. 유출 금지·백업 필수(분실 시 DB 접근 불가).
COMPOSE_PROJECT_NAME=lis
LIS_SITE_CODE=${SITE_CODE}

# 시크릿 — 설치 시 무작위 생성(고정 기본값을 쓰지 않는다)
DB_PASSWORD=$(gen)
JWT_SECRET=$(gen)

PUBLIC_ORIGIN=${ORIGIN}
TRUST_PROXY_HOPS=${TRUST_HOPS}

# 운영자가 값을 받은 뒤 /admin/settings 또는 여기에 채운다(미설정이어도 기동한다)
CRITICAL_WEBHOOK_URL=
CRITICAL_WEBHOOK_SECRET=$(gen)
OPS_WEBHOOK_URL=
LIS_BACKUP_OFFSITE=

# 연계 — 자격증명 수령 후 주입(A-3 결재 후)
HIS_FHIR_BASE=
HIS_FHIR_TOKEN_URL=
HIS_CLIENT_ID=
HIS_CLIENT_SECRET=
HIS_INTEGRATION_BASE=
HIS_INTEGRATION_KEY=
PACS_MLLP_HOST=
PACS_MLLP_PORT=

# 개시 전까지 비워둔다
NEXT_PUBLIC_DEMO=
LIFECYCLE_PURGE=
EOF
chmod 600 "$ENV_FILE"
ok ".env 생성(600) — 시크릿 3종 무작위 생성"

# 코드가 읽는 키가 compose에 배선됐는지(과거 잠복 블로커 재발 방지)
if [ -x "$ROOT/infra/scripts/check-compose-env.sh" ]; then
  "$ROOT/infra/scripts/check-compose-env.sh" >/dev/null && ok "compose env 배선 확인"
fi

dc() { docker compose -p lis --env-file "$ENV_FILE" -f "$COMPOSE" "$@"; }

# ── 3. 빌드·기동 ────────────────────────────────────────────────────────────
echo ">> 3. 이미지 빌드(수 분 소요)"
dc build api web >/dev/null
ok "빌드 완료"

echo ">> 4. DB·API 기동"
dc up -d postgres >/dev/null
for i in $(seq 1 60); do
  docker exec lis-postgres pg_isready -U lis >/dev/null 2>&1 && break
  [ "$i" = 60 ] && die "postgres 기동 실패"
  sleep 1
done
ok "postgres healthy"

dc up -d api >/dev/null
for i in $(seq 1 90); do
  curl -sf -o /dev/null "http://127.0.0.1:4101/api/v1/health" && break
  [ "$i" = 90 ] && { docker logs lis-api --tail 30; die "api 기동 실패"; }
  sleep 1
done
ok "api healthy"

# 마이그레이션이 실제로 적용됐는지(헬스만으로 단정하지 않는다)
docker logs lis-api 2>&1 | grep -qE "migrations found|successfully applied|No pending migrations" \
  || die "마이그레이션 적용 로그를 찾지 못했다 — docker logs lis-api 확인"
ok "마이그레이션 적용 확인"

# ── 5. 시드 ─────────────────────────────────────────────────────────────────
echo ">> 5. 초기 데이터"
EXISTING=$(docker exec lis-postgres psql -U lis -d lis -tAc "select count(*) from app_user" 2>/dev/null || echo 0)
if [ "${EXISTING:-0}" -gt 0 ]; then
  echo "  · 기존 데이터 감지(사용자 ${EXISTING}명) — 시드를 건너뛴다(재설치로 데이터를 지우지 않는다)"
  ADMIN_PW=""
else
  PROFILE=$([ "$WITH_DEMO" = 1 ] && echo all || echo starter)
  ADMIN_PW=$(openssl rand -hex 8)
  dc run --rm --no-deps -e SEED_PROFILE="$PROFILE" -e SEED_PASSWORD="$ADMIN_PW" \
    --entrypoint sh api -c "cd /app/apps/api && npx prisma db seed" >/dev/null 2>&1 \
    || dc exec -T -e SEED_PROFILE="$PROFILE" -e SEED_PASSWORD="$ADMIN_PW" api \
         sh -c "cd /app/apps/api && npx prisma db seed" >/dev/null
  ok "시드 완료(profile=${PROFILE})"
fi

echo ">> 6. web 기동"
dc up -d web >/dev/null
for i in $(seq 1 60); do
  curl -sf -o /dev/null "http://127.0.0.1:3101/" && break
  [ "$i" = 60 ] && die "web 기동 실패"
  sleep 1
done
ok "web healthy"

# ── 7. 백업 스케줄 ──────────────────────────────────────────────────────────
# ★설치만으로는 백업이 돌지 않는다. 사람이 잊으면 **백업 없이 운영이 시작된다.**
#   그래서 설치가 등록한다(멱등 — 이미 있으면 건드리지 않는다).
echo ">> 7. 백업 스케줄"
CRON_LINE="0 3 * * * ${ROOT}/infra/scripts/backup.sh >> ${ROOT}/backup.log 2>&1"
if [ "$BACKUP_CRON" = 0 ]; then
  echo "  · --no-backup-cron — 건너뜀. 외부 스케줄러에 아래를 등록할 것:"
  echo "    ${CRON_LINE}"
elif ! command -v crontab >/dev/null 2>&1; then
  echo "  ⚠ crontab 없음 — 백업이 자동으로 돌지 않는다. 시스템 스케줄러에 아래를 등록할 것:"
  echo "    ${CRON_LINE}"
elif crontab -l 2>/dev/null | grep -qF "${ROOT}/infra/scripts/backup.sh"; then
  ok "백업 cron 이미 등록됨"
else
  { crontab -l 2>/dev/null; echo "$CRON_LINE"; } | crontab - \
    && ok "백업 cron 등록(매일 03:00)" \
    || echo "  ⚠ cron 등록 실패 — 수동 등록 필요: ${CRON_LINE}"
fi
echo "  · 백업만으로는 부족하다 — ${ROOT}/infra/scripts/restore-rehearsal.sh 로 **복원까지** 확인할 것"

# ── 8. 설치 검증 ────────────────────────────────────────────────────────────
echo ">> 8. 설치 검증"
"$ROOT/infra/install/verify.sh" || die "설치 검증 실패 — 위 항목 확인"

# ── 완료 ────────────────────────────────────────────────────────────────────
echo
echo "=============================================="
echo " ✅ 설치 완료 — ${SITE_CODE}"
echo "=============================================="
if [ -n "$ADMIN_PW" ]; then
  echo " 관리자 계정 : U00"
  echo " 초기 비밀번호: ${ADMIN_PW}"
  echo "   ⚠ 이 값은 **여기서만 출력된다.** 즉시 로그인해 변경할 것."
fi
cat <<EOF

 다음 순서(개시까지):
   1) 실 직원 계정 생성·역할 배정      /admin/users
   2) 위험치 통보 채널 URL 입력        /admin/settings  (테스트 발송으로 도달 확인)
   3) 검사실 실값 서명                 /admin/signoff
   4) 조직 결재 기입                   /admin/gates
   5) 개시 준비도 확인                 /admin/console
   정본 절차: docs/개시전_체크리스트.md · docs/개시_잔여항목_의뢰_검증서.md

 ⚠ TLS·도메인·방화벽은 이 스크립트 범위 밖이다.
   운영 노출 전 반드시 구성할 것(docs/실서비스_구축절차서.md §8·§11).
   백업 cron은 등록했으나 **오프사이트 경로(LIS_BACKUP_OFFSITE)는 비어 있다** —
   로컬 보관만으로는 호스트 소실에 무방비다. 값 확정 후 .env에 넣을 것.
EOF
