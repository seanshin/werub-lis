# LIS(검사정보시스템) — v1.53.2

> **HIS·PACS 연계 및 유전체(NGS) 검사 통합 검사정보시스템(Laboratory Information System)**
> 제작사 **위루비 (Weruby)** · 개발 **신현묵 <8508132+seanshin@users.noreply.github.com>** · 파일럿 https://lis.example.org · © 2026 위루비

중소 종합병원을 대상으로, 기존 HIS·PACS와 연계되고 **진단검사의학·미생물·병리·수혈·유전체** 5개 분야를 통합하는 LIS입니다.

**현재 단계: 개발단계 마무리 중** — 파일럿(합성 데이터)으로 전 기능 동작 검증 완료. 실 환자 데이터는 아직 없습니다.
개발/운영 단계 경계와 개시 이후 운영은 **[실서비스 운영단계 정의서](./docs/실서비스_운영단계_정의서.md)** 가 정본입니다.

---

## 📊 현황 한눈에

| 항목 | 값 |
|---|---|
| 릴리즈 | **v1.53.2** (2026-07-29) · 이력 [CHANGELOG.md](./CHANGELOG.md) |
| 화면 | **40** (CI가 도달성 전수 검사) |
| API 라우트 | **336** · 컨트롤러 31 |
| 데이터 모델 | **79 테이블** · 마이그레이션 67 |
| 테스트 | **E2E 442** (서버 lis_test 클린 초기화) · **단위 517**(스펙 57파일, 도메인 순수함수 41) |
| CI 게이트 | **11개** — build · lint · type-check · compose env · nav 도달성 · 마이그레이션 커버리지 · env 소싱금지 · 정리분류 · 색 대비 · **색 토큰 사용** · 환자 병합 커버리지 |
| 개발 잔여 | **0** (기능 백로그·이월 전량 종결) |
| 개시 차단 | **1건** — `CRITICAL_WEBHOOK_URL` 실값(코드 아님) |

---

## 🗂️ 문서 지도

문서는 세 층입니다. **아래로 갈수록 최신이고, 상충하면 아래가 우선**합니다.

```
[기획·설계]  01~27 · LIS_기획서       ← 착수 시점 판단. 각 문서에 「구현 반영(As-Built)」 절로 현재 상태 병기
     ▼
[운영·연계]  docs/                    ← 실무 정본(연계 규격·체크리스트·런북·보안)
     ▼
[코드]       apps/ · infra/           ← 최종 정본. 문서와 다르면 코드가 맞다
```

### 1층 — 기획·설계 (루트 `01_`~`27_`)

착수 시점의 판단을 **이력으로 보존**합니다. 구현이 원안과 갈린 문서에는 상단에 **📌 구현 반영(As-Built)** 절을 두어 *무엇이 왜 바뀌었는지* 적었습니다.

| # | 문서 | 내용 | As-Built |
|---|------|------|:---:|
| ★ | **[LIS 기획서](./LIS_기획서.md)** | 배경·목적·범위·기능·연계·아키텍처·추진계획·비용·리스크 | |
| 00 | [산출물 목록·배포 표지](./00_산출물목록_배포표지.md) | 문서 관리표·체계도·읽는 순서 | |
| 01 | [연계 인터페이스 규격서](./01_연계_인터페이스_규격서.md) | HIS·PACS·장비 연계 IF 정의 | ✅ **HIS가 FHIR 전용으로 확정** |
| 02 | [검사항목 LOINC 코드매핑표](./02_검사항목_LOINC_코드매핑표.md) | 검사항목↔HIS↔LOINC↔EDI 매핑 | ✅ 손 관리 표 → 반입·검증 기능 |
| 03 | [화면 정의서](./03_화면정의서.md) | 와이어프레임·화면 구조 | ✅ 12 → **40화면** |
| 04 | [분야 심화 — 수혈·병리](./04_분야심화_수혈_병리.md) | 수혈 안전관리, 병리 디지털화 | ✅ 안전 방벽·표본추적 |
| 05 | [유전체 검사 연동·결과관리](./05_유전체검사_연동_결과관리.md) | NGS 동의·수탁·변이 큐레이션 | ✅ 3워크플로 분리·SF 누출차단 |
| 06 | [상세설계(1) 데이터 모델](./06_상세설계_데이터모델.md) | 엔터티·상태전이·채번·보존기간 | ✅ 30 → **79테이블** |
| 07 | [상세설계(2) 기능 상세](./07_상세설계_기능상세.md) | 모듈별 처리로직·예외 흐름 | ✅ 임상 검토로 바뀐 판정 |
| 08 | [상세설계(3) 권한 매트릭스](./08_상세설계_권한매트릭스.md) | 기능×역할 RBAC | ✅ 기능코드 11 → **14** |
| 09 | [상세설계(4) 연계 상세](./09_상세설계_연계상세.md) | 필드 매핑·오류 재처리·모니터링 | ✅ 멱등 3중·유실방지 큐 2종 |
| 10 | [상세설계(5) 인프라·배포](./10_상세설계_인프라_배포아키텍처.md) | 서버·백업/DR·네트워크·배포 | ✅ 온프레미스 → **AWS 서울** |
| 11 | [설계 정합성 검토·RTM](./11_설계정합성검토_요구사항추적표.md) | 요구→기능→권한→연계 추적성 | ✅ 정적 표 → **실행 게이트** |
| 15 | [시드 데이터 가이드](./15_개발지원_시드데이터.md) | 초기 DDL·시드 | |
| 16 | [개발 착수 — 구현 현황](./16_개발착수_구현현황.md) | 백엔드 골격·핵심 API | |
| 22 | [현행기능 충실성 검토](./22_현행기능_충실성검토_및_보완기획서.md) | 기능 갭 분석·보완 기획 | |
| 23 | [종합검토 보완내역](./23_종합검토_보완내역.md) | 전역 ID 충돌 등 보완 | |
| 25 | [UI/UX 충실성 검토](./25_UIUX_충실성검토_및_보완기획서.md) | 화면 진단·UX 품질 감사 | |
| 26 | [실사용 UX 심층검토](./26_실사용UX_심층검토_및_기능보완_기획서.md) | 실사용 관점 보완(P1~P3) | |
| 27 | [Reflex 거버넌스 엔진 기획서](./27_Reflex_프로토콜_거버넌스_엔진_기획서.md) | 반사검사 승인 프로토콜 | |

