# LIS — 공개판 안내

**LIS — about this public edition**

> **EN** — This repository is the public edition of LIS v1.56.18. Development continues in a private repository; this edition is its final state with internal working records (reports and replies exchanged with other systems, key-rotation runbooks, server measurements) and operational details removed, licensed under MIT. Operational domains, server addresses and accounts were replaced with example values, and **every password, secret, token and key was emptied to `CHANGE_ME`** — you must set your own before running anything. The table below lists each emptied setting and where it appears.

이 저장소는 **LIS v1.56.18 의 공개판**입니다. 개발은 비공개 저장소에서 계속하고, 공개판은 그 최종 상태에서 다음을 빼거나 바꾼 것입니다(MIT).

| 무엇 | 어떻게 |
|---|---|
| 내부 작업 기록 | 다른 시스템과 주고받은 결함 보고 · 회신, 키 교체 런북, 서버 실측 등 112개 문서를 뺐습니다. 소스 주석이 빠진 문서를 가리키는 곳이 남아 있을 수 있습니다 |
| 운영 정보 | 운영 도메인 · 서버 주소 · 서버 계정을 예시 값(`example.org` · 문서용 IP 대역 · `deploy`)으로 바꿨습니다 |
| 🔴 비밀값 | 비밀번호 · 비밀 · 토큰 · 키 **5곳**을 `CHANGE_ME` 로 비웠습니다. **실행 전에 아래 값을 직접 정하십시오** |

## 직접 설정할 값

| 설정 이름 | 있는 곳 |
|---|---|
| `CRITICAL_WEBHOOK_SECRET` | `infra/docker/.env.production.example`(비어 있음) |
| `HIS_CLIENT_SECRET` | `infra/docker/.env.production.example`(비어 있음) |
| `HIS_INTEGRATION_KEY` | `infra/docker/.env.production.example`(비어 있음) |
| `JWT_SECRET` | `README.md` · `apps/api/.env.example` |
| `NEXT_PUBLIC_DEMO_PASSWORD` | 로그인 화면 데모 패널(`NEXT_PUBLIC_DEMO=1` 빌드에서만) — `SEED_PASSWORD` 와 같은 값 |
| `PW` | `infra/scripts/his-fhir-smoke.sh` · `reflex-pilot-rehearsal.sh` 실행 시 — 지정하지 않으면 멈춥니다 |
| `SEED_PASSWORD` | 시드(`apps/api/prisma/seed.ts`) — 지정하지 않으면 무작위로 만들어 로그에 한 번 찍습니다 |
| 문서 · 예시 속 비밀번호 | `16_개발착수_구현현황.md` · `README.md` · `apps/api/.env.example` — 접속 문자열 · 예시 명령의 비밀번호를 `CHANGE_ME` 로 비웠습니다. 실제 값으로 바꿔 쓰십시오 |

- 같은 이름이 여러 곳에 있으면 **모두 같은 값**이어야 하는지(서로 맞물리는 연동 비밀) 확인하십시오.
- 값은 길고 무작위로 만드십시오(예: `openssl rand -base64 32`). 저장소에 다시 커밋하지 마십시오.

## 켜기 전에 기관이 정할 보안 설정

아래 기능은 공개판에서 **설정하지 않으면 안전한 쪽으로 멈추거나 꺼져 있습니다.** 기관의 운영 절차에 맞춰 직접 정하십시오.

| 설정 | 무엇을 정하나 |
|---|---|
| `LIS_SEED_BACKFILL_ENABLED` | 시드 백필(실 데이터를 시드로 등록하는 관리 기능)은 **기본으로 꺼져 있습니다.** 기관이 누가 요청하고 누가 승인하는지 절차를 정한 뒤 `1` 로 켭니다. |
| `LIS_BACKUP_GPG_RECIPIENT` | 백업 암호화에 쓸 gpg 공개키. `LIS_BACKUP_OFFSITE`(원격 사본)를 쓰려면 **반드시** 설정해야 하며, 설정하지 않거나 gpg 가 없으면 백업 스크립트가 멈춥니다. |

- 코드 안의 개발용 기본값은 운영에서 반드시 환경 변수로 덮어쓰십시오.
- 이 생태계 전체의 소개 · 구축 순서: [werub-his-ecosystem](https://github.com/seanshin/werub-his-ecosystem)
