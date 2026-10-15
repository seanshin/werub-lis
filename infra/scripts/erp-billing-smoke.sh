#!/usr/bin/env bash
# ERP 청구 연동 스모크 — LIS 송신·폴링·HMAC·멱등을 종단 검증(전송→SENT→폴링→ACCEPTED).
#
# 두 모드:
#   --mock  (기본) : ERP 계약을 구현한 목(mock) 컨테이너를 띄워 검증 → 끝나면 목·임시 env 전량 원복.
#                    실 ERP 없이 반복 가능한 리허설. LIS 파이프라인 자체를 증명.
#   --live         : 운영자가 이미 ERP_BILLING_URL/SECRET 주입·api 재기동한 상태를 가정.
#                    실 ERP로 오더 1건 전송·검증(그 청구는 실제로 남음). env·데이터 원복 없음.
#
# ⚠ 라이브 lis DB는 --mock에서 스모크 오더의 청구상태만 원복(CAPTURED). 마스터·타 데이터 무영향.
#   공유 postgres/redis 설정 변경 없음. 사용: ./infra/scripts/erp-billing-smoke.sh [--mock|--live]
set -euo pipefail

MODE="${1:---mock}"
API="localhost:4101"
NET="${LIS_NET:-lis_default}"
COMPOSE_ARGS="-p lis --env-file infra/docker/.env -f infra/docker/docker-compose.prod.yml"
pass=0; fail=0
ok()   { echo "  ✓ $1"; pass=$((pass+1)); }
bad()  { echo "  ✗ $1"; fail=$((fail+1)); }

for c in lis-api lis-postgres; do
  docker ps --format '{{.Names}}' | grep -q "^${c}$" || { echo "[smoke] $c 미가동 — 중단"; exit 1; }
done

# 관리자 토큰(JWT_SECRET 서명 — 계정 비번 무관)
TOK=$(docker exec lis-api node -e 'const j=require("jsonwebtoken");process.stdout.write(j.sign({sub:"U00",name:"smoke"},process.env.JWT_SECRET,{expiresIn:"10m"}))')
[ -n "$TOK" ] || { echo "[smoke] 토큰 생성 실패"; exit 1; }
api() { curl -s -H "authorization: Bearer $TOK" -H 'content-type: application/json' "$@"; }
jget() { python3 -c "import sys,json;d=json.load(sys.stdin);print(eval('d'+sys.argv[1]))" "$1" 2>/dev/null || echo ""; }

# ★임시 산출물은 예측 가능한 /tmp 고정경로가 아니라 600 임시 디렉터리에 둔다(2026-07-30 보안 검토).
#   공유 호스트에서 다른 계정이 /tmp/erp_mock.py를 선점하면 컨테이너에 마운트되는 코드를 통제할 수 있었고,
#   .env 사본(.env.smokebak)은 gitignore 밖이라 운영 시크릿 전량이 워크트리에 남았다.
SMOKE_TMP="$(mktemp -d)"; chmod 700 "$SMOKE_TMP"
MOCK_PY="$SMOKE_TMP/erp_mock.py"
MOCK_UP=0; ENV_BAK=""
cleanup_mock() {
  echo "[smoke] 원복 중…"
  [ -n "$ENV_BAK" ] && [ -f "$ENV_BAK" ] && mv "$ENV_BAK" infra/docker/.env
  docker compose $COMPOSE_ARGS up -d api >/dev/null 2>&1 || true
  docker rm -f mock-erp >/dev/null 2>&1 || true
  rm -rf "$SMOKE_TMP"
  [ -n "${SMOKE_OID:-}" ] && docker exec lis-postgres psql -U lis -d lis -c \
    "delete from billing_claim where order_id='$SMOKE_OID'; update billing_item set status='CAPTURED', claim_batch_id=null where order_id='$SMOKE_OID' and status='CLAIMED';" >/dev/null 2>&1 || true
  echo "[smoke] 원복 완료(ERP 미구성=스테이징 상태)"
}