> ⚠ **전달 패키지 `LIS_통합본_전체.pdf`·`LIS_문서패키지_v2.0.zip`은 2026-07-12(v2.0) 스냅샷**입니다.
> 이후 ~50개 릴리즈를 반영하지 않았으므로 **현재 상태 확인에는 쓰지 마십시오.** 최신은 이 저장소의 개별 문서입니다.

### 2층 — 운영·연계 정본 (`docs/`)


| 목적 | 문서 |
|---|---|
| **연계 규격 정본** | [docs/연동_규격서(ICD).md](./docs/연동_규격서%28ICD%29.md) — FHIR 전용·폴링 확정 |
| **개시 전 체크리스트** | [docs/개시전_체크리스트.md](./docs/개시전_체크리스트.md) — A~H |
| **개시 이후 운영** | [docs/실서비스_운영단계_정의서.md](./docs/실서비스_운영단계_정의서.md) — 단계 경계·무인 크론·주기 점검·인시던트 |
| 백업·복구 | [백업복구 운영절차서](./docs/백업복구_운영절차서.md) |

### 3층 — 코드

| 경로 | 내용 |
|---|---|
| `apps/api` | NestJS + Prisma 백엔드. `src/domain/`은 **부작용 없는 판정 로직**(단위 테스트 41파일) |
| `apps/web` | Next.js 15 프론트엔드 |
| `packages/shared` | 공유 계약 — **`src/index.ts` 단일 진입** |
| `infra/docker` | compose·Dockerfile·nginx |
| `infra/scripts` | CI 게이트·배포·E2E·백업·복구 리허설·스모크 |

---

## ⚡ 개발 빠른 시작

### 요구 사항

| | 버전 | 비고 |
|---|---|---|
| Node.js | **≥ 20** | monorepo(npm workspaces + turbo) |
| Docker | 임의 | 로컬 Postgres·Redis 기동용 |
| PostgreSQL | 16 | compose가 띄움 |

### 실행

```bash
npm install

# 로컬 인프라 — Postgres 5433 / Redis 6380 (HIS 5432·OpenPACS와 포트 충돌 회피)
npm run docker:up

# apps/api/.env 최소 구성
#   DATABASE_URL="postgresql://lis:CHANGE_ME@localhost:5433/lis?schema=public"
#   JWT_SECRET="CHANGE_ME"

npm run db:migrate     # prisma migrate dev
npm run db:seed        # 마스터 + 데모 데이터

npm run dev            # api :4100 · web :3100 (turbo 병렬)
```

| 주소 | 내용 |
|---|---|
| http://localhost:3100 | 웹 |
| http://localhost:4100/api/v1 | API |
| http://localhost:4100/api/docs | **Swagger** — 개발에선 자동 노출, 운영은 `ENABLE_SWAGGER=true` 명시할 때만(API 표면 정보수집 방지) |

**파일럿 로그인:** 데모 계정 `U00`~`U08` / `SEED_PASSWORD` 로 정한 값. 로그인 화면의 계정 패널은 `NEXT_PUBLIC_DEMO=1`일 때만 뜨며 **파일럿 전용**입니다 — 개시일에 끄고 web을 재빌드합니다(체크리스트 A).

### 테스트

```bash
npm run test                                   # 단위 517 (vitest, DB 불필요)
npm run lint && npx tsc --noEmit -p apps/api/tsconfig.json

bash infra/scripts/ci.sh                       # 전 CI 게이트 (push 전 필수)
```

**⚠ E2E는 로컬에서 돌지 않습니다.** 개발기에 Postgres가 없다는 전제로, 서버의 **별도 `lis_test` DB**에서 실행합니다(운영 `lis` DB 절대 미접근 — 스크립트가 `DATABASE_URL`을 고정). `db push --force-reset`으로 매번 클린 초기화합니다.

```bash
# 서버 ~/his-backup/weruby/lis 에서   (2026-09-09 이관 후 경로)
./infra/scripts/e2e-server.sh                  # E2E 442
```

`deploy.sh --build`가 이 게이트를 **프리플라이트로 강제**하므로, 실패하면 배포가 중단됩니다.

