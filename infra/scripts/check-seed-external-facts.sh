#!/usr/bin/env bash
# 시드가 **교차 시스템 사실**을 지어내지 못하게 막는다.
#
# 왜: `pathology_case.mwlStatus='SENT'`는 "PACS에 워크리스트를 만들어 놓았다"는 뜻이고,
# 코드에서는 `sendOrm`이 **ACK=AA를 받았을 때만** 쓴다. 시드가 이걸 하드코딩하면
# LIS는 "있다"고 하는데 PACS엔 없다 — 2026-08-03 PACS가 SP-2026-1002~1004를 두고
# "송신 실패가 조용히 SENT로 기록되는 경로가 있는 것 아니냐"며 리스너 로그까지 뒤졌다.
# 결론은 시드였지만, 그 조사 비용은 실제로 발생했다. 같은 유형의 필드가 또 생길 수 있다.
#
# 규칙: 아래 필드는 **외부 시스템이 받았음을 주장**하는 값이라 시드가 설정할 수 없다.
#       시드는 우리 쪽 사실(접수·그로싱·판독 등)만 적는다.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SEED_DIR="$ROOT/apps/api/prisma"

# 외부 시스템 도달을 주장하는 필드(런타임이 ACK/응답을 받고 쓰는 것만)
FORBIDDEN=(
  'mwlStatus'        # PACS 워크리스트 생성/취소 — sendOrm이 ACK=AA일 때만
  'mwlSentDt'        # 〃
  'wsiConfirmedDt'   # PACS에서 WSI 실재 확인 — viewer-link found일 때만
)

hits=0
for field in "${FORBIDDEN[@]}"; do
  # 주석 줄은 제외 — 왜 금지인지 설명하는 주석은 있어야 한다
  found="$(grep -rn "$field" "$SEED_DIR" --include='*.ts' 2>/dev/null \
           | grep -v '^\s*[0-9]*:\s*//' | grep -vE ':\s*//' || true)"
  if [ -n "$found" ]; then
    echo "시드가 교차 시스템 사실을 설정한다 — '$field':"
    echo "$found" | sed 's/^/  /'
    hits=$((hits+1))
  fi
done

if [ "$hits" -gt 0 ]; then
  echo "→ 시드는 **우리 쪽 사실만** 적는다. 외부 도달 여부는 런타임이 ACK/응답을 받고 기록한다."
  echo "  (지어내면 LIS는 '있다'는데 상대 시스템엔 없다 — 2026-08-03 PACS 조사 유발)"
  exit 1
fi

echo "시드 교차 시스템 사실 OK (금지 필드 ${#FORBIDDEN[@]}종 미사용)"
