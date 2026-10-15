# 27. Reflex(반사검사) 프로토콜 거버넌스 엔진 기획서

> 대상: LIS v1.0.0 (제작사 위루비/Weruby) · 라이브 https://lis.example.org
> 작성일: 2026-07-14
> 관련: [22 충실성검토] §6-1(리플렉스), [07 기능상세] §7, 09 연계상세, [24 운영 인수인계]

---

## 📌 구현 반영(As-Built) — 2026-07-29 · v1.52.0

> **기획 전량 구현됐고, 기술 잔여는 0이다.** 남은 것은 **조직 합의 A-1/A-2/A-3뿐**이며,
> 그 전까지 발신분은 STAGED/ready로 유지된다(**자동 진행 금지**).

### 구현 결과

| 기획 | 결과 |
|---|---|
| 하드코딩 규칙 → DB 프로토콜 | ✅ `ReflexProtocol`. 기존 `GLU≥200→HbA1c` 무손실 이관 |
| 승인 라이프사이클 | ✅ 전문의→위원회→HIS→ACTIVE. **4-eyes**(작성≠전문의≠위원회 — 단일인 전승인 차단) |
| 사전승인 standing order만 자동실행 | ✅ ACTIVE·유효기간 내만 |
| 양방향 오더(HIS 발신) | ✅ draft ServiceRequest·`basedOn` 원오더·LOINC·멱등키 |
| 승인상태 반영 | ✅ **폴링 확정**(R-5) — active→APPROVED / revoked→REJECTED+알림 |
| QI 리포트 | ✅ 프로토콜별 실행·발신·반려율·추세 |

### 기획에 없던 것 — 운영에서 필요해 추가

- **프로토콜 계보(lineage)** — 개정 승계를 원자적 SUPERSEDE로 처리. 개정판이 이전판을 대체할 때 두 개가 동시에 ACTIVE가 되는 창을 없앴다. 계보 락은 `$executeRaw`(advisory lock이 void 반환이라 `$queryRaw`면 500).
- **반려 자동취소** — 병원 정책으로 채택. 반려 시 해당 orderItem(RECEIVED/IN_PROCESS/HOLD)을 CANCELLED로 자동 취소(**회귀 금지**).
- **발신 재시도·DLQ** — 임계 5회 초과 시 격리. 원자적 클레임(status→SENDING)으로 이중 발신 방지.
- **LOINC 미매핑 발신 보류** — 마스터에 LOINC가 없으면 FAILED로 보류해 HIS 명시거절을 사전 회피.
- **BETWEEN 범위 연산자** · effective 날짜 ISO 검증 · 반려율에 처리분(REJECTED_CANCELLED/KEPT) 포함.

### ⚠ 리허설에서 겪은 것 — "첫 PASS는 가짜였다"

2026-07-15 첫 리허설이 PASS로 보였으나 실제로는 실패였다. 원인이 셋이었고 전부 고쳤다.

| 원인 | 조치 |
|---|---|
| HIS Bundle 핸들러가 미지원 리소스에 **외부 200 OK**를 반환(SR 유실) | HIS 수정 |
| LIS가 **Bundle 외부 201만 보고 inner entry 4xx를 성공 오판** | `entry.response.status` 2xx만 성공(c122041) |
| identifier 재조회 우회가 **무관한 기존 오더를 오결속** | 우회 제거, `hisRef`는 `response.location`에서만(08af00c) |

**교훈:** 외부 연동의 "성공"은 응답 코드 한 겹으로 판정하면 안 된다. 이후 실 참조(subject=Patient/UUID·basedOn=활성 오더·LOINC)로 재실행해 **전 수명주기 진짜 PASS**를 확인했다.

### 현재 상태

- **기술 잔여 0.** 발신·폴링·재시도·DLQ·QI 전부 동작 확인.
- **대기 게이트(사람 몫)**: A-1 수용·청구 정책(진료부·원무) → A-2 승인 주관(진단검사의학과) → A-3 실운영 `ServiceRequest.write` 스코프(보안팀).
- ⚠ **현 DLQ 4건(2026-07-14~15)은 재큐 금지.** 재큐는 "정리"가 아니라 "발신"이며, `HIS_REFLEX_RETRY=on` 상태라 크론이 2주 지난 오더를 실제로 HIS에 밀어넣어 **조직 게이트를 우회**한다. 개시 전환 단계 6에서 파일럿 정리로 해소한다(`docs/실서비스_운영단계_정의서.md` §2).

---

## 1. 배경 · 목적

**Reflex(반사검사)** 는 1차 검사 결과가 특정 조건을 충족하면 후속검사를 **자동으로 추가 시행**하는 규칙이다(예: "TSH가 참고범위를 벗어나면 FT4를 시행한다").

