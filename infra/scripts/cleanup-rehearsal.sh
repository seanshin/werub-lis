#!/usr/bin/env bash
# 파일럿 정리 예행 — 개시일 단계 6(RUN-6)을 **격리 scratch DB**에서 미리 돌려본다.
#
# 왜 필요한가: 실 정리는 🔴비가역이고 개시 직전 1회뿐이다. 그날 처음 실행해서
# FK 오류·테이블 누락·권한 문제를 만나면 되돌릴 방법이 백업 복원뿐이다.
#
# 두 경로를 다 돌린다 — **경로가 둘인데 한쪽만 예행하면 예행이 아니다.**
#   ① 정본(api)  : `/admin/seed-cleanup` — 백필 → 요청 → **2인 승인** → 시드 표식 선택 삭제
#                  (+ 삭제 전 PACS 워크리스트 취소, v1.56.4)
#   ② 폴백(sql)  : `pilot-cleanup.sql` — 테이블 전량 TRUNCATE
# 실제 개시일에 쓰는 것은 ①이다. ②는 ①이 막혔을 때만 쓰는 비상구다.
#
# ⚠ 라이브 lis DB는 절대 건드리지 않는다(scratch 생성·삭제 + 임시 API 컨테이너만).
# ⚠ 외부 채널(PACS/HIS/ERP/웹훅)은 전부 차단하고 띄운다 — 예행이 **실 PACS 워크리스트를
#    취소하거나 실 온콜 채널로 발신하면 안 된다.** 그래서 ①의 취소 ORM은 전량 실패로 뜨는 것이
#    정상이며, 이 예행의 산출물은 "개시일에 몇 건이 나가는가"라는 **건수와 목록**이다.
#
# 사용: ./infra/scripts/cleanup-rehearsal.sh [--api|--sql|--both] [백업파일]
#       (기본 --both · 백업 미지정 시 최신)
set -euo pipefail

MODE="both"
SRC_ARG=""
for a in "$@"; do
  case "$a" in
    --api) MODE="api" ;;
    --sql) MODE="sql" ;;
    --both) MODE="both" ;;
    *) SRC_ARG="$a" ;;
  esac
done

BACKUP_DIR="${LIS_BACKUP_DIR:-/home/deploy/backups/lis}"
CONTAINER="lis-postgres"
USER="lis"
SCRATCH="lis_cleanup_rehearsal"    # restore-rehearsal과 다른 이름(동시 실행 안전)
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SQL="$ROOT/infra/scripts/pilot-cleanup.sql"
ENV_FILE="$ROOT/infra/docker/.env"
NET="${E2E_NETWORK:-lis_default}"
API_IMAGE="${LIS_API_IMAGE:-lis-api:latest}"
API_NAME="lis-rehearsal-api"
API_PORT="${LIS_REHEARSAL_PORT:-4199}"
BASE="http://127.0.0.1:${API_PORT}/api/v1"
BACKFILL_PHRASE='이 데이터베이스에는 실 환자 데이터가 없습니다'
REQUESTER="U00"
APPROVER="U-REHEARSAL-APPROVER"    # scratch에만 만드는 2인 승인용 계정

[ -f "$SQL" ] || { echo "[cleanup-rehearsal] $SQL 없음 — 중단"; exit 1; }
[ -f "$ENV_FILE" ] || { echo "[cleanup-rehearsal] $ENV_FILE 없음 — 중단"; exit 1; }
docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$" || { echo "[cleanup-rehearsal] $CONTAINER 미가동 — 중단"; exit 1; }

SRC="${SRC_ARG:-$(ls -t "$BACKUP_DIR"/lis-*.sql.gz* 2>/dev/null | head -1 || true)}"
[ -n "${SRC:-}" ] && [ -f "$SRC" ] || { echo "[cleanup-rehearsal] 백업 없음($BACKUP_DIR) — 중단"; exit 1; }
echo "[cleanup-rehearsal] 대상 백업: $SRC · 경로: $MODE"

DECRYPT="cat \"$SRC\""
[[ "$SRC" == *.gpg ]] && DECRYPT="gpg --batch --quiet --decrypt \"$SRC\""