setup_mock() {
  local secret; secret=$(openssl rand -hex 32)
  cat > "$MOCK_PY" <<'PY'
import os, json, hmac, hashlib, time
from http.server import BaseHTTPRequestHandler, HTTPServer
SECRET=os.environ["ERP_MOCK_SECRET"].encode(); STAGED={}  # argv 대신 env — 호스트 ps 노출 방지
def verify(ts,payload,sig):
    if not ts or not sig: return False
    try:
        if abs(time.time()-int(ts))>300: return False
    except ValueError: return False
    s=sig[7:] if sig.startswith("sha256=") else sig
    return hmac.compare_digest(s, hmac.new(SECRET,f"{ts}.{payload}".encode(),hashlib.sha256).hexdigest())
class H(BaseHTTPRequestHandler):
    def log_message(self,*a): pass
    def _s(self,c,o):
        b=json.dumps(o).encode(); self.send_response(c); self.send_header("content-type","application/json"); self.end_headers(); self.wfile.write(b)
    def do_POST(self):
        n=int(self.headers.get("content-length",0)); body=self.rfile.read(n).decode()
        if not verify(self.headers.get("X-Integration-Ts"),body,self.headers.get("X-Integration-Signature","")):
            print("[POST] 서명검증 실패",flush=True); return self._s(401,{"error":"sig"})
        m=json.loads(body); STAGED[m.get("lisBillingId")]=m.get("revision")
        print(f"[POST] 서명 OK {m.get('lisBillingId')} items={len(m.get('items',[]))}",flush=True)
        self._s(200,{"status":"ACCEPTED","lisBillingId":m.get("lisBillingId")})
    def do_GET(self):
        cid=self.path.rsplit("/",1)[-1]
        if not verify(self.headers.get("X-Integration-Ts"),cid,self.headers.get("X-Integration-Signature","")):
            return self._s(401,{"error":"sig"})
        print(f"[GET] 서명 OK {cid}",flush=True)
        self._s(200,{"status":"ACCEPTED" if cid in STAGED else "PENDING"})
HTTPServer(("0.0.0.0",4199),H).serve_forever()
PY
  docker rm -f mock-erp >/dev/null 2>&1 || true
  # 시크릿은 --env-file(600)로 — `-e KEY=VALUE`나 argv는 호스트 ps에 평문으로 남는다.
  printf 'ERP_MOCK_SECRET=%s\n' "$secret" > "$SMOKE_TMP/mock.env"; chmod 600 "$SMOKE_TMP/mock.env"
  docker run -d --name mock-erp --network "$NET" -v "$MOCK_PY":/mock.py --env-file "$SMOKE_TMP/mock.env" python:3.12-alpine python /mock.py >/dev/null
  sleep 3
  ENV_BAK="$SMOKE_TMP/env.smokebak"   # 워크트리 밖(600 임시디렉터리) — 운영 시크릿 사본을 리포에 남기지 않는다
  cp infra/docker/.env "$ENV_BAK"
  printf '\nERP_BILLING_URL=http://mock-erp:4199/api/v1/integration/lis/billing\nERP_BILLING_SECRET=%s\nBILLING_SWEEP=off\n' "$secret" >> infra/docker/.env
  docker compose $COMPOSE_ARGS up -d api >/dev/null 2>&1
  sleep 12
  MOCK_UP=1
  echo "[smoke] 목 ERP 구성 완료(mock-erp:4199)"
}

# ── 스모크 오더 확보(CAPTURED 청구항목 보유 오더, 없으면 확정오더 캡처) ──
pick_order() {
  local oid
  oid=$(docker exec lis-postgres psql -U lis -d lis -t -A -c "select order_id from billing_item where status='CAPTURED' limit 1;" | tr -d '[:space:]')
  if [ -z "$oid" ]; then
    oid=$(docker exec lis-postgres psql -U lis -d lis -t -A -c "select distinct o.order_id from lab_order o join specimen s on s.order_id=o.order_id join result r on r.specimen_no=s.specimen_no where r.verify_state in ('AUTO','VERIFIED') limit 1;" | tr -d '[:space:]')
    [ -n "$oid" ] && api -X POST "$API/api/v1/billing/capture/$oid" >/dev/null
  fi
  echo "$oid"
}

echo "== ERP 청구 스모크 (모드=$MODE) =="

if [ "$MODE" = "--mock" ]; then
  trap cleanup_mock EXIT
  setup_mock
elif [ "$MODE" = "--live" ]; then
  url=$(docker exec lis-api sh -c 'printenv ERP_BILLING_URL' 2>/dev/null || true)
  [ -n "$url" ] || { echo "[smoke] ERP_BILLING_URL 미주입 — 실 URL·시크릿 주입 후 api 재기동하고 --live 재실행"; exit 1; }
  echo "[smoke] 실 ERP 대상: $url (오더 1건 실제 전송됨)"
else
  echo "사용법: $0 [--mock|--live]"; exit 2
fi

SMOKE_OID=$(pick_order)
[ -n "$SMOKE_OID" ] || { echo "[smoke] 청구 대상 오더 없음(확정 결과 필요) — 중단"; exit 1; }
echo "[smoke] 대상 오더: $SMOKE_OID"

# ① 전송 → SENT
TX=$(api -X POST "$API/api/v1/billing/transmit" -d "{\"orderId\":\"$SMOKE_OID\"}")
st=$(echo "$TX" | jget "['data']['claims'][0]['status']")
[ "$st" = "SENT" ] && ok "전송 → SENT" || bad "전송 상태=$st (SENT 기대)"

# ② 폴링 → ACCEPTED
PL=$(api -X POST "$API/api/v1/billing/claims/LIS-$SMOKE_OID/poll")
pst=$(echo "$PL" | jget "['data']['status']")
[ "$pst" = "ACCEPTED" ] && ok "폴링 → ACCEPTED" || bad "폴링 상태=$pst (ACCEPTED 기대 · REJECTED면 사유: $(echo "$PL" | jget "['data']['rejectReason']"))"

# ③ 멱등 — 재전송 시 이미 CLAIMED라 재발송 없음
TX2=$(api -X POST "$API/api/v1/billing/transmit" -d "{\"orderId\":\"$SMOKE_OID\"}")
n2=$(echo "$TX2" | jget "len(d['data']['claims'])")
[ "${n2:-0}" = "0" ] && ok "멱등 — 재전송 없음(항목 CLAIMED)" || echo "  · 재전송 대상 $n2건(추가 확정분일 수 있음)"

echo "== 결과: $pass PASS · $fail FAIL · 모드=$MODE =="
[ "$fail" -eq 0 ] || exit 1