**현행 한계**: 규칙이 코드에 하드코딩(`domain/result-evaluation.ts:REFLEX_RULES`)되어 있고, 유일한 규칙(포도당 ≥200 → HbA1c)만 존재한다. 코드 주석에도 *"규칙의 DB화는 과제"* 로 명시되어 있다. 이 방식은 다음이 불가능하다:
- 임상 규칙을 **의사·검사실이 직접 관리**(코드 배포 없이 추가/수정/중지)
- 규칙의 **승인 거버넌스**(누가 승인했고 언제부터 유효한지) 추적
- **미승인 규칙의 자동 실행 차단**

**핵심 원칙(사용자 요구)**: Reflex 자동 추가는 **사전 처방(standing order)** 이다. 결과가 조건을 벗어나면 후속검사를 시행한다는 규칙 자체가 처방 행위이므로, **① 진단검사의학과 전문의 승인 + ② 병원 위원회 의결**을 거친 규칙에 한해서만 정당하다. **승인된 프로토콜만 동작**한다.

**목적**: 하드코딩 규칙표를 **거버넌스 기반 Reflex 엔진**으로 전환한다.
1. 규칙을 DB화(ReflexProtocol) + **에디터**로 관리
2. **승인 라이프사이클**(전문의→위원회→HIS)로 통제, 승인분만 실행
3. Reflex가 만든 add-on을 **양방향 오더**로 HIS에 신규 오더 발신

---

## 2. 임상 · 규제 원칙 (거버넌스)

| 원칙 | 내용 |
|------|------|
| **사전 처방성** | Reflex 규칙 = standing order. 개별 환자 처방이 아니라 "규칙 자체"가 사전 승인된 처방. |
| **전문의 승인** | 진단검사의학과 전문의(역할 PHY/검증의 상위)가 규칙의 임상 타당성을 승인. |
| **위원회 의결** | 병원 위원회(검사·수혈위 등)가 의결. 의결번호·일자 기록. |
| **HIS 등록·수용** | 양방향 오더로 검사가 추가·청구되므로 HIS(처방·청구 주체)가 프로토콜을 등록·수용해야 실운영. |
| **승인분만 실행** | 상태가 `ACTIVE`(전 단계 승인 완료 + HIS 수용)인 프로토콜만 엔진이 평가·적용. Draft/검토/중지 규칙은 절대 자동 실행 안 함. |
| **불변 감사** | 규칙 생성·수정·승인·의결·중지, 그리고 매 자동추가 실행을 감사로그 전건 기록. |
| **버전·유효기간** | 규칙 변경 시 신규 버전(원본 보존), 유효 시작/종료일. |

---

## 3. 승인 라이프사이클 (상태 기계)

```
 DRAFT ──제출──▶ PENDING_SPECIALIST ──전문의승인──▶ PENDING_COMMITTEE
   ▲                    │ 반려                          │ 의결
   └────────────────────┘                              ▼
                                            PENDING_HIS ──HIS수용──▶ ACTIVE
                                                 │ 거절                 │ 중지/만료
                                                 ▼                     ▼
                                              REJECTED             SUSPENDED / RETIRED
```

| 상태 | 의미 | 전이 주체 |
|------|------|-----------|
| `DRAFT` | 편집 중(에디터 초안) | 작성자(TEC/PHY/ADM) |
| `PENDING_SPECIALIST` | 전문의 검토 대기 | 작성자 제출 |
| `PENDING_COMMITTEE` | 위원회 의결 대기 | **전문의 승인**(PHY) |
| `PENDING_HIS` | HIS 등록·수용 대기 | **위원회 의결 기록**(ADM, 의결번호) |
| `ACTIVE` | **실행 가능** | HIS 수용 회신(또는 수동 확인) |
| `REJECTED` | 반려 | 전문의/위원회/HIS 거절 |
| `SUSPENDED` | 일시 중지(실행 안 함) | ADM |
| `RETIRED` | 폐기(유효종료) | ADM |

> **엔진은 오직 `ACTIVE` + 유효기간 내 프로토콜만 실행.** 각 전이는 주체·시각·사유·(의결번호)를 기록.

---

## 4. 규칙 스키마 (ReflexProtocol)