# .env는 **소싱하지 않는다**(값에 공백이 있으면 스크립트가 죽는다 — check-no-env-sourcing.sh 규칙).
DB_PASSWORD="$(sed -n 's/^DB_PASSWORD=//p' "$ENV_FILE" | head -1)"
[ -n "$DB_PASSWORD" ] || { echo "[cleanup-rehearsal] .env에 DB_PASSWORD 없음 — 중단"; exit 1; }

teardown() {
  docker rm -f "$API_NAME" >/dev/null 2>&1 || true
  docker exec "$CONTAINER" psql -U "$USER" -d postgres -c "DROP DATABASE IF EXISTS ${SCRATCH};" >/dev/null 2>&1 || true
}
trap teardown EXIT

psql_scratch() { docker exec "$CONTAINER" psql -U "$USER" -d "$SCRATCH" "$@"; }

restore() {
  echo "[cleanup-rehearsal] scratch DB 재생성: $SCRATCH"
  docker rm -f "$API_NAME" >/dev/null 2>&1 || true
  docker exec "$CONTAINER" psql -U "$USER" -d postgres -c "DROP DATABASE IF EXISTS ${SCRATCH};" >/dev/null 2>&1 || true
  docker exec "$CONTAINER" psql -U "$USER" -d postgres -c "CREATE DATABASE ${SCRATCH};" >/dev/null
  echo "[cleanup-rehearsal] 백업 복원..."
  # shellcheck disable=SC2086
  eval $DECRYPT | gunzip | docker exec -i "$CONTAINER" psql -U "$USER" -d "$SCRATCH" -q >/tmp/cleanup-restore.log 2>&1 \
    || { echo "[cleanup-rehearsal] ❌ 복원 실패 — /tmp/cleanup-restore.log"; exit 1; }
}

snap() { # 트랜잭션/마스터 대표 테이블 건수
  psql_scratch -tAc "
    SELECT 'patient='||(SELECT count(*) FROM patient)
        ||' lab_order='||(SELECT count(*) FROM lab_order)
        ||' result='||(SELECT count(*) FROM result)
        ||' notification='||(SELECT count(*) FROM notification)
        ||' interface_log='||(SELECT count(*) FROM interface_log)
        ||' | app_user='||(SELECT count(*) FROM app_user)
        ||' test_master='||(SELECT count(*) FROM test_master)
        ||' code_mapping='||(SELECT count(*) FROM code_mapping)
        ||' his_lab_code='||(SELECT count(*) FROM his_lab_code)
        ||' decision_record='||(SELECT count(*) FROM decision_record);"
}

assert_after() { # $1=경로이름 — 트랜잭션 0 · 마스터 보존
  local label="$1" after rc=0 tx master tests his
  after="$(snap)"
  echo "[cleanup-rehearsal][$label] 정리 후:"; echo "    $after"
  tx=$(echo "$after"     | sed -n 's/.*patient=\([0-9]*\).*/\1/p')
  master=$(echo "$after" | sed -n 's/.*app_user=\([0-9]*\).*/\1/p')
  tests=$(echo "$after"  | sed -n 's/.*test_master=\([0-9]*\).*/\1/p')
  his=$(echo "$after"    | sed -n 's/.*his_lab_code=\([0-9]*\).*/\1/p')
  [ "${tx:-1}" -eq 0 ]     || { echo "[cleanup-rehearsal][$label] ❌ 트랜잭션 잔존(patient=$tx)"; rc=1; }
  [ "${master:-0}" -ge 1 ] || { echo "[cleanup-rehearsal][$label] ❌ 계정이 지워졌다(app_user=$master)"; rc=1; }
  [ "${tests:-0}" -ge 1 ]  || { echo "[cleanup-rehearsal][$label] ❌ 검사 마스터가 지워졌다"; rc=1; }
  [ "${his:-0}" -ge 1 ]    || { echo "[cleanup-rehearsal][$label] ❌ HIS 코드 카탈로그가 지워졌다"; rc=1; }
  return $rc
}

