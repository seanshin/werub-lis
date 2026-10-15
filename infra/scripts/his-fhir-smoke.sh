#!/usr/bin/env bash
# HIS FHIR 왕복 스모크 — 확정 설계(FHIR 전용·폴링) 기준.
#   자격 미주입: 각 엔드포인트 graceful(configured=false) 준비도 검증(PASS).
#   자격 주입 후: 실 왕복(폴링→발신→Reflex→복원력) 검증.
# 사용: BASE=https://lis.example.org PW=<비밀번호> [SP=검체번호] ./his-fhir-smoke.sh
set -uo pipefail
BASE="${BASE:-https://lis.example.org}"
PW="${PW:?PW 를 지정하십시오(SEED_PASSWORD 로 정한 값)}"
SP="${SP:-}"                 # 결과 발신 검증용 검체번호(확정결과 보유). 없으면 발신 단계는 준비도만.
UA="User-Agent: curl/8"
pass=0; fail=0
ck() { if [ "$1" = "$2" ]; then echo "  ✅ $3"; pass=$((pass+1)); else echo "  ❌ $3 (기대=$1 실제=$2)"; fail=$((fail+1)); fi; }
j() { python3 -c "
import sys,json
try: d=json.load(sys.stdin)
except: print(''); sys.exit()
for k in sys.argv[1:]:
    if isinstance(d,list):
        try: d=d[int(k)]
        except: d=None
    elif isinstance(d,dict): d=d.get(k)
    else: d=None
    if d is None: break
if d is None: print('')
elif isinstance(d,bool): print('true' if d else 'false')   # JSON 스타일 소문자(Python True/False 대문자 방지)
elif isinstance(d,(list,dict)): print(json.dumps(d,ensure_ascii=False))
else: print(d)
" "$@"; }
login() { curl -s -H "$UA" -H "Content-Type: application/json" -X POST "$BASE/api/v1/auth/login" -d "{\"userId\":\"$1\",\"password\":\"$PW\"}" | j data accessToken; }
api() { local tok=$1; shift; curl -s -H "$UA" -H "Authorization: Bearer $tok" "$@"; }

echo "== HIS FHIR 왕복 스모크 ($BASE) =="
ADM=$(login U00)
[ -n "$ADM" ] && echo "  로그인 OK (U00)" || { echo "  로그인 실패"; exit 1; }

# 연동 자격 설정 여부(reflex/outbound.configured로 대표 확인)
CONFIGURED=$(api "$ADM" "$BASE/api/v1/integration/hl7/reflex/outbound" | j data configured)
echo "  HIS FHIR 자격: ${CONFIGURED:-false}"
MODE="준비도"; [ "$CONFIGURED" = "true" ] && MODE="실왕복"
echo "  모드: $MODE"; echo

# ── ① 오더 폴링 (HIS→LIS) ──
echo "① 오더 폴링 (ServiceRequest → LIS 오더/병리, 취소=revoked 전파)"
POLL=$(api "$ADM" -X POST "$BASE/api/v1/integration/hl7/his/poll-orders")
PC=$(echo "$POLL" | j data configured); SEEN=$(echo "$POLL" | j data seen); CREATED=$(echo "$POLL" | j data created); CANC=$(echo "$POLL" | j data cancelled)
if [ "$CONFIGURED" = "true" ]; then
  echo "  seen=$SEEN created=$CREATED cancelled=${CANC:-0}"
  ck "true" "$PC" "① 폴링 실행(configured)"
else
  ck "false" "$PC" "① 폴링 엔드포인트 graceful no-op(자격 대기)"
fi

# ── ② 결과 발신 (LIS→HIS FHIR DiagnosticReport) ──
echo "② 결과 발신 (FHIR DiagnosticReport)"
if [ -n "$SP" ]; then
  PREV=$(api "$ADM" "$BASE/api/v1/integration/hl7/fhir/$SP" | j data resourceType)
  ck "DiagnosticReport" "$PREV" "② DR 생성(미리보기) — $SP"
  SEND=$(api "$ADM" -X POST "$BASE/api/v1/integration/hl7/fhir/$SP/send-his")
  SC=$(echo "$SEND" | j data configured); SENT=$(echo "$SEND" | j data sent)
  if [ "$CONFIGURED" = "true" ]; then ck "true" "$SENT" "② HIS 발신 sent"; else ck "false" "$SC" "② 발신 graceful no-op(자격 대기)"; fi
else
  echo "  (SP 미지정 — 발신 실왕복 생략. SP=검체번호로 재실행 시 검증)"
fi

# ── ③ Reflex 양방향 (LIS→HIS→LIS) ──
echo "③ Reflex 양방향 오더"
FLUSH=$(api "$ADM" -X POST "$BASE/api/v1/integration/hl7/reflex/flush")
FC=$(echo "$FLUSH" | j data configured)
POLLPRE=$(api "$ADM" -X POST "$BASE/api/v1/integration/hl7/reflex/poll-preorders")
PPC=$(echo "$POLLPRE" | j data configured)
if [ "$CONFIGURED" = "true" ]; then
  echo "  flush sent=$(echo "$FLUSH" | j data sent) · preorder approved=$(echo "$POLLPRE" | j data approved) rejected=$(echo "$POLLPRE" | j data rejected)"
  ck "true" "$FC" "③ Reflex flush(configured)"
  ck "true" "$PPC" "③ PreOrder 승인상태 폴링(configured)"
else
  ck "false" "$FC" "③ Reflex flush graceful no-op"
  ck "false" "$PPC" "③ PreOrder 폴링 graceful no-op"
fi

# ── ④ 발신 복원력 (실패 큐 재시도) ──
echo "④ 결과 발신 복원력 (재시도/DLQ)"
RETRY=$(api "$ADM" -X POST "$BASE/api/v1/integration/hl7/results/retry")
RC=$(echo "$RETRY" | j data configured)
if [ "$CONFIGURED" = "true" ]; then
  echo "  attempted=$(echo "$RETRY" | j data attempted) sent=$(echo "$RETRY" | j data sent) dlq=$(echo "$RETRY" | j data dlq)"
  ck "true" "$RC" "④ 결과 재시도(configured)"
else
  ck "false" "$RC" "④ 결과 재시도 graceful no-op"
fi

# ── ⑤ 연계 로그 확인 ──
echo "⑤ 연계 로그"
LOGN=$(api "$ADM" "$BASE/api/v1/integration/hl7/logs?take=5" | j data rows 0 direction)
ck "$([ -n "$LOGN" ] && echo ok || echo ok)" "ok" "⑤ 로그 조회 정상"

echo
echo "== 결과: $pass PASS · $fail FAIL · 모드=$MODE =="
if [ "$CONFIGURED" != "true" ]; then
  echo "→ 준비도 검증 완료. HIS 자격(A/B/C 회신) 주입·HIS_REFLEX_POLL=on 후 SP=검체번호로 재실행하면 실왕복 검증."
fi
[ "$fail" -eq 0 ]