```
model ReflexProtocol {
  protocolId     String   // RP-YYMMDD-xxxxxx
  name           String   // "갑상선 반사검사(TSH→FT4)"
  version        Int      // 1,2,... (수정 시 신규 버전)
  status         String   // DRAFT/PENDING_*/ACTIVE/REJECTED/SUSPENDED/RETIRED

  // 조건(트리거)
  whenTestCode   String   // 트리거 검사코드 (TSH)
  operator       String   // '<' '<=' '>' '>=' 'OUT_OF_REF' 'FLAG'
  threshold      Float?   // 임계값 (operator가 비교형일 때)
  thresholdHigh  Float?   // 범위형(OUT_OF_REF 보조)
  flag           String?  // 특정 플래그 트리거(H/HH/L/LL) 옵션

  // 조치(추가 검사)
  addTestCodes   String   // 콤마구분 후속검사코드 (FT4)
  priority       String?  // 추가 오더 우선순위(일반/응급)

  // 거버넌스 메타
  specialistBy   String?  // 전문의 승인자, 시각
  committeeNo    String?  // 위원회 의결번호, 의결일
  hisRef         String?  // HIS 프로토콜 등록 ID/수용 회신
  effectiveFrom  String?  // 유효 시작
  effectiveTo    String?  // 유효 종료
  createdBy/ At, updatedAt, 각 전이 이력(ReflexProtocolEvent)
}
```

- **조건 연산자**: `>=`, `<=`, `>`, `<`, `OUT_OF_REF`(참고범위 밖), `FLAG`(지정 플래그). 예: TSH `OUT_OF_REF` → FT4; GLU `>=` 200 → HbA1c.
- **이력 테이블 `ReflexProtocolEvent`**: (protocolId, event, actor, note, committeeNo, at) — 전 전이 불변 기록.

---

## 5. 엔진 동작

- 결과 **확정(자동검증/2차검증) 시점**에 엔진 호출(기존 `applyReflex` 위치 유지).
- 엔진은 `ReflexProtocol` 중 **status=ACTIVE + 유효기간 내**만 로드해 평가.
- 조건 충족 시 후속검사를 **동일 검체/오더에 add-on**(멱등: 이미 있으면 skip, 미등록 검사코드 skip).
- **양방향(§8)**: add-on을 HIS 신규 오더로 발신(수용 시 청구·EMR 반영).
- 매 실행을 감사로그 + 결과에 reflex 근거(protocolId·version) 기록.
- **미승인 규칙은 로드 대상에서 제외** → 원천적으로 실행 불가.

---

## 6. 에디터 · 승인 UI (화면 `/admin/reflex`)

- **규칙 목록**: 상태 배지(DRAFT/ACTIVE/…), 조건·추가검사 요약, 버전.
- **규칙 편집(초안)**: 이름, 트리거(검사·연산자·임계값·플래그), 추가검사(멀티), 우선순위, 유효기간. 검사코드는 마스터에서 검증.
- **승인 액션(역할 게이트)**:
  - 제출(작성자) → 전문의 승인/반려(PHY) → 위원회 의결기록(ADM, 의결번호) → HIS 등록요청 → HIS 수용확인 → ACTIVE.
  - 중지/폐기(ADM).
- **미리보기**: "이 규칙이 최근 N건에 적용됐다면 몇 건 추가됐을지" 시뮬레이션(선택).
- 모든 상태 전이는 확인 모달 + 감사기록.

---

## 7. HIS에 요청할 내용 (정리)

Reflex는 검사 **추가·청구·EMR 반영**을 유발하므로 HIS와의 협의·연계가 필수다. LIS가 HIS에 요청할 항목:

### 7-A. 양방향 오더 인터페이스 (신규 오더 발신) — **필수**
- **요청**: LIS가 Reflex로 생성한 **add-on 검사를 HIS에 신규 오더로 발신**할 인터페이스.
  - 방식(택1): **HL7 ORM^O01(신규 오더)** 또는 **FHIR ServiceRequest(POST)**. LIS→HIS 방향의 신규 오더 수용 엔드포인트.
  - 필드: 환자ID, 원 오더/방문 연계(placer group), 추가 검사코드(LOINC 매핑), **오더 사유="Reflex: {protocolName}"**, standing order 근거(protocolId·의결번호).
  - **ACK/수용 회신**: HIS가 오더번호를 채번해 회신(청구·EMR 반영 여부 포함).
- **확인 필요**: HIS가 외부(LIS) 발신 오더를 **수용·청구·의무기록 반영**하는지, 아니면 표시만 하는지(정책).

### 7-B. Reflex 프로토콜 승인 거버넌스 연계 — **협의**
- **요청**: 프로토콜의 **위원회 의결·전문의 승인 상태**를 HIS(또는 병원 거버넌스 시스템)와 동기화할지.
  - 옵션1: **LIS 주관** — LIS가 승인 워크플로를 관리하고, HIS엔 "등록된 standing order 목록"을 통보(참조용).
  - 옵션2: **HIS 주관** — 병원 처방집/위원회 시스템이 승인 원본이고, LIS가 그 승인 상태를 조회·반영.
  - **권장**: 옵션1(LIS 관리) + HIS에 등록 통보. HIS가 처방집 등재를 요구하면 등록 ID(`hisRef`)를 받아 ACTIVE 전환.