# ── ① 정본 경로(API) ────────────────────────────────────────────────────────────
rehearse_api() {
  local rc=0
  restore

  # 2인 승인은 **서로 다른 활성 ADM 둘**을 요구한다. 파일럿 DB의 ADM은 U00 하나뿐이라
  # scratch에만 승인자 계정을 하나 만든다(개시일에는 RUN-2에서 실 관리자 계정이 생긴다 —
  # RUN-6가 RUN-2에 dependsOn인 이유가 이것이다).
  # 비밀번호는 이 실행에서만 쓰는 난수로 새로 심는다 — **실 비밀번호를 알 필요도, 다룰 일도 없다.**
  local pw hash
  pw="$(head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)"
  hash="$(docker run --rm --entrypoint node "$API_IMAGE" \
            -e 'require("bcrypt").hash(process.argv[1],10).then(h=>console.log(h))' "$pw" 2>/dev/null | tail -1)"
  [[ "$hash" == \$2* ]] || { echo "[cleanup-rehearsal][api] ❌ 예행용 비밀번호 해시 생성 실패"; return 1; }

  psql_scratch -q -v ON_ERROR_STOP=1 -c "
    UPDATE app_user SET password_hash='${hash}', must_change_password=false,
           status='ACTIVE', failed_attempts=0, locked_until=NULL WHERE user_id='${REQUESTER}';
    INSERT INTO app_user (user_id, name, dept, status, password_hash, must_change_password, failed_attempts)
      VALUES ('${APPROVER}','예행 승인자','예행','ACTIVE','${hash}',false,0)
      ON CONFLICT (user_id) DO UPDATE SET password_hash=EXCLUDED.password_hash, status='ACTIVE';
    INSERT INTO user_role (user_id, role_code) VALUES ('${APPROVER}','ADM') ON CONFLICT DO NOTHING;
  " >/dev/null

  echo "[cleanup-rehearsal][api] 임시 API 기동(scratch DB · 외부 채널 전부 차단)..."
  # ★외부 채널을 빈 값으로 덮는다 — 예행이 실 PACS 워크리스트를 취소하거나
  #   실 온콜 채널로 발신하는 일은 있어서는 안 된다(v1.54.0에서 E2E에 세운 것과 같은 원칙).
  # ★RUN_MIGRATIONS=off — scratch는 백업 복원본이라 스키마가 이미 맞다.
  docker run -d --name "$API_NAME" --network "$NET" --env-file "$ENV_FILE" \
    -p "127.0.0.1:${API_PORT}:4100" \
    -e DATABASE_URL="postgresql://${USER}:${DB_PASSWORD}@${CONTAINER}:5432/${SCRATCH}?schema=public" \
    -e RUN_MIGRATIONS=off -e THROTTLER_DISABLED=1 -e ENABLE_SWAGGER= \
    -e HIS_FHIR_BASE= -e HIS_FHIR_TOKEN_URL= -e HIS_CLIENT_ID= -e HIS_CLIENT_SECRET= -e HIS_FHIR_SCOPES= \
    -e HIS_ORDER_POLL= -e HIS_REFLEX_POLL= -e HIS_REFLEX_RETRY= -e HIS_MLLP_HOST= -e HIS_MLLP_PORT= \
    -e PACS_BASE= -e PACS_USER= -e PACS_PASSWORD= -e PACS_MLLP_HOST= -e PACS_MLLP_PORT= \
    -e ERP_BILLING_URL= -e ERP_BILLING_SECRET= \
    -e CRITICAL_WEBHOOK_URL= -e CRITICAL_WEBHOOK_SECRET= -e OPS_WEBHOOK_URL= \
    -e HIS_INTEGRATION_BASE= -e HIS_INTEGRATION_KEY= -e HIS_TARGET_TOKEN_SECRET= -e HIS_REFLEX_WEBHOOK_TOKEN= \
    -e LIFECYCLE_PURGE= \
    "$API_IMAGE" >/dev/null

  local i=0
  until curl -sf "$BASE/health" >/dev/null 2>&1; do
    i=$((i+1)); [ "$i" -gt 60 ] && { echo "[cleanup-rehearsal][api] ❌ API 기동 실패"; docker logs --tail 30 "$API_NAME"; return 1; }
    sleep 1
  done
  echo "[cleanup-rehearsal][api] API 기동 확인(:${API_PORT})"

  login() { # $1=userId → 토큰(값은 출력만 하고 로그에 남기지 않는다)
    curl -sS -X POST "$BASE/auth/login" -H 'Content-Type: application/json' \
      -d "{\"userId\":\"$1\",\"password\":\"${pw}\"}" | jq -r '.data.accessToken // empty'
  }
  local TOK_REQ TOK_APR
  TOK_REQ="$(login "$REQUESTER")"; TOK_APR="$(login "$APPROVER")"
  [ -n "$TOK_REQ" ] && [ -n "$TOK_APR" ] || { echo "[cleanup-rehearsal][api] ❌ 예행 계정 로그인 실패"; return 1; }

  api() { # $1=토큰 $2=메서드 $3=경로 [$4=본문]
    if [ -n "${4:-}" ]; then
      curl -sS -X "$2" "$BASE$3" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -d "$4"
    else
      curl -sS -X "$2" "$BASE$3" -H "Authorization: Bearer $1"
    fi
  }

  echo "[cleanup-rehearsal][api] 정리 전:"; echo "    $(snap)"

  # ⓪ 백필 전에는 파일럿 데이터가 전부 '실 데이터'로 보여 정리가 막힌다(fail-safe 확인)
  local clean0
  clean0="$(api "$TOK_REQ" GET /admin/seed-cleanup/real-data | jq -r '.data.clean')"
  [ "$clean0" = "false" ] || { echo "[cleanup-rehearsal][api] ❌ 백필 전인데 clean=true — 실데이터 감지가 죽었다"; rc=1; }

  # ① 백필 — 추적 도입 이전 파일럿 행을 site-pilot으로 등록(삭제 없음)
  local bf reg
  bf="$(api "$TOK_REQ" POST /admin/seed-cleanup/backfill \
        "{\"confirmPhrase\":\"${BACKFILL_PHRASE}\",\"approverId\":\"${APPROVER}\"}")"
  reg="$(echo "$bf" | jq -r '.data.registered // 0')"
  echo "[cleanup-rehearsal][api] 백필 등록: ${reg}건(삭제 $(echo "$bf" | jq -r '.data.deleted // "?"'))"
  [ "${reg:-0}" -gt 0 ] || { echo "[cleanup-rehearsal][api] ❌ 백필 0건 — 정리 대상이 잡히지 않는다"; echo "$bf" | head -3; return 1; }

  # ② 미리보기 — 무엇이 지워지는가 + **PACS로 나갈 취소 건수**(이 예행의 핵심 산출물)
  local pv total phrase pacs_n pacs_list
  pv="$(api "$TOK_REQ" GET '/admin/seed-cleanup/preview?batch=site-pilot')"
  total="$(echo "$pv" | jq -r '.data.total // 0')"
  phrase="$(echo "$pv" | jq -r '.data.confirmPhrase // empty')"
  pacs_n="$(echo "$pv" | jq -r '.data.pacsWorklist.count // 0')"
  pacs_list="$(echo "$pv" | jq -r '.data.pacsWorklist.spNos // [] | join(", ")')"
  echo "[cleanup-rehearsal][api] 정리 대상 ${total}건 · 상위 엔티티: $(echo "$pv" | jq -r '[.data.targets[]?|"\(.entity):\(.count)"]|.[0:6]|join(" ")')"
  echo "[cleanup-rehearsal][api] 📡 PACS 워크리스트 취소 대상 ${pacs_n}건${pacs_list:+ — ${pacs_list}}"
  [ "${total:-0}" -gt 0 ] && [ -n "$phrase" ] || { echo "[cleanup-rehearsal][api] ❌ 미리보기 이상"; echo "$pv" | head -3; return 1; }
  [ "$(echo "$pv" | jq -r '.data.blocked')" = "false" ] || { echo "[cleanup-rehearsal][api] ❌ 백필 후에도 차단 상태"; rc=1; }

  # ③ 요청 — 실행하지 않는다(승인 대기 건만)
  local req runid before_pat
  before_pat="$(psql_scratch -tAc 'SELECT count(*) FROM patient')"
  req="$(api "$TOK_REQ" POST /admin/seed-cleanup/request "{\"batch\":\"site-pilot\",\"confirmPhrase\":\"${phrase}\"}")"
  runid="$(echo "$req" | jq -r '.data.runId // empty')"
  [ -n "$runid" ] || { echo "[cleanup-rehearsal][api] ❌ 요청 실패"; echo "$req" | head -3; return 1; }
  [ "$(psql_scratch -tAc 'SELECT count(*) FROM patient')" = "$before_pat" ] \
    || { echo "[cleanup-rehearsal][api] ❌ 요청 단계에서 이미 삭제됐다(2단계가 아니다)"; rc=1; }

  # ③' 요청자가 자기 요청을 승인할 수 없어야 한다(직무분리 — 개시일에 한 사람이 다 하지 못한다)
  local self
  self="$(curl -sS -o /dev/null -w '%{http_code}' -X POST "$BASE/admin/seed-cleanup/approve/$runid" -H "Authorization: Bearer $TOK_REQ")"
  [ "$self" = "400" ] || { echo "[cleanup-rehearsal][api] ❌ 요청자 자가승인이 막히지 않았다(HTTP $self)"; rc=1; }

  # ④ 승인·실행 — 승인자 본인 토큰
  local ex deleted mwl_ok mwl_ng
  ex="$(api "$TOK_APR" POST "/admin/seed-cleanup/approve/$runid")"
  deleted="$(echo "$ex" | jq -r '.data.deleted // 0')"
  mwl_ok="$(echo "$ex" | jq -r '.data.mwlCancelled // [] | length')"
  mwl_ng="$(echo "$ex" | jq -r '.data.mwlFailed // [] | length')"
  echo "[cleanup-rehearsal][api] 삭제 ${deleted}건 · 잔여엔티티 $(echo "$ex" | jq -r '.data.skipped // [] | length')종"
  echo "[cleanup-rehearsal][api] 📡 PACS 취소 성공 ${mwl_ok} · 실패 ${mwl_ng}(예행은 PACS 차단이라 실패가 정상)"
  [ "${deleted:-0}" -gt 0 ] || { echo "[cleanup-rehearsal][api] ❌ 삭제 0건"; echo "$ex" | head -3; return 1; }

  # ⑤ 취소 대상이 있었다면 시도 흔적이 남아야 한다 — 조용히 건너뛰면 개시일에 고아가 생긴다
  if [ "${pacs_n:-0}" -gt 0 ] && [ "$((mwl_ok + mwl_ng))" -ne "$pacs_n" ]; then
    echo "[cleanup-rehearsal][api] ❌ PACS 취소 시도 누락 — 대상 ${pacs_n} vs 시도 $((mwl_ok + mwl_ng))"; rc=1
  fi

  assert_after api || rc=1
  # 개시 근거는 남아야 한다(v1.56.4 — 폴백 SQL이 이걸 지우던 것을 정정했다)
  local ev
  ev="$(psql_scratch -tAc "SELECT (SELECT count(*) FROM cutover_run)||'/'||(SELECT count(*) FROM org_approval)")"
  echo "[cleanup-rehearsal][api] 전환이력/조직결재 보존: $ev"

  docker rm -f "$API_NAME" >/dev/null 2>&1 || true
  [ "$rc" -eq 0 ] && echo "[cleanup-rehearsal][api] ✅ 정본 경로 예행 통과"
  return $rc
}

