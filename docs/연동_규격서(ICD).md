# 🔌 LIS ↔ HIS/PACS 연동 규격서 (Interface Control Document)

> 본 문서는 **이미 구현·검증된 연동 규격**을 HIS/PACS팀 검토·서명용으로 정식화한 것이다.
> 실 HIS로 Reflex 전주기 genuine PASS(발신→PreOrder→승인/반려) 검증 완료.
> 상태: 기술 규격 확정 · **HIS 회신(2026-07-17) 반영** · 사람 게이트 3건만 대기. 최종 갱신 2026-07-17.

## 0. HIS 회신 반영 (2026-07-17)
- **채널 확정**: HIS↔LIS는 **FHIR 전용**. HIS가 **MLLP 폐기** 선언 → 결과 발신은 **FHIR DiagnosticReport만**(ORU MLLP 미사용). PACS MLLP는 별개로 유지.
- **오더 유입 = FHIR 폴링 확정**(ServiceRequest, LIS→HIS pull). HL7 OML 인바운드 푸시 미사용 → §9-1(푸시 인증) 불요.
- **ADT 미채택** — 오더 기반 on-demand 유지(구현됨). **취소 = ServiceRequest `revoked`** 전이(폴링으로 감지·전파, 구현됨). **정정 = amended DiagnosticReport 재발신**(구현됨).
- **운영 합의 진행**: DLQ 소유·다운타임 — LIS는 **결과 발신 실패 재시도/DLQ 큐**를 구현(§7). 감시 주체·SLA는 협의.
- **대기(사람 게이트)**: A-3 실운영 write 결재 · 병리 EDI code set · SNOMED 라이선스. EDI 코드 덤프는 요청 시 CSV 수령.

---

## 1. 개요

| 흐름 | 방향 | 전송 | 메시지 |
|------|------|------|--------|
| 처방(오더) 수신 | HIS → LIS | HL7 v2 인바운드 / FHIR 폴링 | OML^O21 / ServiceRequest(LAB) |
| 결과 발신 | LIS → HIS | HL7 MLLP / FHIR | ORU^R01 / DiagnosticReport |
| 반사검사(Reflex) 오더 | LIS → HIS → LIS | FHIR + 콜백 | ServiceRequest(Bundle) → PreOrder 승인/반려 |
| 병리 워크리스트 | LIS → PACS | HL7 MLLP | ORM^O01 (MWL) |
| 영상 조회 | LIS → PACS | DICOMweb | QIDO/WADO 딥링크 |

LIS 기준 베이스 경로: `https://lis.example.org/api/v1/integration/hl7`

---

## 2. 전송·인증

| 채널 | 방식 | 인증 |
|------|------|------|
| FHIR (LIS→HIS) | HTTPS `application/fhir+json` | **OAuth2 client_credentials** — `POST {HIS_FHIR_TOKEN_URL}` (client_secret_post) → `Bearer` 토큰 |
| HL7 MLLP (LIS→HIS/PACS) | TCP MLLP(0x0B…0x1C 0x0D) | 네트워크(호스트/포트, extra_hosts 경유) |
| 인바운드 HL7 (HIS→LIS) | HTTPS `POST /inbound` | **⚠ 합의 필요** — 현재 앱 JWT. 실 HIS 푸시용 서비스계정/토큰 협의(§9-1) |
| Reflex 웹훅 (HIS→LIS) | HTTPS `POST /reflex/webhook` | 공유 시크릿 헤더 `x-reflex-webhook-token` (= `HIS_REFLEX_WEBHOOK_TOKEN`) |

---

## 3. 인바운드 — 처방 수신 (HIS → LIS)

### 3.1 HL7 방식 (⚠ HIS 회신으로 미채택 — 폴링 사용. 엔드포인트는 유지)
- **엔드포인트**: `POST /api/v1/integration/hl7/inbound` — body `{ "message": "<HL7 raw>" }`
- **메시지**: `OML^O21`(신규/변경/취소). 세그먼트 `MSH·PID·ORC·OBR`.
  - ORC-1: `NW`(신규) / `CA`(취소) / `XO`(변경)
  - OBR-4: `{HIS코드}^{검사명}^L` — HIS코드는 §6 코드매핑으로 LIS 검사코드 해소
- **응답 (ACK, MSA)**: `AA`(수용) / `AE`(오류·미매핑코드) / `AR`(거부)
- **멱등성**: `(direction, MSH-10)` 유니크 — 동시·중복 도착은 최초만 처리(P2002→DUPLICATE)
- **미매핑 코드**: `AE` + 보류(로그 `UNMAPPED_HOLD`) — 코드매핑 등록 후 재수신