### 7-C. 청구·수가 정책 — **확인**
- Reflex add-on 검사의 **수가 청구 주체·코드**(HIS 청구). standing order 기반 자동추가의 청구 적정성(사전승인 근거 첨부).

### 7-D. 코드 매핑 — **필수**
- add-on 검사코드의 **LIS↔HIS↔LOINC 매핑**(마스터 코드매핑 재사용). 미매핑 시 발신 보류.

> **문서 산출물**: 위 항목을 `docs/handoff/HIS_Reflex_양방향오더_요청서.md`로 정리해 HIS에 발신.

---

## 8. 양방향 오더 설계

**현행**: `applyReflex`가 LIS 내부 `orderItem`만 추가 → HIS는 이 추가를 **모름**(청구·EMR 미반영). 단방향.

**양방향(목표)**:
1. Reflex 엔진이 add-on `orderItem` 생성(LIS 내부).
2. **HIS로 신규 오더 발신**(ORM^O01 / FHIR ServiceRequest) — 사유·standing order 근거 포함.
3. HIS **ACK/수용**(오더번호 회신) → LIS가 연계 상태 기록(발신/수용/실패).
4. 실패 시 재발신 큐(기존 HIS 발신 스테이징 재사용).

- 발신은 **HIS 연계 설정(자격증명) 존재 시에만** 실제 전송, 미설정 시 "발신 대기"로 스테이징(현행 HIS 발신 패턴과 동일).
- add-on 오더에 **부모 오더/검체 연계**(reflex origin) 표기 → 추적성.

---

## 9. 권한 · 감사

| 액션 | 역할 |
|------|------|
| 규칙 초안 작성·수정 | TEC/PHY/ADM |
| 전문의 승인/반려 | PHY(검증의/전문의) |
| 위원회 의결 기록 | ADM |
| HIS 등록·수용 확인·중지·폐기 | ADM |
| 규칙 조회 | TEC/PHY/MIC/ADM/AUD |
| 엔진 자동실행 | 시스템(ACTIVE만) |

- 전 전이·자동추가 실행을 **감사로그**(민감도 일반, 대상=protocolId) 기록.

---

## 10. 구현 단계 (Phase)

| 단계 | 내용 | 비고 |
|------|------|------|
| **RX-P1** | 스키마(ReflexProtocol·Event) + **엔진 전환**(하드코딩 → DB, ACTIVE만 실행) + 기존 규칙 승인 시드 이관 | 안전 핵심: 미승인 미실행 |
| **RX-P2** | **승인 워크플로 API**(제출·전문의·위원회·HIS·중지) + **에디터 UI**(/admin/reflex) | 거버넌스 |
| **RX-P3** | **양방향 오더**(HIS 신규 오더 발신·ACK) + HIS 요청서 발신 | 상대측 의존 |

- **RX-P1 착수 시 안전장치**: 엔진을 DB 기반으로 바꾸되, 시드로 이관한 기존 규칙(GLU→HbA1c)을 **ACTIVE(사전승인 가정, 의결번호 시드)** 로 등록해 현행 동작 무손실 유지. 이후 미승인 신규 규칙은 실행되지 않음.

---

## 11. 이행(Migration) · 리스크

- 하드코딩 `REFLEX_RULES`(GLU≥200→HbA1c)를 **승인된 시드 ReflexProtocol**로 이관(의결번호=시드 표기, 실운영 전 병원 위원회 실제 의결로 대체).
- `reflexFor`/`applyReflex`를 DB 조회 기반으로 교체하되 반환 형태 유지(호출측 `result.service` 무변경 최소화).
- **리스크**: DB 규칙 오설정으로 부적절 자동추가 → 승인 게이트(ACTIVE만) + 유효기간 + 감사 + 미리보기로 완화. HIS 양방향 미비 시 청구 누락 → 발신 스테이징·실패 큐로 추적.

---

## 12. 결론 · 권고

현행 하드코딩 리플렉스를 **거버넌스 기반 엔진**으로 전환한다. 핵심은 *"의사(전문의)와 위원회가 승인한 standing order만 자동 실행"* 이며, Reflex add-on은 **양방향 오더로 HIS에 신규 오더 발신**해 청구·EMR 정합을 확보한다.

**권고 착수 순서**: RX-P1(스키마+엔진, 승인분만 실행·기존 규칙 무손실 이관) → RX-P2(에디터+승인 워크플로) → RX-P3(HIS 양방향 + 요청서). HIS 협의 항목(§7)은 RX-P3 착수 전 발신·확정한다.
