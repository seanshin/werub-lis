#!/usr/bin/env bash
# LIS 백업 복구 리허설(개시 전 백로그 C2) — "백업이 실제로 복원되는가"를 정기 검증.
# 최신 백업을 격리 scratch DB(lis_restore_rehearsal)로 복원 → 핵심 테이블 건수 확인 → scratch DB 제거.
# ⚠ 라이브 lis DB는 절대 건드리지 않음(scratch DB만 생성·삭제). 공유 postgres 설정 변경 없음.
# 사용: ./infra/scripts/restore-rehearsal.sh [백업파일]   (미지정 시 최신)
set -euo pipefail

BACKUP_DIR="${LIS_BACKUP_DIR:-/home/deploy/backups/lis}"
CONTAINER="lis-postgres"
USER="lis"
SCRATCH="lis_restore_rehearsal"   # 고정 — 라이브 'lis'와 분리

if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "[rehearsal] $CONTAINER 미가동 — 중단"; exit 1
fi

# 대상 백업 결정(인자 우선, 아니면 최신). 단일 글롭(lis-*.sql.gz*)으로 평문·gpg 모두 매칭.
# `|| true`: 매칭 없거나 head가 파이프 조기종료(SIGPIPE)해도 set -e/pipefail에 걸리지 않게.
SRC="${1:-$(ls -t "$BACKUP_DIR"/lis-*.sql.gz* 2>/dev/null | head -1 || true)}"
if [ -z "${SRC:-}" ] || [ ! -f "$SRC" ]; then
  echo "[rehearsal] 백업 파일 없음($BACKUP_DIR) — 중단"; exit 1
fi
echo "[rehearsal] 대상 백업: $SRC"

# 복호화(.gpg면 개인키 필요) → 평문 gz 스트림 준비.
# ★eval 제거(2026-07-30 보안 검토): 파일명이 `$(...)`·백틱을 포함하면 실행됐다.
#   함수로 감싸 파일명을 인자로만 다룬다.
decrypt_stream() {
  if [[ "$SRC" == *.gpg ]]; then gpg --batch --quiet --decrypt "$SRC"; else cat "$SRC"; fi
}
if [[ "$SRC" == *.gpg ]] && ! command -v gpg >/dev/null 2>&1; then
  echo "[rehearsal] gpg 미설치 — 암호화 백업 복원 불가"; exit 1
fi

# ★로그는 예측 가능한 /tmp 고정경로가 아니라 600 임시파일로(공유 호스트 심링크 공격 방지).
#   복원 실패 로그에는 psql 오류와 함께 환자 데이터 행이 섞일 수 있다.
LOG_RESTORE="$(mktemp)"; LOG_VERIFY="$(mktemp)"
chmod 600 "$LOG_RESTORE" "$LOG_VERIFY"
trap 'rm -f "$LOG_RESTORE" "$LOG_VERIFY"' EXIT

echo "[rehearsal] scratch DB 재생성: $SCRATCH"
docker exec "$CONTAINER" psql -U "$USER" -d postgres -c "DROP DATABASE IF EXISTS ${SCRATCH};" >/dev/null
docker exec "$CONTAINER" psql -U "$USER" -d postgres -c "CREATE DATABASE ${SCRATCH};" >/dev/null

echo "[rehearsal] 복원 중..."
decrypt_stream | gunzip | docker exec -i "$CONTAINER" psql -U "$USER" -d "$SCRATCH" -q >"$LOG_RESTORE" 2>&1 \
  || { echo "[rehearsal] ❌ 복원 실패 — 로그:"; tail -20 "$LOG_RESTORE"; docker exec "$CONTAINER" psql -U "$USER" -d postgres -c "DROP DATABASE IF EXISTS ${SCRATCH};" >/dev/null; exit 1; }

# 핵심 테이블 건수 sanity — 0행이거나 테이블 부재면 백업 손상 의심
echo "[rehearsal] 복원 검증(핵심 테이블 건수):"
ROWS=$(docker exec "$CONTAINER" psql -U "$USER" -d "$SCRATCH" -tAc "
  SELECT 'app_user='||(SELECT count(*) FROM app_user)
       ||' lab_order='||(SELECT count(*) FROM lab_order)
       ||' result='||(SELECT count(*) FROM result)
       ||' audit_log='||(SELECT count(*) FROM audit_log);" 2>"$LOG_VERIFY") \
  || { echo "[rehearsal] ❌ 검증 쿼리 실패(스키마 손상?) — 로그:"; tail -20 "$LOG_VERIFY"; docker exec "$CONTAINER" psql -U "$USER" -d postgres -c "DROP DATABASE IF EXISTS ${SCRATCH};" >/dev/null; exit 1; }
echo "  $ROWS"

USERS=$(echo "$ROWS" | sed -n 's/.*app_user=\([0-9]*\).*/\1/p')
if [ "${USERS:-0}" -lt 1 ]; then
  echo "[rehearsal] ❌ app_user 0행 — 백업 손상 의심(복원돼도 데이터 없음)"; RESULT=1
else
  echo "[rehearsal] ✅ 복원 성공 — 백업 유효(app_user ${USERS}행)"; RESULT=0
fi

echo "[rehearsal] scratch DB 정리"
docker exec "$CONTAINER" psql -U "$USER" -d postgres -c "DROP DATABASE IF EXISTS ${SCRATCH};" >/dev/null
exit "$RESULT"
