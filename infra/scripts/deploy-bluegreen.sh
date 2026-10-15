#!/usr/bin/env bash
# LIS 무중단(blue-green) 배포 — api를 green(4102)으로 띄워 헬스게이팅 후 전환.
# nginx upstream 전환/리로드는 운영자(sudo) 몫. 앱 준비성(healthcheck·graceful shutdown)은 코드로 보장.
# 사용: cd ~/his-backup/weruby/lis && ./infra/scripts/deploy-bluegreen.sh [up|switch-note|down-blue]
#   ※2026-09-09 파일럿 서버 이관으로 경로가 ~/lis → ~/his-backup/weruby/lis 로 바뀌었다.
#   ⚠ 이 스크립트는 **nginx upstream 전환을 전제**한다 — 현 파일럿 호스트는 Cloudflare Tunnel + Caddy라
#     전환 단계가 그대로 맞지 않는다(미검증). 단독 설치 사이트(nginx)에서는 그대로 유효.
#     경위: docs/서버이관_2026-09-09.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE="$ROOT/infra/docker/docker-compose.prod.yml"
ENV_FILE="$ROOT/infra/docker/.env"
NET="lis_default"
GREEN="lis-api-green"
GREEN_PORT="127.0.0.1:4102:4100"

# .env는 **셸로 소싱하지 않는다.** docker의 --env-file은 KEY=VALUE를 문자 그대로 읽지만
# 셸 소싱은 값을 해석한다. 실제로 HIS FHIR scope("system/ServiceRequest.read system/...")가
# 들어오자 두 번째 토큰을 명령으로 실행하려다 배포가 통째로 죽었다(set -e). 값에 공백·따옴표·
# $·백틱이 있어도 안전하게, docker와 같은 규칙으로 필요한 키만 뽑는다.
env_get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1; }
DB_PASSWORD="$(env_get DB_PASSWORD)"
PUBLIC_ORIGIN="$(env_get PUBLIC_ORIGIN)"
PACS_MLLP_PORT="$(env_get PACS_MLLP_PORT)"
: "${DB_PASSWORD:?DB_PASSWORD 필수 — infra/docker/.env 확인}"
DB_URL="postgresql://lis:${DB_PASSWORD}@postgres:5432/lis?schema=public&connection_limit=20&pool_timeout=20"

# 파생 env는 임시 파일로 넘긴다. `-e KEY=VALUE`로 주면 DB 비밀번호·JWT 시크릿이
# 호스트 프로세스 테이블(ps auxww / /proc/*/cmdline)에 평문으로 노출된다 — 공유 서버에서
# 다른 팀 계정이 배포 순간 ps 한 번으로 JWT_SECRET을 가져가 임의 역할 토큰을 위조할 수 있다.
DERIVED_ENV="$(mktemp)"
chmod 600 "$DERIVED_ENV"
trap 'rm -f "$DERIVED_ENV"' EXIT
{
  echo "DATABASE_URL=$DB_URL"
  echo "PORT=4100"
  echo "CORS_ORIGIN=${PUBLIC_ORIGIN:-https://lis.example.org}"
  echo "PACS_MLLP_PORT=${PACS_MLLP_PORT:-2575}"
  echo "RUN_MIGRATIONS=off"
} > "$DERIVED_ENV"

health() { # $1=host:port  (컨테이너 내부 4100로 폴링)
  for i in $(seq 1 30); do
    if docker exec "$GREEN" node -e "require('http').get('http://localhost:4100/api/v1/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))" 2>/dev/null; then
      echo "green healthy (${i}s)"; return 0
    fi; sleep 1
  done
  echo "!! green 헬스체크 실패"; return 1
}

case "${1:-up}" in
  up)
    echo ">> 신규 이미지 빌드"
    docker compose -p lis --env-file "$ENV_FILE" -f "$COMPOSE" build api
    # 마이그레이션 분리(C5): 전환 전 1회 명시 적용(blue 가동 중). 반드시 backward-compatible(추가형)만.
    echo ">> 마이그레이션 1회 적용(one-shot, blue 무중단 전제=추가형)"
    docker run --rm --network "$NET" --env-file "$DERIVED_ENV" \
      --entrypoint sh lis-api:latest -c "npx prisma migrate deploy"
    echo ">> green 컨테이너 기동(4102, 마이그레이션 생략)"
    docker rm -f "$GREEN" 2>/dev/null || true
    # ⚠ green은 blue와 동일 env를 받아야 함 — 과거엔 HIS/PACS/CRITICAL/OPS 누락으로 전환 창에
    #   폴링·결과발신·위험치통보가 조용히 끊겼음(C5). --env-file로 운영자 .env 전량 주입 + 파생값만 override.
    #   RUN_MIGRATIONS=off: 위에서 이미 적용 → green 부팅은 기동만(경합 회피).
    docker run -d --name "$GREEN" --network "$NET" \
      --env-file "$ENV_FILE" \
      --env-file "$DERIVED_ENV" \
      --security-opt no-new-privileges:true --cap-drop ALL \
      --memory 2g --pids-limit 512 \
      --add-host pacs-hl7:host-gateway \
      -p "$GREEN_PORT" lis-api:latest >/dev/null
    health
    echo ">> green 준비 완료. 운영자: nginx upstream을 4101→4102로 전환 후 reload."
    echo "   (아래 switch-note 참고). 트래픽 안정 확인 후 blue 교체: deploy.sh --build; 이후 down-blue"
    ;;
  switch-note)
    cat <<'NOTE'
[운영자 nginx 전환 절차 — 무중단]
1) upstream 정의(예):
   upstream lis_api { server 127.0.0.1:4101; }   # blue(현행)
   # 무중단 전환: 아래로 교체
   upstream lis_api { server 127.0.0.1:4102; }   # green(신규)
2) sudo nginx -t && sudo systemctl reload nginx   # 리로드는 기존 연결 드레인(무중단)
3) 안정 확인(수 분) → blue 재빌드 최신화(./infra/scripts/deploy.sh --build) → green 제거(down-blue)
* 롤백: upstream을 4101로 되돌리고 reload.
NOTE
    ;;
  down-blue)
    echo ">> green 제거(전환 완료 후, blue가 최신인 상태에서)"
    docker rm -f "$GREEN" 2>/dev/null || true
    echo "완료."
    ;;
  *) echo "usage: $0 [up|switch-note|down-blue]"; exit 1;;
esac