### 3.2 FHIR 폴링 방식(**채택 — 주 경로**)
- **트리거**: `POST /his/poll-orders`(수동) 또는 주기 폴링(`HIS_ORDER_POLL`)
- HIS `ServiceRequest?category=laboratory&status=active` 조회 → LIS 오더/병리 케이스 생성(멱등: `hisOrderNo` 중복 체크)
- **증분 폴링(구현·HIS PR#528 지원)**: `_lastUpdated=gt{워터마크}` + `_count` + `next` 커서 페이지네이션. 워터마크는 `integration_state`에 저장, 1초 백오프(멱등이라 경계 재조회 안전). 다음 폴링은 변경분만 조회 → 대량(처방 7,411건)에서 효율.
- **취소**: `status=revoked` 폴링(증분 동일 적용) → 매칭 LIS 오더·병리 취소(+PACS 취소 ORM).

### 3.3 환자(ADT)
- 현재 **on-demand**: 오더 유입 시 `PID`로 환자 upsert(ADT 미수신 대비). 병합(MERGED) 환자로 오면 정본으로 재라우팅.
- **⚠ 합의 필요**: 실시간 ADT 피드 채택 여부(§9-2)

---

## 4. 아웃바운드 — 결과 발신 (LIS → HIS)

발신 대상은 **확정(F/C)·자동/수동검증 완료·최신 버전** 결과만(`latestReportable`).

### 4.1 FHIR DiagnosticReport (권장)
- **미리보기**: `GET /fhir/:specimenNo` · **전송**: `POST /fhir/:specimenNo/send-his`
- **★Write 계약(실 HIS 검증됨)**: `DiagnosticReport`는 **직접 POST**(단건). Bundle로 감싸면 422.
- 성공 판정: HTTP 2xx **또는** Bundle 사용 시 `entry.response.status` 2xx까지 확인(외부 200만으로 성공 처리 금지 — fake success 방지). `response.location` → `hisRef` 결속.

### 4.2 ORU^R01 (HL7 MLLP) — ⚠ HIS MLLP 폐기로 **미사용**(엔드포인트는 유지, 타 원내 시스템 대비)
- **미리보기**: `GET /oru/:specimenNo` · **전송**: `POST /oru/:specimenNo/send-mllp`(→ `HIS_MLLP_HOST/PORT`)
- 세그먼트 `MSH·PID·OBR·OBX(NM)`. 자유텍스트·식별자 HL7 이스케이프(구분자·CR/LF 주입 방지).

### 4.3 결과 정정/개정 (구현됨)
- 정정 시 신규 버전 생성(원본 보존)·위험치 재통보 → `result.finalized` 재발생 → **amended DiagnosticReport 자동 재발신**.

### 4.4 발신 복원력 (§9-6·구현됨)
- 발신 실패(HIS 다운 등) 시 검체별 **FAILED 큐 적재**(`interface_log` IF-G08). 자동 재시도(5분 cron, `HIS_REFLEX_RETRY=on`)·임계 초과 시 DLQ.
- 콘솔: `POST /results/retry`(수동 재발신) · `POST /reflex/requeue-dlq`(결과 DLQ 포함 재큐). HIS 복구 후 **유실 없이 재발신**.

---

## 5. Reflex 양방향 오더 (LIS → HIS → LIS)

반사검사 규칙 충족 시 LIS가 HIS에 **추가 처방을 발신**하고, HIS 의사 승인 후 확정된다.

1. **발신**: `ServiceRequest`를 **transaction Bundle**로 POST(★직접 POST는 400 — Bundle 필수). `subject=Patient/{HIS UUID}`, `basedOn=활성 오더`, LOINC 코드. 멱등키 `RX-{orderId}-{testCode}`.
2. **PreOrder**: HIS가 의사 승인 대기 상태(PreOrder) 생성 → LIS는 `entry.response.location`을 `hisRef`로 보관.
3. **승인/반려 반영**(둘 중 택1·병용):
   - **폴링**: `POST /reflex/poll-preorders` (주기 `HIS_REFLEX_POLL`)
   - **웹훅**: `POST /reflex/webhook` (HIS→LIS push, `x-reflex-webhook-token`)
   - 결과: 승인 → `APPROVED`(+ `urn:his:order` 결속) / 반려 → `REJECTED` + **후속검사 자동취소**(병원 정책 2026-07-18: 결과 미보고 orderItem을 CANCELLED, 이미 결과난 건 보존) + `Reflex반려` 알림
- **운영 콘솔**: `reflex/outbound`(현황) · `reflex/flush`(재발신) · `reflex/retry`(실패분) · `reflex/requeue-dlq`(DLQ 복귀)

---

## 6. 코드 매핑

| 매핑 | 키 | 예 |
|------|-----|-----|
| HIS 처방코드 ↔ LIS 검사 | `CodeMapping(lisCode, hisCode, loinc, ediCode)` | `IMM-CRP ↔ E6502 / LOINC 1988-5` |
| 패널(HIS 패널코드=패널코드) | `Panel/PanelItem` | `E6512(전해질)=Na/K/Cl` |
| 병리 EDI | 프리픽스·수가코드 | **⚠ 병리과 확정 필요**(§9-7·D3) |
| 진단 용어 | SNOMED/ICD-O(TerminologyCode) | **⚠ KHIS 라이선스 정식셋**(§9-7·D4) |

- 표준 화학검사 LOINC는 마스터에 반영됨(병원 불문 고정). **HIS EDI 처방코드·프리픽스는 실 메뉴 확정 필요.**

---

## 7. 멱등·오류·재시도

- **멱등키**: 인바운드 `MSH-10`, Reflex `RX-{orderId}-{testCode}`, ORU/발신은 검체 단위.
- **원자적 클레임**: 인바운드/Reflex 발신 모두 `create`/`updateMany status where` 가드로 동시 중복 방지.
- **재시도·DLQ**: Reflex 발신 실패 재시도(`HIS_REFLEX_RETRY`), 임계 초과 시 DLQ 격리 → 사람 개입 후 `requeue-dlq`.
- **로그**: 모든 송수신 `interface_log`(원문·상태·hisRef 보존) — 콘솔 `GET /logs`.

---

## 8. 설정 (환경변수)

```
# FHIR (LIS→HIS)
HIS_FHIR_BASE, HIS_FHIR_TOKEN_URL, HIS_CLIENT_ID, HIS_CLIENT_SECRET, HIS_FHIR_SCOPES
# 폴링·Reflex
HIS_ORDER_POLL, HIS_REFLEX_POLL, HIS_REFLEX_RETRY, HIS_REFLEX_WEBHOOK_TOKEN
# HL7 MLLP (결과 발신)
HIS_MLLP_HOST, HIS_MLLP_PORT
# PACS
PACS_BASE, PACS_USER, PACS_PASS, PACS_MLLP_HOST, PACS_MLLP_PORT
```
- 파일럿은 dev 자격(`lis-dev-reflex`). **운영 자격은 A-3 결재 후 발급·주입**(git 미포함).

---

## 9. 합의·확정 항목 (HIS 회신 2026-07-17 반영)

| # | 항목 | 상태 |
|---|------|------|
| 9-1 | 인바운드 푸시 인증 | ✅ **불요** — 오더 유입 FHIR 폴링 채택(HIS pull 아님, LIS가 pull) |
| 9-2 | ADT 실시간 피드 | ✅ **미채택 확정** — 오더 기반 on-demand 유지 |
| 9-3 | 정정/개정 전파 | ✅ **구현·확정** — amended DiagnosticReport 자동 재발신 |
| 9-4 | 오더 취소 전파 | ✅ **구현·확정** — HIS `revoked` 폴링 감지 → LIS 오더·병리 취소(+PACS 취소 ORM) |
| 9-5 | 재시도·DLQ 소유권 | 🔶 **협의 중** — LIS 재시도/DLQ 큐 구현(§4.4). 감시 주체·알림·SLA는 운영 합의 |
| 9-6 | 다운타임 절차 | 🔶 **부분 구현** — 결과 발신 실패 유실 방지(재시도/DLQ). 수기 대체 SOP는 운영 합의 |
| 9-7 | 코드셋 확정 | ⏳ **대기** — EDI 코드 CSV 요청 시 수령(D2) · 병리 code set(D3) · SNOMED 라이선스(D4) |
| 9-8 | Reflex 실운영 write 스코프 | ⏳ **대기** — A-3 보안 결재 → Reflex 실개통 |
| 9-9 | PACS 컷오버 | ⏳ **대기** — 실 PID·일정(프리플라이트 준비됨) |

**남은 사람 게이트: 9-7(코드셋)·9-8(A-3)·9-9(PACS). 운영 합의: 9-5/9-6(DLQ 소유·다운타임 SOP).**

---

## 10. 컷오버 절차(요약)

1. 운영 자격(FHIR client·MLLP·PACS) 주입(A-3 결재 후).
2. **프리플라이트**(`POST /pacs/cutover-preflight`): 실 병리번호 Accession(≤16)·PID 바이트보존 검증.
3. 코드매핑·참고치 실 메뉴 반영 확인(D2).
4. 소량 실오더 왕복(인바운드→결과 발신→Reflex 승인) 스모크.
5. 폴링/웹훅 개통·모니터링 확인.

> 부속: FHIR write 계약·Reflex 게이트 상세는 `docs/handoff/` 및 감사 리포트. 개시 전 체크리스트 `docs/개시전_체크리스트.md`.
