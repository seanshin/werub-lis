#!/usr/bin/env bash
# 환자 병합 커버리지 게이트 — patientId를 가진 테이블이 전부 merge()에 반영됐는지 검사.
#
# 왜 자동화하는가: 2026-07-29에 billing_item·billing_claim·critical_notify·infectious_report
# 4종이 병합에서 빠져 있는 것을 발견했다. 증상이 조용하다 — 병합은 성공했다고 나오고
# 오더·수혈은 옮겨졌는데, **청구는 잘못된 환자로 나가고 위험치 통보·법정신고 이력은 끊긴다.**
# 새 테이블에 patientId를 넣을 때 병합을 같이 고치는 것을 사람 기억에 맡기지 않는다.
#
# 예외를 두려면 EXEMPT에 사유와 함께 등재할 것.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCHEMA="$ROOT/apps/api/prisma/schema.prisma"
SVC="$ROOT/apps/api/src/modules/patient/patient.service.ts"

# 병합 대상이 아닌 것 — 사유 필수
#   Patient: 병합의 주체(자기 자신)
EXEMPT="Patient"

# schema에서 patientId 필드를 가진 model 수집
models=$(awk '
  /^model /   { m=$2 }
  /patientId/ { if (m != "") print m }
' "$SCHEMA" | sort -u)

# merge() 트랜잭션 본문에서 tx.<model>.updateMany 호출 수집(camelCase → 비교용 소문자화)
covered=$(sed -n '/\$transaction(async (tx) => {/,/^    });/p' "$SVC" \
  | grep -oE 'tx\.[a-zA-Z]+\.updateMany' | sed 's/tx\.//;s/\.updateMany//' | tr 'A-Z' 'a-z' | sort -u)

missing=""
for m in $models; do
  case " $EXEMPT " in *" $m "*) continue;; esac
  key=$(echo "$m" | tr 'A-Z' 'a-z')
  echo "$covered" | grep -qx "$key" || missing="$missing $m"
done

if [ -n "$missing" ]; then
  echo "환자 병합 미반영 — patientId를 가졌는데 merge()가 옮기지 않는 테이블:"
  for m in $missing; do echo "  - $m"; done
  echo "→ patient.service.ts merge()의 moved 목록에 추가하거나,"
  echo "  병합 대상이 아니면 이 스크립트의 EXEMPT에 사유와 함께 등재할 것."
  echo "⚠ 방치하면 병합은 성공으로 보이는데 해당 기록만 구 환자에 남는다(청구 오귀속·이력 분절)."
  exit 1
fi

count=$(echo "$models" | wc -w | tr -d ' ')
echo "환자 병합 커버리지 OK (patientId 보유 ${count}개 테이블 대조)"