### 환경변수

값은 서버 `infra/docker/.env`에만 있고 **커밋하지 않습니다**(`.env.production.example` 참고).
CI 게이트가 대조하는 **직접 참조 키는 39개**이며, 그 밖에 설정 카탈로그를 거치는 키(`LIFECYCLE_PURGE`·`OPS_*`·`RETENTION_DAYS_*` 등)가 더 있습니다 — 정본은 `apps/api/src/modules/settings/settings.catalog.ts`.

| 군 | 키 | 비고 |
|---|---|---|
| 필수 | `DATABASE_URL` `JWT_SECRET`(≥32자) | 미설정 시 **기동 거부** |
| 기동 | `PORT`(4100) `NODE_ENV` `TZ` `CORS_ORIGIN` `TRUST_PROXY_HOPS` `JWT_EXPIRES` | 프록시 홉 미설정 시 레이트리밋이 전 병원 공용 버킷이 됨 |
| HIS | `HIS_FHIR_BASE` `HIS_FHIR_TOKEN_URL` `HIS_CLIENT_ID/SECRET` `HIS_FHIR_SCOPES` `HIS_INTEGRATION_BASE/KEY` `HIS_HTTP_TIMEOUT_MS` | 미설정 시 "미구성"으로 **fail-safe**(수기 폴백) |
| 크론 스위치 | `HIS_ORDER_POLL` `HIS_REFLEX_POLL` `HIS_REFLEX_RETRY` `OPS_MONITOR` `BILLING_SWEEP` `LIFECYCLE_PURGE` | **꺼지면 무슨 일이 나는지는** [운영단계 정의서 §4](./docs/실서비스_운영단계_정의서.md) |
| PACS | `PACS_BASE` `PACS_USER/PASS` `PACS_MLLP_HOST/PORT` | |
| 통보 | `CRITICAL_WEBHOOK_URL/SECRET` `CRITICAL_RETRY` `OPS_WEBHOOK_URL` | 🔴 `CRITICAL_WEBHOOK_URL`이 **유일한 개시 차단** |
| 청구 | `ERP_BILLING_URL/SECRET` | HMAC 서명. 시크릿 없으면 미서명 전송 대신 PENDING 유지 |
| 운영 | `LIS_BACKUP_OFFSITE` `ENABLE_SWAGGER` `THROTTLER_DISABLED` `OPS_*_THRESHOLD` | |

**⚠ 새 env를 추가하면 반드시 compose `environment:`에도 넣으십시오.** `.env`에만 넣으면 컨테이너에 전달되지 않아 기능이 영구 "미구성"으로 남습니다 — **실제로 2회 재발**(`CRITICAL_WEBHOOK_URL`·`HIS_INTEGRATION_KEY`)해서 CI 게이트(`check-compose-env.sh`)로 차단합니다.

일부 운영값(위험치 채널·상향 간격·보존기간 등)은 **재기동 없이 `/admin/settings`** 에서 바꿉니다 — 우선순위 `DB > env > 기본값`, 허용목록 밖 키는 차단(`JWT_SECRET` 통로 방지), 값 마스킹·감사기록.

### 브랜치·원격

| | |
|---|---|
| 브랜치 | **`main` 단일** (트렁크 기반) |
| 원격 | `github`(코드 호스팅) · `srv`(배포 서버 bare) — **양쪽에 push** |
| 배포 | 서버가 `srv`에서 `git reset --hard origin/main` 후 `deploy.sh --build` |

> 🔄 **`srv` 원격 주소가 바뀌었습니다(2026-09-09 서버 이관).**
> `ssh://deploy@203.0.113.10:22/home/deploy/lis.git` — bare 복구·원격 재지정 **완료**(v1.56.14 push 확인).
> ⚠ post-receive 훅이 없어 **push만으로는 서버 워크트리가 갱신되지 않습니다** — 배포는 서버에서 별도 수행.

---

## 🧱 저장소 구조 · 기술 스택

```
LIS/
├── apps/
│   ├── api/                    NestJS 11 + Prisma 6 + PostgreSQL 16
│   │   ├── prisma/
│   │   │   ├── schema.prisma       ★ 데이터 정본 (79 모델)
│   │   │   ├── migrations/         67개 — 기동 시 migrate deploy 자동 적용
│   │   │   └── seed*.ts            마스터·데모·디테일 시드
│   │   ├── src/
│   │   │   ├── domain/         ★ 부작용 없는 판정 로직 (스펙 41파일)
│   │   │   │                     결과평가·수혈적격·AST/MDRO·유전체 SF·보존정책 …
│   │   │   ├── modules/            27개 도메인 모듈 (컨트롤러 31 · 라우트 336)
│   │   │   ├── integration/        HIS FHIR·HL7·PACS·장비·카탈로그
│   │   │   ├── common/
│   │   │   │   ├── rbac/roles.ts   ★ 권한 정본 (PERMISSION_MATRIX)
│   │   │   │   ├── guards/         JWT·역할·권한
│   │   │   │   └── interceptors/   감사(AuditInterceptor)
│   │   │   └── infrastructure/     Prisma 서비스
│   │   └── test/app.e2e-spec.ts    E2E 442
│   └── web/                    Next.js 15 (App Router) + React 19 + Tailwind
│       └── src/
│           ├── app/                40 화면 (page.tsx)
│           ├── components/
│           │   ├── Sidebar.tsx  ★ 내비게이션 정본 — GROUPS 하나뿐
│           │   └── Explain.tsx     용어·상태 설명 팝오버
│           └── lib/
│               ├── api.ts       ★ HTTP 정본 (apiFetch) — react-query 미사용
│               └── version.ts      APP_VERSION 상수 (표기용, 한 곳만 갱신)
├── packages/shared/            공유 계약 — src/index.ts 단일 진입
├── infra/
│   ├── docker/                 compose(dev·prod) · Dockerfile · nginx
│   └── scripts/                ci.sh · e2e-server.sh · deploy.sh · backup.sh
│                               restore-rehearsal.sh · check-*.sh(게이트) · 스모크
├── docs/                       운영·연계 정본
└── 01_ ~ 27_ · LIS_기획서      기획·설계 (각 문서에 As-Built 절)
```

