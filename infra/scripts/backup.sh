#!/usr/bin/env bash
# LIS DB 백업 — lis-postgres 컨테이너 pg_dump → 보관·순환(기본 14일)
# 크론 예시: 0 3 * * *  /home/deploy/his-backup/weruby/lis/infra/scripts/backup.sh >> /home/deploy/backups/lis-backup.log 2>&1
#   ⚠ 2026-09-09 서버 이관 시 이 크론이 복원되지 않았다 — 재등록 절차: docs/서버이관_2026-09-09.md §4-C
set -euo pipefail

# 백업 파일에는 전체 환자 DB(유전정보 포함)가 들어간다. 공유 서버의 다른 사용자가 읽지 못하도록
# 생성 시점부터 소유자 전용 권한을 강제한다(umask 의존 시 통상 0644로 생성됨).
umask 077

BACKUP_DIR="${LIS_BACKUP_DIR:-/home/deploy/backups/lis}"
KEEP_DAYS="${LIS_BACKUP_KEEP_DAYS:-14}"
CONTAINER="lis-postgres"
DB="lis"
USER="lis"

mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
# 컨테이너 미가동 시 종료
if ! docker ps --format '{{.Names}}' | grep -q "^${CONTAINER}$"; then
  echo "[backup] $CONTAINER 미가동 — 중단"
  exit 1
fi

# 타임스탬프는 컨테이너 시간 기준(TZ 서버 설정)
TS="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/lis-${TS}.sql.gz"

docker exec "$CONTAINER" pg_dump -U "$USER" -d "$DB" | gzip > "$OUT"
chmod 600 "$OUT"
echo "[backup] 생성: $OUT ($(du -h "$OUT" | cut -f1))"

# 선택 암호화(C2) — LIS_BACKUP_GPG_RECIPIENT 설정 시 gpg 공개키로 암호화, 평문 원본 제거.
#   오프사이트로 나가는 백업의 정지 데이터 보호(개인정보·유전정보 포함).
UPLOAD="$OUT"
if [ -n "${LIS_BACKUP_GPG_RECIPIENT:-}" ]; then
  if command -v gpg >/dev/null 2>&1; then
    gpg --batch --yes --trust-model always -r "$LIS_BACKUP_GPG_RECIPIENT" -o "${OUT}.gpg" -e "$OUT"
    rm -f "$OUT"; UPLOAD="${OUT}.gpg"
    echo "[backup] 암호화: $UPLOAD"
  else
    echo "[backup] ❌ gpg 미설치 — 암호화할 수 없어 멈춥니다. gpg 를 설치하십시오."; exit 2
  fi
fi

# 오프사이트로는 암호화된 백업만 보낸다 — LIS_BACKUP_GPG_RECIPIENT 를 설정해야 한다(PUBLIC-EDITION.md).
if [ -n "${LIS_BACKUP_OFFSITE:-}" ] && [ "$UPLOAD" = "$OUT" ]; then
  echo "[backup] ❌ 오프사이트 사본은 암호화된 백업만 보냅니다 — LIS_BACKUP_GPG_RECIPIENT 와 gpg 를 설정하십시오."; exit 2
fi

# 오프사이트 복사(C2) — LIS_BACKUP_OFFSITE(rsync 대상: user@host:/path 또는 로컬 마운트)에 사본 전송.
#   단일 호스트 소실 대비. 실패해도 로컬 백업은 유지(비0 종료로 크론 로그에 경보).
if [ -n "${LIS_BACKUP_OFFSITE:-}" ]; then
  if command -v rsync >/dev/null 2>&1; then
    if rsync -a ${LIS_BACKUP_RSYNC_OPTS:-} "$UPLOAD" "$LIS_BACKUP_OFFSITE"/; then
      echo "[backup] 오프사이트 복사: $LIS_BACKUP_OFFSITE"
    else
      echo "[backup] ❌ 오프사이트 복사 실패 — $LIS_BACKUP_OFFSITE 점검 필요"; OFFSITE_FAIL=1
    fi
  else
    echo "[backup] ⚠ rsync 미설치 — 오프사이트 복사 건너뜀."; OFFSITE_FAIL=1
  fi
else
  echo "[backup] ⚠ LIS_BACKUP_OFFSITE 미설정 — 로컬 보관만(단일 호스트 소실 위험). 개시 전 설정 권장."
fi

# 순환: KEEP_DAYS 초과분 삭제(평문·암호화 모두). \( … \) 그룹핑 필수 —
# 없으면 -mtime/-delete가 뒤 -name에만 걸려 평문 .sql.gz가 순환에서 누락됨.
find "$BACKUP_DIR" \( -name 'lis-*.sql.gz' -o -name 'lis-*.sql.gz.gpg' \) -mtime +"$KEEP_DAYS" -print -delete | sed 's/^/[backup] 삭제(만료): /'

echo "[backup] 완료. 보관본 $(ls "$BACKUP_DIR"/lis-*.sql.gz* 2>/dev/null | wc -l)개"
exit "${OFFSITE_FAIL:-0}"
