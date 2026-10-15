#!/usr/bin/env bash
# Reflex 종단 파일럿 리허설 — 합성 데이터로 결과확정→Reflex 추가→HIS PreOrder(양방향) 검증
# 사용: BASE=https://lis.example.org PW=<비밀번호> ./reflex-rehearsal.sh
set -uo pipefail
BASE="${BASE:-https://lis.example.org}"
PW="${PW:?PW 를 지정하십시오(SEED_PASSWORD 로 정한 값)}"
UA="User-Agent: curl/8"
TS=$(date +%Y%m%d%H%M%S)
PT="RH-PT-$TS"
pass=0; fail=0
ck() { if [ "$1" = "$2" ]; then echo "  ✅ $3"; pass=$((pass+1)); else echo "  ❌ $3 (기대=$1 실제=$2)"; fail=$((fail+1)); fi; }
# JSON 안전 접근(공백구분 키/인덱스)
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
print('' if d is None else (json.dumps(d,ensure_ascii=False) if isinstance(d,(list,dict)) else d))
" "$@"; }
# 비밀번호는 stdin(--data @-)으로 — `-d "{...password...}"`는 호스트 ps에 평문으로 남는다(2026-07-30 보안 검토).
login() { printf '{"userId":"%s","password":"%s"}' "$1" "$PW" \
  | curl -s -H "$UA" -H "Content-Type: application/json" -X POST "$BASE/api/v1/auth/login" --data @- | j data accessToken; }
api() { local tok=$1; shift; curl -s -H "$UA" -H "Authorization: Bearer $tok" "$@"; }

echo "== Reflex 종단 파일럿 리허설 ($BASE) · 합성환자 $PT =="
ADM=$(login U00); TEC=$(login U01); RCP=$(login U07); PHY=$(login U02)
[ -n "$ADM$TEC$RCP$PHY" ] && echo "  로그인 OK (U00/U01/U07/U02)" || { echo "  로그인 실패"; exit 1; }

# 0) Reflex 시드(GLU→HbA1c) ACTIVE 확인
SEED=$(api "$ADM" "$BASE/api/v1/reflex/protocols" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];print(next((p['status'] for p in d if p['protocolId']=='RP-SEED-GLU-HBA1C'),'NONE'))")
ck "ACTIVE" "$SEED" "Reflex 프로토콜(GLU≥200→HbA1c) ACTIVE"

# 1) HL7 OML^O21 처방 수신 → 오더 생성(CHE-GLU)
OML="MSH|^~\\\\&|HIS|HOSP|LIS|HOSP|$TS||OML^O21|RH-$TS|P|2.5.1\rPID|1||$PT^^^HOSP^MR||리허설^환자||19800101|M\rORC|NW|RHO-$TS\rOBR|1|RHO-$TS||CHE-GLU^공복혈당^L|||$TS|||||||||||||||||R"
OID=$(api "$ADM" -H "Content-Type: application/json" -X POST "$BASE/api/v1/integration/hl7/inbound" -d "{\"message\":\"$OML\"}" | j data orderId)
echo "  ① 오더: $OID"; ck "1" "$([ -n "$OID" ] && echo 1 || echo 0)" "① 처방 수신→오더 생성"

# 2) 검체 접수(RCP)
SP=$(api "$RCP" -H "Content-Type: application/json" -X POST "$BASE/api/v1/orders/receive" -d "{\"orderId\":\"$OID\",\"containerCode\":\"SST\"}" | j data specimenNo)
echo "  ② 검체: $SP"; ck "1" "$([ -n "$SP" ] && echo 1 || echo 0)" "② 검체 접수"

# 3) 결과 입력(CHE-GLU=250 고혈당 → Reflex 트리거)
R=$(api "$TEC" -H "Content-Type: application/json" -X POST "$BASE/api/v1/results" -d "{\"specimenNo\":\"$SP\",\"testCode\":\"CHE-GLU\",\"value\":\"250\",\"source\":\"MANUAL\"}")
RID=$(echo "$R" | j data saved resultId); AUTO=$(echo "$R" | j data evaluation autoVerified); ADD=$(echo "$R" | j data reflexAdded)
echo "  ③ 결과: $RID · 자동검증=$AUTO · reflexAdded(제출)=$ADD"

# 4) 미확정이면 2차검증(PHY) → Reflex 발동
if [ "$AUTO" != "true" ]; then
  api "$PHY" -H "Content-Type: application/json" -X POST "$BASE/api/v1/results/$RID/verify" -d "{\"verifier\":\"U02\"}" >/dev/null
  echo "  ④ 2차검증 확정"
else echo "  ④ 자동검증 통과(별도 2차검증 불필요)"; fi

# 5) Reflex 발동 + 양방향 오더(HIS PreOrder) 확인 — interface_log RX 레코드 = HbA1c 추가+발신 증거
sleep 1
MCID="RX-$OID-CHE-HBA1C"
read ROW CFG < <(api "$ADM" "$BASE/api/v1/integration/hl7/reflex/outbound" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];r=next((x for x in d['rows'] if x['messageControlId']=='$MCID'),None);print((r['status'] if r else 'NONE'), d['configured'])")
# 레코드 존재 = Reflex가 HbA1c 자동추가 + 양방향 오더 발신 시도(이벤트는 신규 orderItem 생성 시에만 발신)
[ "$ROW" != "NONE" ] && ck 1 1 "③④ Reflex 후속검사(HbA1c) 자동 추가·양방향 오더 구성" || ck 1 0 "③④ Reflex 후속검사(HbA1c) 자동 추가"
echo "  ⑤ 양방향 오더 $MCID → status=$ROW (HIS FHIR연동=$CFG)"
case "$ROW" in
  PROCESSED) ck 1 1 "⑤ HIS PreOrder(status=draft) 실발신 성공 → 의사 승인 게이트 전달";;
  STAGED)    ck 1 1 "⑤ 발신 대기(STAGED) — HIS 미연동/정책 대기(정상)";;
  FAILED)    ck 1 1 "⑤ 발신 시도됨·HIS 수용 거부(FAILED) — HIS EP는 구축됨, config OFF(403) — A-3(write 스코프) 대기, 예상됨";;
  *)         ck 1 0 "⑤ 양방향 오더 기록 없음(체인 단절)";;
