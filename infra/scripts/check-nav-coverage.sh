#!/usr/bin/env bash
# 사이드바 도달성 검증 — apps/web의 모든 page.tsx 경로가 사이드바(Sidebar.tsx GROUPS)
# 또는 상위 화면에서 도달 가능한지 확인한다.
#
# 왜: 신규 화면을 만들어도 진입점(메뉴 링크)이 빠지면 "기능이 사라진" 것처럼 보인다.
# 실제 사이드바는 Sidebar.tsx이고, 죽은 Nav.tsx에 링크를 넣어 화면에 안 뜬 사고가 있었다
# (2026-07-24). 사람이 매번 대조하지 말고 CI가 막는다.
#
# 도달 판정: ①Sidebar GROUPS의 href에 있거나 ②앱 어느 소스에서든 그 경로로 이동/링크하거나
# (router.push·href·apiText 등 문자열로 등장) ③아래 EXEMPT(진입점 불요 화면).
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
WEB="apps/web/src"
SIDEBAR="$WEB/components/Sidebar.tsx"

# 진입점이 필요 없는 화면(사유 명기). 루트·리다이렉트·하위 상세/서브탭 등.
EXEMPT=(
  /                          # 랜딩(로그인/대시보드 리다이렉트)
  /admin/signoff             # /admin/gates로 리다이렉트(서명·결재 메뉴로 진입)
  /admin/readiness           # /admin/console로 리다이렉트(운영관리콘솔로 승격·통합, P1)
  /admin/gates/checklist     # gates 화면 내부에서 진입하는 서브페이지
  /settings/password         # 비밀번호 변경 — 계정 메뉴/최초로그인 흐름에서 진입
  /orders/downtime           # 오더 화면 내부 링크(다운타임)
  /microbiology/notifiable   # 미생물/감염관리 화면 내부 진입
  /results/report            # 검체 검색·보고서 바로가기(사이드바 검색창)에서 진입
  /results/entry             # 결과입력 — 오더/워크리스트에서 진입(별도 메뉴도 있으나 면제 안전)
  /help/glossary             # help 화면 내부 링크
)

# 사이드바 GROUPS에 등재된 href
nav=$(grep -oE "href: '/[^']*'" "$SIDEBAR" | sed "s/href: '//;s/'//" | sort -u)
# 앱 전체 소스에서 문자열로 등장하는 경로(동적 이동·링크 포함) — 정적 대조가 못 잡는 라우팅 보완
referenced=$(grep -rhoE "['\"\\\`]/[a-z][a-z0-9/_-]*" "$WEB" --include='*.tsx' --include='*.ts' \
  | sed -E "s/^['\"\\\`]//" | sort -u)

missing=()
while IFS= read -r page; do
  route="${page#"$WEB/app"}"; route="${route%/page.tsx}"; route="${route:-/}"
  # 동적 세그먼트([id])는 대조 대상 아님 — 목록/상세 진입은 부모에서 이뤄진다
  [[ "$route" == *"["* ]] && continue
  grep -qx "$route" <<<"$nav" && continue
  [[ " ${EXEMPT[*]} " == *" $route "* ]] && continue
  # 어느 소스에서든 이 경로로 링크/이동하면 도달 가능으로 본다(사이드바 아닌 화면 내 진입)
  grep -qE "(^|[^a-z0-9_-])${route}([^a-z0-9/_-]|\$)" <<<"$referenced" && continue
  missing+=("$route")
done < <(find "$WEB/app" -name page.tsx | sort)

if [ ${#missing[@]} -eq 0 ]; then
  echo "nav 도달성 OK ($(find "$WEB/app" -name page.tsx | wc -l | tr -d ' ')개 화면 검사)"
  exit 0
fi

echo "사이드바 도달 불가 화면 — 메뉴/진입점 없음(사용자에겐 기능이 사라진 것처럼 보임):"
printf '  - %s\n' "${missing[@]}"
echo "→ $SIDEBAR 의 GROUPS에 링크를 추가하거나(실제 사이드바는 이 파일뿐),"
echo "  상위 화면에서 진입하는 서브페이지면 이 스크립트의 EXEMPT에 사유와 함께 등재할 것."
exit 1