# ── ② 폴백 경로(SQL) ────────────────────────────────────────────────────────────
rehearse_sql() {
  local rc=0
  restore
  echo "[cleanup-rehearsal][sql] 정리 전:"; echo "    $(snap)"
  echo "[cleanup-rehearsal][sql] pilot-cleanup.sql 실행(scratch)..."
  docker exec -i "$CONTAINER" psql -U "$USER" -d "$SCRATCH" -v ON_ERROR_STOP=1 < "$SQL" >/tmp/cleanup-run.log 2>&1 \
    || { echo "[cleanup-rehearsal][sql] ❌ 정리 SQL 실패 — /tmp/cleanup-run.log"; tail -20 /tmp/cleanup-run.log; return 1; }
  assert_after sql || rc=1
  [ "$rc" -eq 0 ] && echo "[cleanup-rehearsal][sql] ✅ 폴백 경로 예행 통과"
  return $rc
}

RC=0
case "$MODE" in
  api)  rehearse_api || RC=1 ;;
  sql)  rehearse_sql || RC=1 ;;
  both) rehearse_api || RC=1; rehearse_sql || RC=1 ;;
esac

[ "$RC" -eq 0 ] && echo "[cleanup-rehearsal] ✅ 예행 통과($MODE)" || echo "[cleanup-rehearsal] ❌ 예행 실패($MODE)"
exit "$RC"