### ★ 정본이 하나여야 하는 것들

같은 사실이 두 곳에 있으면 반드시 갈라집니다. 아래는 **단일 정본**이며, 복제하지 마십시오.

| 대상 | 정본 |
|---|---|
| 데이터 스키마 | `apps/api/prisma/schema.prisma` |
| 권한 매트릭스 | `apps/api/src/common/rbac/roles.ts` |
| 사이드바·내비게이션 | `apps/web/src/components/Sidebar.tsx`의 `GROUPS` |
| HTTP 호출 | `apps/web/src/lib/api.ts`의 `apiFetch` |
| 공유 타입 | `packages/shared/src/index.ts` |
| 수혈 출고 판정 | `evaluateIssueEligibility` |
| UI 버전 표기 | `apps/web/src/lib/version.ts` |

---

## 🏗️ 아키텍처

```
   ┌────────────┐   FHIR ServiceRequest 폴링(증분)   ┌──────────────┐
   │            │ ◀───────────────────────────────── │              │
   │    HIS     │                                     │              │
   │            │ ─── FHIR DiagnosticReport 발신 ───▶ │              │
   └────────────┘   (basedOn 원오더 결속)             │              │
                                                      │     LIS      │
   ┌────────────┐   ORM^O01 MWL(MLLP) ──────────────▶ │              │
   │   PACS     │                                     │   40화면     │
   │            │ ◀── QIDO-RS 스터디 조회·뷰어 런처 ── │   336 API    │
   └────────────┘                                     │   79 테이블   │
                                                      │              │
   ┌────────────┐   ASTM / CSV 파서 ────────────────▶ │              │
   │  검사장비   │                                     │              │
   └────────────┘                                     │              │
                                                      │              │
   ┌────────────┐   HMAC 청구 송신 ◀───────────────── │              │
   │    ERP     │                                     └──────────────┘
   └────────────┘
```

**⚠ HIS 채널은 FHIR 전용입니다.** 원안의 HL7 v2 MLLP(ADT/OML/ORU)는 HIS 구간에서 채택되지 않았습니다(2026-07-17 확정). PACS MLLP는 유지됩니다. HL7 인바운드 코드는 다운타임·대체 경로로 살아 있습니다.

### 연계 표준 (실제)

| 대상 | 표준 |
|------|------|
| HIS | **FHIR**(ServiceRequest 폴링 · DiagnosticReport 발신). ADT 미채택 |
| PACS | DICOM · MWL(ORM^O01 MLLP) · QIDO-RS |
| 검사장비 | ASTM E1394 / CLSI LIS2-A2 · CSV |
| 코드체계 | LOINC · SNOMED CT · ISBT 128 · HGVS/VCF · HIRA EDI |
| 유전체 분류 | ACMG/AMP · AMP/ASCO/CAP · CPIC |
| 미생물 | CLSI/EUCAST 브레이크포인트(버전 관리형 반입) |

---

## 🧬 기능 맵

| 분야 | 전주기 |
|---|---|
| **진단검사** | 처방 폴링 → 접수·라벨 → 검체(분주·거부·재채취) → 결과(장비 자동 + 수기 이원화) → 자동검증·델타체크 → 2차검증 → 위험치 폐루프 → 보고·HIS 회신 → 청구 캡처 |
| **미생물** | 배양 등록 → 그람 예비보고 → 동정 → 감수성(AST·전문가 규칙) → MDRO 판정·격리 → 법정감염병 신고(서류·신고번호 강제) → 누적 antibiogram |
| **병리** | 접수 → 그로싱 → 블록 → 슬라이드(H&E·특수·IHC) → 동결절편 read-back → 판독 → CAP synoptic → 2단계 사인아웃 → 개정·추가보고 → PACS 이미지 |
| **수혈** | 혈액형·항체 → 입고·유효기간 → 교차시험(혈청학적 자동판정) → **ABO 독립 방벽** → 출고 → 시행(2인) → 부작용 조사·종결 |
| **유전체** | 동의 → 수탁/시퀀싱 → VCF·수기 변이 → ACMG 큐레이션 → 해석 확정 → **SF 동의 게이트** → 보고서 서명·배포 → 재분류·재접촉 |
| **분자진단** | assay 카탈로그(Ct 컷오프·보류구간) → 검출 워크리스트 → 법정감염병 폐루프 |
| **NGS** | run QC(Q30·coverage·uniformity) → 패널별 임계 → 체세포 소견 → 병리 결속 |
| **품질** | QC(Westgard·Levey-Jennings) · EQA(SDI) · 장비 로스터 · 통계(TAT·재검률) |
| **거버넌스** | Reflex 승인 프로토콜(4-eyes) · 조직 결재 게이트 · 검사실/법무 서명 기록 · 조직 결정 등록 · **개시 승인(Go-Live)** |
| **운영** | 연계 감시 7지표 · DLQ·재적재 · 다운타임 오더 · 외부위탁 · 청구(ERP) · 감사추적 · 수명주기 |

