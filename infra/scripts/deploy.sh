#!/usr/bin/env bash
# LIS 배포 스크립트 (weruby 서버) — 기존 서비스 불간섭.
# 사용: cd ~/his-backup/weruby/lis && ./infra/scripts/deploy.sh [--build|--seed|--down|--logs]
#   ※2026-09-09 파일럿 서버 이관으로 저장소 경로가 ~/lis → ~/his-backup/weruby/lis 로 바뀌었다.
#     인그레스도 nginx → Cloudflare Tunnel + Caddy 다. 경위·잔여 조치: docs/서버이관_2026-09-09.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
COMPOSE="$ROOT/infra/docker/docker-compose.prod.yml"
ENV_FILE="$ROOT/infra/docker/.env"
PROJECT="lis"   # 다른 프로젝트와 격리된 compose 프로젝트명

if [[ ! -f "$ENV_FILE" ]]; then
  echo "!! $ENV_FILE 없음 — .env.production.example 복사 후 값 설정하세요."
  exit 1
fi

dc() { docker compose -p "$PROJECT" --env-file "$ENV_FILE" -f "$COMPOSE" "$@"; }

case "${1:---up}" in
  --build)
    # ★워크트리가 푸시된 main과 일치하는지 먼저 확인한다.
    #   이 서버는 `git push srv main`이 bare 저장소(~/lis.git)만 갱신하고 **post-receive 훅이 없다**.
    #   워크트리 체크아웃은 수동이라, 그 단계를 잊으면 deploy.sh가 옛 파일을 그대로 빌드하고도
    #   아무 말 없이 "배포 완료"를 찍는다(2026-07-29 실제 발생 — 웹 변경이 통째로 누락됐다).
    #   E2E도 워크트리로 돌기 때문에 이 어긋남을 잡지 못한다 → 빌드 직전에 여기서 막는다.
    BARE="${LIS_BARE_REPO:-$HOME/lis.git}"
    if [[ -d "$BARE" ]]; then
      # 빌드 부산물로 추적되는 파일은 제외(빌드할 때마다 달라져 오탐이 된다)
      if ! git --git-dir="$BARE" --work-tree="$ROOT" diff --quiet main -- \
             ':!*.tsbuildinfo' ':!infra/docker/.env*' 2>/dev/null; then
        echo "!! ❌ 워크트리가 푸시된 main과 다르다 — 옛 코드를 빌드할 뻔했다."
        git --git-dir="$BARE" --work-tree="$ROOT" diff --stat main -- \
            ':!*.tsbuildinfo' ':!infra/docker/.env*' 2>/dev/null | tail -20
        echo "!! 해결: git --git-dir=$BARE --work-tree=$ROOT checkout -f main"
        exit 1
      fi
      echo ">> 워크트리 = 푸시된 main 일치 확인"
    else
      # ★조용히 건너뛰면 위 게이트가 통째로 무력화된다 — 2026-09-09 서버 이관 때 bare가 복원되지 않아
      #   실제로 이 분기에 걸렸다. "경고 한 줄 찍고 옛 코드를 빌드"가 정확히 이 게이트가 막으려던 사고다.
      #   bare를 복구하거나(docs/서버이관_2026-09-09.md §4-A), 근거를 남기고 명시적으로 우회할 것.
      echo "!! ❌ bare 저장소($BARE)가 없다 — 워크트리가 푸시된 main과 같은지 확인할 방법이 없다."
      echo "!! 복구: docs/서버이관_2026-09-09.md §4-A  (백업 tgz에서 lis.git 추출 + remote 재지정)"
      echo "!! 우회(권장하지 않음): LIS_ALLOW_NO_BARE=1 ./infra/scripts/deploy.sh --build"
      [[ "${LIS_ALLOW_NO_BARE:-0}" == "1" ]] || exit 1
      echo ">> ⚠ LIS_ALLOW_NO_BARE=1 — 워크트리 동기 확인 없이 진행한다(배포 코드 버전을 직접 확인할 것)"
    fi
    if [[ "${SKIP_E2E:-0}" == "1" ]]; then
      echo ">> ⚠ E2E 게이트 건너뜀(SKIP_E2E=1) — 긴급 배포만 사용"
    else
      echo ">> 배포 전 E2E 게이트(lis_test) — 실패 시 배포 중단(우회: SKIP_E2E=1)"
      "$ROOT/infra/scripts/e2e-server.sh"
    fi
    # ★디스크 프리플라이트 — 아래 --no-cache 강제가 매 배포마다 빌드 캐시를 새로 쌓는다.
    #   2026-07-30 v1.56.0 배포 중 315GB가 100% 차서 빌드가 죽었다(빌드 캐시만 234GB). 이 서버는
    #   HIS·jitsi·sign 등 12개 서비스가 동거하므로 **LIS 배포가 남의 서비스를 멈출 수 있다**.
    #   빌드 캐시는 실행 중 컨테이너와 무관해 언제 지워도 안전하다. 반면 `system prune -a`는
    #   타 팀의 정지 컨테이너 이미지를 지우므로 절대 쓰지 않는다.
    DISK_PCT="$(df -P "$ROOT" | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
    if [[ "${DISK_PCT:-0}" -ge 85 ]]; then
      echo ">> ⚠ 디스크 ${DISK_PCT}% — 빌드 캐시와 LIS 구 이미지를 정리한다(타 서비스 불간섭)"
      docker builder prune -f >/dev/null
      # ★매 빌드가 직전 :latest를 태그 없는 이미지로 밀어내 회당 ~2.2GB씩 쌓인다(실측 8개 8.7GB).
      #   `docker image prune`은 **타 팀의 dangling까지** 지우므로 쓰지 않는다 —
      #   compose 프로젝트 라벨이 lis인 것만 골라 지운다. dangling은 정의상 실행 중
      #   컨테이너가 참조하지 않으므로(참조하면 dangling이 아니다) 가동에 영향이 없다.
      for _img in $(docker images -f 'dangling=true' -q); do
        if [[ "$(docker inspect "$_img" --format '{{index .Config.Labels "com.docker.compose.project"}}' 2>/dev/null)" == "$PROJECT" ]]; then
          docker rmi "$_img" >/dev/null 2>&1 || true
        fi
      done
      DISK_PCT="$(df -P "$ROOT" | awk 'NR==2 {gsub(/%/,"",$5); print $5}')"
      echo ">> 정리 후 디스크 ${DISK_PCT}%"
      if [[ "${DISK_PCT:-0}" -ge 95 ]]; then
        echo "!! ❌ 캐시 정리 후에도 ${DISK_PCT}% — 빌드가 도중에 죽어 공용 호스트 전체가 위험하다."
        echo "!! 확인: docker system df   (이미지 정리는 타 서비스 영향 검토 후 수동으로)"
        exit 1
      fi
    fi
    # ★--no-cache 필수: 캐시 빌드가 소스가 바뀌었는데도 COPY 레이어를 재사용해 **무변경 이미지**(구 코드+구
    #   마이그레이션)를 배포하는 사고가 있었다(v1.35.0 — 이미지가 v1.34.0로 남고 신규 컬럼 마이그레이션 누락).
    #   E2E 게이트는 소스 워킹카피로 돌아 통과하므로 이 무변경 배포를 못 잡는다 → 빌드는 항상 no-cache.
    echo ">> 빌드(--no-cache, 캐시 무변경배포·마이그레이션 누락 방지) + 기동(마이그레이션 api 자동 적용)"
    dc build --no-cache api web
    dc up -d
    ;;
  --seed)
    echo ">> 시드 데이터 적재 (컨테이너 내 tsc 컴파일 후 실행 — ts-node 런타임 이슈 회피)"
    dc exec -T api sh -c "cd /app/apps/api && npx tsc prisma/seed.ts --outDir dist/seedjs --module commonjs --target ES2022 --esModuleInterop --moduleResolution node --skipLibCheck && node dist/seedjs/seed.js"
    ;;
  --down)
    echo ">> LIS 스택만 중지(다른 서비스 무관)"
    dc down
    ;;
  --logs)
    dc logs -f --tail=100
    ;;
  --up|*)
    echo ">> 기동(이미지 존재 시)"
    dc up -d
    ;;
esac

echo ">> 현재 LIS 컨테이너:"
dc ps