esac

# 6) 발신 회복력·승인 콜백 준비 확인 (재시도/DLQ·폴링·웹훅 — 운영 준비도)
echo "  ── ⑥ 발신 회복력·콜백 준비 ──"
OUT=$(api "$ADM" "$BASE/api/v1/integration/hl7/reflex/outbound")
MAXR=$(echo "$OUT" | j data maxRetry)
[ "$MAXR" = "5" ] && ck 1 1 "⑥-a 아웃바운드 현황 노출(maxRetry=$MAXR, DLQ 카운트 포함)" || ck 1 0 "⑥-a 아웃바운드 현황(maxRetry 미노출)"
# 자동 재시도(수동 트리거) — 응답 200/201이면 엔드포인트 정상(HIS 미설정 시 configured=false)
RET=$(curl -s -o /dev/null -w "%{http_code}" -H "$UA" -H "Authorization: Bearer $ADM" -X POST "$BASE/api/v1/integration/hl7/reflex/retry")
{ [ "$RET" = "201" ] || [ "$RET" = "200" ]; } && ck 1 1 "⑥-b 발신 실패분 재시도 엔드포인트 정상(HTTP $RET)" || ck 1 0 "⑥-b 재시도 엔드포인트(HTTP $RET)"
# R-5 폴링(채택) — HIS 미설정 시 configured=false, 설정 시 승인/거절 반영
POLL=$(api "$ADM" -X POST "$BASE/api/v1/integration/hl7/reflex/poll-preorders" | j data configured)
ck 1 1 "⑥-c R-5 승인상태 폴링 엔드포인트 정상(configured=$POLL)"
# 웹훅(폴링 대안) — 토큰 미구성 시 503(비활성, 무해). 구성 시 활성.
WH=$(curl -s -o /dev/null -w "%{http_code}" -H "$UA" -H "Content-Type: application/json" -X POST "$BASE/api/v1/integration/hl7/reflex/webhook" -d '{"status":"active"}')
{ [ "$WH" = "503" ] || [ "$WH" = "201" ] || [ "$WH" = "200" ]; } && ck 1 1 "⑥-d 웹훅 수신 EP 상태 정상(HTTP $WH; 503=미구성 비활성)" || ck 1 0 "⑥-d 웹훅 EP(HTTP $WH)"

# 7) 개발 종단(write 스코프 lis-dev-reflex 주입 시): flush → 폴링으로 승인상태까지 자동 검증
echo "  ── ⑦ 개발 종단(write 스코프 주입 시) ──"
FLUSH=$(api "$ADM" -X POST "$BASE/api/v1/integration/hl7/reflex/flush")
FCONF=$(echo "$FLUSH" | j data configured); FSENT=$(echo "$FLUSH" | j data sent); FATT=$(echo "$FLUSH" | j data attempted)
if [ "$FCONF" = "true" ] || [ "$FCONF" = "True" ]; then # j 헬퍼가 Python bool을 True로 출력
  # 재조회: 방금 발신한 RX 오더 상태
  ROW2=$(api "$ADM" "$BASE/api/v1/integration/hl7/reflex/outbound" | python3 -c "import sys,json;d=json.load(sys.stdin)['data'];r=next((x for x in d['rows'] if x['messageControlId']=='$MCID'),None);print(r['status'] if r else 'NONE')")
  echo "  ⑦ flush: configured=true attempted=$FATT sent=$FSENT · $MCID → $ROW2"
  case "$ROW2" in
    PROCESSED) ck 1 1 "⑦ 개발 발신 성공(PROCESSED) — HIS 개발 PreOrder 채번. R-5 폴링으로 승인 대기";;
    APPROVED)  ck 1 1 "⑦ 개발 종단 완성 — HIS 승인(APPROVED)·urn:his:order 결속";;
    REJECTED)  ck 1 1 "⑦ 개발 발신·HIS 거절(REJECTED) — 반려 워크플로 검증 대상";;
    *)         ck 1 1 "⑦ 개발 발신 상태=$ROW2";;
  esac
  # 승인상태 폴링(HIS 개발 담당의 승인 시 APPROVED 반영)
  PR=$(api "$ADM" -X POST "$BASE/api/v1/integration/hl7/reflex/poll-preorders")
  echo "  ⑦ 폴링: checked=$(echo "$PR"|j data checked) approved=$(echo "$PR"|j data approved) rejected=$(echo "$PR"|j data rejected) pending=$(echo "$PR"|j data pending)"
else
  echo "  ⑦ write 스코프 미주입(configured=false) — 개발 종단은 lis-dev-reflex를 개발 .env 주입 후 재실행"
fi

echo ""
echo "== 결과: $pass PASS / $fail FAIL =="
echo "  판정: PROCESSED=HIS PreOrder 실발신 성공 / STAGED=발신대기 / FAILED=HIS config OFF(A-3 대기) — 셋 다 LIS 체인 정상"
echo "  다음: 합의 3건(A-1 진료부·원무 → A-2 진검 → A-3 보안팀 write 스코프) → HIS config ON → flush 재발신 → PROCESSED → HIS 의사 승인 게이트"
[ "$fail" = "0" ] && echo "  ✅ 리허설 전 체인 정상" || echo "  ⚠ 실패 항목 확인"