---

## 🛡️ 임상 안전 불변식 (회귀 금지)

각각 실제 위험에서 도출됐습니다. **리팩터링 대상이 아닙니다.**

| 불변식 | 없으면 |
|---|---|
| ABO 독립 방벽(판정 정본 1개, 복제 금지) | 부적합 혈액 출고 |
| 교차시험 최신 판정 = `testedDt` 시간순 | 같은 날 재검 시 구 '적합'을 읽음 |
| 균명 축약 속명 정규화 | CRE/MDRO 누락 → 격리·법정신고 미발 |
| 유전자 심볼 정규화 후 SF 판정 | **무동의 이차소견 누출** |
| 미동의 시 SF 건수조차 비공개 | 개수만으로 존재 누설 |
| 위험치 경계 `null` → 자동확정 차단 | 참고치 미설정 검사가 조용히 확정 |
| 단위 불일치 → 자동확정 차단 | 단위 착오가 수치 오판으로 |
| 자가검증 차단(입력자 ≠ 검증자) | 자기 오류를 스스로 덮음 |
| 정정 권한 비대칭(입력 `F-RES:W` / 정정 `F-V2:S`) | 상동 |
| 서명 주체 서버 결속(body 미수용) | 책임 소재 위조 |

---

## 🔌 API 규약

| 항목 | 규약 |
|---|---|
| 프리픽스 | `/api/v1/...` |
| 응답 봉투 | **`{ "data": ... }`** 로 감싼다. 목록 페이지네이션은 `{ data, meta }` |
| 인증 | `POST /api/v1/auth/login {userId, password}` → `accessToken` → `Authorization: Bearer <token>` |
| 역할 | 토큰이 아니라 **`GET /auth/me`(DB 권위)** 로 조회. 토큰 staleness로 "작업 중 메뉴 사라짐"이 났던 것을 근본 수정 |
| 인가 | `@RequirePermission(Feature, Access)` — 기능×역할 매트릭스. 일부는 `@Roles(...)` |
| 추적 | 모든 응답에 **`x-request-id`**. 신뢰 형식 인바운드는 승계, 비신뢰는 재발급. 예외 로그에 결속 |
| 검증 | 전역 `ValidationPipe`(whitelist·transform). 잘못된 enum 쿼리는 500이 아니라 **400** |
| 본문 한도 | JSON **4MB**(코드셋 대량 반입용). 초과분은 도메인 가드가 행 수로 차단 |
| 감사 | 전역 `AuditInterceptor` — 변경·민감 조회 자동 기록. **해시체인 + DB UPDATE 차단 트리거** |
| 서명 주체 | 서명·재분류·승인은 `signer`/`classifier`를 **body로 받지 않는다**(서버가 JWT로 결정) |

```bash
# 예시
TOK=$(curl -s -X POST localhost:4100/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"userId":"U00","password":"SEED_PASSWORD 로 정한 값"}' | jq -r .accessToken)

curl -s localhost:4100/api/v1/integration/hl7/health/monitor \
  -H "authorization: Bearer $TOK" | jq .data
```

---

## ✅ 품질 게이트

```
개발 → ci.sh → push → e2e-server.sh(442) → deploy.sh --build → 배포 후 3중 확인
```

| 게이트 | 검사 |
|---|---|
| `ci.sh` | build(turbo) · lint · type-check · **compose env 배선** · **nav 도달성 40** · **마이그레이션 커버리지 79** · **env 소싱 금지** · **정리 분류 79** |
| `e2e-server.sh` | lis_test DB `--force-reset` 클린 초기화 후 E2E 442. **`deploy.sh --build`의 프리플라이트로 강제** |
| 배포 | **항상 `--no-cache`** — 캐시가 무변경 이미지를 배포한 사고(v1.35.0) 이후 구조적 차단 |
| 배포 후 | ① 러닝 이미지 코드 버전 ② 마이그레이션 적용 로그·컬럼 실재 ③ 헬스. **헬스 OK만으로 성공 단정 금지** |

**로컬에 Postgres가 없어 E2E·Prisma는 서버 `lis_test` DB에서 실행합니다**(운영 `lis` DB 절대 미접근 — 스크립트가 DATABASE_URL을 고정).

---

## 🕳️ 자주 밟는 함정

전부 **실제로 겪은 것**입니다. 같은 사고를 두 번 겪지 않기 위해 남깁니다.

| 함정 | 증상 | 대응 |
|---|---|---|
| **캐시 빌드 무변경 배포** | 소스를 고쳤는데 구 이미지가 뜬다. 마이그레이션 파일조차 이미지에 없어 컬럼 미생성. **E2E는 소스로 돌아 통과** | `deploy.sh --build`가 항상 `--no-cache`. 배포 후 러닝 이미지 코드 버전을 반드시 확인 |
| **마이그레이션 파일 누락** | E2E 통과하는데 운영에서 컬럼 없음 500 | e2e는 `db push`(스키마 직생성), prod는 `migrate deploy`(파일 필요). 스키마 변경 시 `git status`로 마이그레이션 커밋 확인 |
| **compose env 미배선** | `.env`에 넣었는데 컨테이너에 전달 안 됨 → 어댑터가 영구 "미구성" | `check-compose-env.sh` CI 게이트. **2회 재발**한 유형 |
| **`.env` 셸 소싱** | 값에 공백이 들어오자 배포가 시작조차 못 함 | docker `--env-file`은 문자 그대로, 셸 소싱만 값을 해석. 스크립트는 `sed`로 키만 추출. CI가 차단 |
| **공유 호스트 compose 충돌** | `--remove-orphans`가 **HIS postgres를 제거**(3~4분 다운) | `COMPOSE_PROJECT_NAME=lis` 고정. 항상 `-p lis`, 전역 `down` 금지 |
| **`pg_advisory_xact_lock` 500** | 계보 락에서 역직렬화 실패 | void 반환이라 `$queryRaw` 불가 → **`$executeRaw`** |
| **라우트만 만들고 메뉴 미등록** | 화면에 도달할 방법이 없음 | 사이드바 정본은 `Sidebar.tsx`의 `GROUPS` 하나. `check-nav-coverage.sh`가 차단 |
| **렌더 vs select 불일치** | 열은 있는데 항상 공백(실버그 3건 발생) | 화면이 쓰는 필드가 쿼리 `select`에 있는지 확인 |
| **정적 라우트 대조의 오탐** | "미연결"로 보이는데 실제론 동적 경로 헬퍼 사용 | 정적 대조는 동적 경로를 못 읽는다. **반드시 소스 확인 후 판단** |
| **판독의 사이드바가 빔** | 버그로 오인 | PAT·GEN은 **의도적 최소 그랜트**. 화면을 열려면 전용 기능코드 분리 + 사이드바·API 매트릭스 동시 갱신 |
| **개발 중 연계 감시 red** | 정상 | 임계가 전부 0이라 파일럿 유물까지 센다. 개시 전환 단계 6에서 정리 |

---

## 🧩 새로 추가할 때 체크리스트

게이트가 많은 이유는 **같은 누락이 반복됐기 때문**입니다. 아래를 빼먹으면 CI가 막거나, 더 나쁘게는 조용히 동작하지 않습니다.

<details>
<summary><b>화면을 추가한다</b></summary>

1. `apps/web/src/app/<경로>/page.tsx`
2. **`components/Sidebar.tsx`의 `GROUPS`에 등록** — 안 하면 도달할 방법이 없고 `check-nav-coverage.sh`가 막는다
3. 노출 역할(`roles`)을 정하고, **그 역할이 화면이 호출하는 API 권한을 실제로 갖는지** 확인 — 사이드바만 열면 전부 403인 죽은 화면이 된다
4. 쓰기 액션은 역할로 게이팅(권한 없는 사용자에게 버튼을 보이지 말 것)
5. 첫 로딩·빈 상태 구분(`Loading`/`EmptyState`)
</details>

<details>
<summary><b>엔드포인트를 추가한다</b></summary>

1. `@RequirePermission(Feature, Access)` — 매트릭스에 없는 조합이면 `roles.ts`부터 갱신
2. 응답은 `{ data: ... }` 봉투
3. 서명·승인·검증 주체는 **body가 아니라 `@CurrentUser()`** 로
4. 화면이 렌더하는 필드가 Prisma `select`에 **전부 있는지** — 없으면 항상 공백(실버그 3건 발생)
5. E2E 추가. 임상 방어라면 **회귀 테스트 필수**
</details>

<details>
<summary><b>테이블·컬럼을 추가한다</b></summary>

1. `schema.prisma` 수정 → `npx prisma migrate dev --name <이름>`
2. **마이그레이션 파일을 반드시 커밋** — e2e는 `db push`라 누락돼도 통과하지만 운영은 `migrate deploy`라 컬럼이 안 생긴다
3. 새 컬럼은 **nullable/default**(데이터 있는 테이블에 NOT NULL은 배포 시 크래시)
4. `check-migration-coverage.sh`·`check-cleanup-coverage.sh` 통과 — 새 테이블은 **트랜잭션/마스터로 분류**돼야 한다(파일럿 정리 대상 여부)
</details>

<details>
<summary><b>환경변수를 추가한다</b></summary>

1. compose `environment:` 에 등재(**`check-compose-env.sh`가 강제**)
2. 미설정 시 동작을 정한다 — **fail-safe(기능 off)인가, 기동 거부인가**. 조용히 오동작하는 선택지는 두지 말 것
3. 운영 중 바꿔야 하는 값이면 `/admin/settings` 허용목록에 추가
</details>

<details>
<summary><b>임상 판정 로직을 건드린다</b></summary>

1. 로직은 `src/domain/`에 **부작용 없는 함수**로. 서비스에서 직접 계산하지 말 것
2. 단위 테스트 필수 — 경계값(`null`·0·부등호·단위 불일치)을 반드시 포함
3. **임상 안전 불변식에 해당하면 변경 금지.** 바꿔야 한다면 근거를 CHANGELOG에 남긴다
4. 판정 정본을 **복제하지 말 것**(복제본은 갈라지고 한쪽만 고쳐진다)
</details>

**공통 마무리:** `bash infra/scripts/ci.sh` → push(양쪽 원격) → 서버 E2E → 배포 시 러닝 이미지 버전 확인.

---

## 🔒 보안 · 개인정보

의료 데이터를 다루므로 아래는 **선택이 아닙니다.**

| 축 | 구현 |
|---|---|
| 열람 기록 | 전역 `AuditInterceptor` — 변경·**민감 조회**까지 기록. 환자별 열람 이력은 검체 경유 접근도 포착 |
| 감사 무결성 | **해시체인** + `audit_log` UPDATE 차단 **DB 트리거**(앱 버그로도 못 바꿈) |
| 접속기록 보존 | 감사 1,095일(3년) — 개인정보보호법 시행령 §30 민감·고유식별정보 2년 이상에 여유. **법정 하한은 설정 저장 시점에 강제** |
| 인증 | JWT · 계정 잠금 · 비밀번호 정책 · **신규/재설정 계정은 비번 변경 전까지 업무 API 403** |
| 인가 | 기능×역할 매트릭스 · 직무분리(자가검증 차단·정정 권한 분리·4-eyes) · 최후 관리자 보호 |
| 유전정보 | **특수 통제** — 최소권한(GEN/GC/PHY), 별도 감사, 이차소견 동의 게이트, **미동의 시 건수조차 비공개** |
| 전송 | HIS·PACS·ERP 전 구간 HMAC 서명 또는 토큰. 실서비스는 **Site-to-Site VPN**(PACS MLLP 평문) |
| 표면 축소 | 운영에서 Swagger 차단 · 레이트리밋(식별자 기반) · helmet · CORS 화이트리스트 |
| 시크릿 | 저장소에 **평문 시크릿 없음**. 서버 `.env`(gitignore)와 운영자 자가 회수 경로만 |

**문서 등급: 대외비** — 이 저장소의 문서·시드는 합성 데이터이나, 운영 데이터는 개인정보·유전정보를 포함합니다.

---

## 🚦 개시 준비 상태

| 구분 | 상태 |
|---|---|
| 코드·기능 | ✅ 잔여 0. 전 표면(관리·임상·유전체) 적대적 검토 종결 |
| HIS 연동 | ✅ **상호 종결**(2026-07-24). 카탈로그 53,891건 반입·유실 0, enforce 교차검증 4케이스 양측 일치 |
| PACS 연동 | ✅ 코드 준비. 🟡 컷오버 창 일정·실 PID 대기 |
| ERP 청구 | ✅ 실 종단 개통(2026-07-24) |
| 개시 차단 | 🔴 `CRITICAL_WEBHOOK_URL` 실값 **1건** |
| 권고 | 🟡 `OPS_WEBHOOK_URL` · `LIS_BACKUP_OFFSITE` 미설정 |
| 마스터 | 🟡 dev seed 대표값 — 검사실 서명 후 실값 교체 |
| 조직 결정 | ⬜ §H H1·H2·H5(blocking) — 콘솔 결정 등록에서 추적 |
| 실서비스 인프라 | ⬜ AWS 서울 미구축(H6~H10) — 위 결정 후 착수 |

**⚠ 개발 중 연계 감시가 빨간 것은 정상입니다.** 임계가 전부 0이라 파일럿 유물까지 정직하게 셉니다. 목표는 지금 초록으로 만드는 게 아니라 **개시 직후 0에서 출발하는 것**입니다. 상세와 "지금 하지 않는 것" 목록은 [운영단계 정의서 §2·§10](./docs/실서비스_운영단계_정의서.md).

---

## 📖 읽는 순서

| 독자 | 순서 |
|---|---|
| **처음 오는 사람** | README → LIS 기획서 → 관심 분야 설계문서의 **As-Built 절** |
| **연계 담당** | [docs/연동_규격서(ICD).md](./docs/연동_규격서%28ICD%29.md) → 01 As-Built → 09 As-Built → docs/handoff/ |
| **신규 개발자** | 본 README의 **개발 빠른 시작** → **저장소 구조**(★정본 목록) → **API 규약** → **자주 밟는 함정** |
| **기능 파악(개발)** | 06 As-Built(데이터) → 07 As-Built(로직) → 08 As-Built(권한) → `apps/api/src/domain/` → 본 README **임상 안전 불변식** |

---

## 📋 릴리즈 이력 (요약)

상세는 **[CHANGELOG.md](./CHANGELOG.md)** — 각 릴리즈의 *왜*가 기록돼 있습니다.

| 버전 | 일자 | 내용 |
|---|---|---|
| **v1.56.18** | 2026-09-09 | **HSTS를 앱에서 복원** — 결손은 웹(Next) 응답뿐이었고 API는 helmet으로 살아 있었다. CF 존 전체 설정 대신 `lis.example.org`에만 적용. **이관 조치 A~E 전건 종결** |
| v1.56.17 | 2026-09-09 | 지표 차단 판정 범위 정정 — 컨테이너는 호스트 루프백을 볼 수 없어(게시 포트=도커 게이트웨이 출발지) 내부 수집까지 막히던 것 해소(`InternalOnlyGuard`) |
| v1.56.16 | 2026-09-09 | **E2E 게이트 자립** — 복구된 호스트에 `node_modules`가 없어 배포 직전 게이트가 죽던 것을 자동 `npm ci`로 해소(+컨테이너를 호출자 권한으로) |
| v1.56.15 | 2026-09-09 | **무인증 지표 엔드포인트를 앱이 직접 차단**(LoopbackOnlyGuard·404·`req.ip` 판정) — 프록시에만 있던 방어가 이관으로 사라진 사고의 근본 대응. 백업 크론 재등록 |
| v1.53.2 | 2026-07-29 | 정의되지 않은 색 토큰으로 **보이지 않던 버튼 4건** 수정(수혈 적합조회·판정, QC 사인오프·목표확립) + 색 토큰 사용 게이트 신설(CI 11개) |
| v1.53.1 | 2026-07-29 | HIS 병합 재귀속 판정을 실물·산출물 전체로 확대(블록·슬라이드·IHC 보유 케이스가 조용히 이관되던 결함) + 배포 워크트리 동기 게이트 |
| v1.53.0 | 2026-07-29 | 시각 언어 전면 개편("임상 정밀") + 알림 9→15종 · 연계 감시 7→10지표 |
| v1.52.0 | 2026-07-29 | 기능 점검 이월 5건 전량 종결(HL7 수신 실패 재적재·반송 재전송·다운타임 권한·유전자 심볼 보정) + 심평원 실 수가코드 무중단 교체 준비 |
| v1.51.0 | 2026-07-28 | §H 실서비스 개시 결정(H1~H5)을 결정 등록으로 분리 |
| v1.50.0 | 2026-07-28 | 전면 UI 데이터 배치 재점검 완결(4배치·~15화면·실버그 3건) + 플래키 게이트 제거 |
| v1.46~1.49 | 2026-07-28 | API가 반환하나 화면이 버리던 데이터 배치 |
| v1.39~1.45 | 2026-07-28 | 완료-액션 근거 강제(신고서류·조사서·원본 결과지) · 병리 그로싱/MWL 시드 · 로고 |
| v1.36~1.38 | 2026-07-28 | 기능 완결성 4도메인 점검 → HIGH·MEDIUM·LOW 배치 수정 |
| v1.34~1.35 | 2026-07-28 | **E2E 게이트 필수화**(배포 프리플라이트) · 캐시 무변경배포 차단 |
| v1.32~1.33 | 2026-07-27 | 분자 폐루프 · Reflex 프로토콜 계보(개정 승계) |
| v1.29~1.31 | 2026-07-27 | 조직·외부 **결정 등록** + **개시 승인(Go-Live) capstone** |
| v1.19~1.28 | 2026-07-27 | 임상 4도메인 + 유전체 3종 **적대적 검토 전량 종결** · 세션/사이드바 견고화 |
| v1.11~1.18 | 2026-07-25~27 | 관리 표면(콘솔+7화면) 적대적 검토·하드닝 |
| v1.7~1.10 | 2026-07-23~24 | 관리 기능화(운영 설정·서명 기록·표준 코드셋 반입기) · UI 미연결 전량 배선 |
| v1.4~1.6 | 2026-07-22~23 | 재검토 P1·P2 전량 처리 · UX 시스템 확립 · HIS S0 왕복 완결 |
| v1.2~1.3 | 2026-07-21 | 병리 완성 · 5도메인 재점검 스윕 · **보안 검토 전량 조치** · AWS 전환 설계 |
| **v1.1.0** | 2026-07-15 | 🏷️ 2차 릴리즈 — Reflex 양방향 오더 완성 + 안전기능 확장 |
| **v1.0.0** | 2026-07-14 | 🏷️ 정식 1차 릴리즈 — 위루비 표기, 전체 최종 검토 통과 |
| v4.x | 2026-07-12~14 | 설계 → 구현 → 배포 → HIS·PACS 5대 흐름 라이브 → P1~P3 기능 → UX 보완 → Reflex 거버넌스 |
| v1.0~v2.x | 2026-07-11~12 | 기획 → 상세설계(06~10) → 정합성 검토(11) → 구축 준비(12~14) |

---

## ⚖️ 라이선스

**MIT** — [LICENSE](./LICENSE). 이 저장소는 공개판입니다 — 무엇을 빼고 바꿨는지, 받은 뒤 직접 정할 값은 [PUBLIC-EDITION.md](./PUBLIC-EDITION.md)에 있습니다.

- **제3자 오픈소스 구성요소**(MIT 533 · Apache-2.0 37 · ISC 22 · BSD 22 · MPL-2.0 3 등)는 각자의 라이선스를 따릅니다.
- 저장소의 시드·예시 데이터는 전부 **합성 데이터**로 실 환자 정보를 포함하지 않습니다.
- 본 소프트웨어는 의료기기 인증을 받지 않았습니다. 진료에 쓰기 전 기관이 관할 규제와 의료기기 해당성을 확인하십시오.

---

*문의: 병원 의료정보팀 · 제작 위루비(Weruby)*
