/**
 * 개시 전환 체크리스트 레지스트리(순수) — 문서에만 있던 항목을 시스템 항목으로.
 *
 * 원천: `docs/개시전_체크리스트.md`(A~H) · `docs/개시_잔여항목_의뢰_검증서.md`(잔여 12건)
 *       · `docs/개시일_컷오버_런시트.md`(사전점검 P1~P6 · 플립 단계 1~6 · 개시 후 스모크)
 *
 * 설계 원칙
 *  - **자동 판정 우선**: `autoCheck`가 있으면 시스템이 판정하고 사람이 바꿀 수 없다.
 *    ("화면상 완료"로 오인하는 사고를 근본 차단 — 2026-07-30 실측에서 3건 발견)
 *  - **비해당은 NA가 아니라 미생성**: `requires`에 없는 능력이면 항목 자체가 만들어지지 않는다.
 *    사이트마다 손으로 NA 처리하면 그게 곧 조용한 우회 경로가 된다.
 *  - **삭제하지 않는다**: 없어진 항목은 `deprecated`로 표시한다. 지우면 과거 승인 스냅샷을 해석할 수 없다.
 *
 * 근거: docs/개시전환센터_기획서.md §3.2·§6.2a·§6.4
 *
 * @author 신현묵 <8508132+seanshin@users.noreply.github.com>
 */

/** 사이트가 실제로 쓰는 기능 — 프로파일에 없으면 관련 항목이 생성되지 않는다. */
export const SITE_CAPABILITIES = ['HIS', 'PACS', 'ERP', 'PATHOLOGY', 'GENOMIC', 'MICRO', 'TRANSFUSION'] as const;
export type SiteCapability = (typeof SITE_CAPABILITIES)[number];

export type GoLivePhase = 'PREP' | 'CUTOVER' | 'POST';
export type EvidenceLevel = 'NONE' | 'DOC' | 'DOC_REQUIRED';

export interface GoLiveTask {
  code: string;
  phase: GoLivePhase;
  group: string;
  title: string;
  owner: string;
  blocking: boolean;
  evidence: EvidenceLevel;
  /** 콘솔 readiness의 check key — 있으면 시스템이 판정하고 수동 완료를 막는다. */
  autoCheck?: string;
  /** 비가역 작업 — 전환 실행(4중 게이트) 대상. */
  irreversible?: boolean;
  /** 선행 항목 코드 — 미완이면 이 항목을 시작할 수 없다. */
  dependsOn?: string[];
  requires?: SiteCapability[];
  docRef?: string;
  hint?: string;
  deprecated?: boolean;
}

/** 레지스트리 버전 — 승인 스냅샷에 함께 저장해 나중에 해석할 수 있게 한다(§6.4). */
export const GOLIVE_REGISTRY_VERSION = '1.0.0';

export const GOLIVE_TASKS: GoLiveTask[] = [
  // ── PREP · 구성·값 ─────────────────────────────────────────────────────────
  { code: 'A2', phase: 'PREP', group: '구성·값', title: '위험치 통보 채널(실 URL + 서명키)', owner: '의료정보·전산',
    blocking: true, evidence: 'NONE', autoCheck: 'critical_webhook',
    docRef: 'docs/LIS_의뢰_2026-07-30_전산_통보채널_URL.md',
    hint: 'https 필수. 저장 후 **테스트 발송으로 도달 확인**까지 해야 완료다. 시드 sink는 완료가 아니다. '
        + '⛔값 입력은 **파일럿 정리(RUN-6) 이후** — 먼저 넣으면 미확인 파일럿 위험치가 실 당직 채널로 반복 발신된다' },
  // ⚠ 자동 판정 소스(readiness·managementConsole)에 대응 키가 없으면 UNKNOWN으로 남는다.
  //   OPS 채널은 판정 항목이 없어 수동으로 둔다 — 없는 키를 적으면 영원히 미판정이 된다.
  { code: 'C2', phase: 'PREP', group: '구성·값', title: '운영 통보 채널(OPS_WEBHOOK_URL)', owner: '의료정보·전산',
    blocking: false, evidence: 'NONE', docRef: 'docs/LIS_의뢰_2026-07-30_전산_통보채널_URL.md',
    hint: '미설정 시 연계 이상이 알림함에만 — 무인 시간대 공백' },
  { code: 'C3', phase: 'PREP', group: '구성·값', title: '오프사이트 백업 경로(LIS_BACKUP_OFFSITE)', owner: '운영',
    blocking: false, evidence: 'NONE', autoCheck: 'backup_offsite',
    docRef: 'docs/LIS_의뢰_2026-07-30_운영_오프사이트백업.md',
    hint: '미설정 시 로컬 보관만 — 호스트 소실에 무방비. 저장 위치는 H1 Q5(백업 저장소 동일 기준) 회신에 따라 제약될 수 있다' },
  { code: 'A4', phase: 'PREP', group: '구성·값', title: '감사 보존기간 법무 확정값', owner: '법무',
    blocking: false, evidence: 'DOC_REQUIRED', docRef: 'docs/LIS_의뢰_2026-07-30_법무_H1_전자의무기록_판단.md',
    hint: '확정 전까지 LIFECYCLE_PURGE는 off 유지(자동 삭제 미실행). 법정 하한은 적용 시점에 강제된다' },

  // ── PREP · 조직 결재·서명 ──────────────────────────────────────────────────
  { code: 'E1', phase: 'PREP', group: '조직 결재', title: 'A-1 수용·청구 정책 결재', owner: '진료부·원무',
    blocking: true, evidence: 'DOC_REQUIRED', autoCheck: 'org_gates', docRef: 'docs/조직게이트_상신첨부체크리스트.md' },
  { code: 'E2', phase: 'PREP', group: '조직 결재', title: 'A-2 프로토콜 승인 주관 결재', owner: '진단검사의학과',
    blocking: true, evidence: 'DOC_REQUIRED', autoCheck: 'org_gates' },
  { code: 'E3', phase: 'PREP', group: '조직 결재', title: 'A-3 실운영 write 스코프 결재', owner: '보안',
    blocking: true, evidence: 'DOC_REQUIRED', autoCheck: 'org_gates', requires: ['HIS'],
    hint: '완료가 HIS 운영 자격 발급의 트리거다' },
  { code: 'F1', phase: 'PREP', group: '검사실 서명', title: '검사실 실값 서명(참고치·QC·EDI 등 7섹션)', owner: '진단검사의학과',
    blocking: false, evidence: 'DOC', autoCheck: 'lab_signoff', docRef: 'docs/서명워크시트_검사실_법무.md',
    hint: '미서명이면 참고치·QC가 대표값인 채로 운영된다' },

  // ── PREP · 인프라 결정 ─────────────────────────────────────────────────────
  { code: 'H1', phase: 'PREP', group: '인프라 결정', title: 'H1 법무·정보보호 회신(EMR 해당·보안인증·백업기준)', owner: '법무',
    blocking: true, evidence: 'DOC_REQUIRED', docRef: 'docs/LIS_의뢰_2026-07-30_법무_H1_전자의무기록_판단.md',
    hint: 'H5(RDS 구성) 판단이 여기에 의존한다 — 먼저 받아야 한다. 회신란 포함 회람본이 docRef다(배경은 실서비스_결정요청_H1-H5.md)' },
  { code: 'H2', phase: 'PREP', group: '인프라 결정', title: 'H2 HIS·PACS 연결 방식(VPN) 합의', owner: '인프라',
    blocking: true, evidence: 'DOC_REQUIRED', docRef: 'docs/LIS_질의_2026-07-29_H2_VPN_연결정보.md',
    hint: '리드타임 최장 — 가장 먼저 착수. PACS MLLP가 평문이라 전용 구간이 필수. '
      + '**Q4(MLLP over TLS)=가능 회신 수령(2026-08-03 PACS)** → "평문이라 재검토" 최악 분기는 해소, 안 B 성립 가능. '
      + '⚠**전제 재확인 필요**: 이 항목은 "LIS가 AWS로 분리된다"를 전제로 쓰였는데 그 전제가 아직 결정이 아니다 — '
      + '**원내 코로케이션을 유지하면 H2 자체가 불필요**(PACS 지적, 08-03). 따라서 순서는 H1(배치 결정) → 필요할 때만 H2. '
      + 'Q1(소재·접점 IP·포트)은 임시값을 받으면 방화벽 신청이 두 번 나가므로 **배치 확정 후 요청**으로 보류' },
  { code: 'H5', phase: 'PREP', group: '인프라 결정', title: 'H5 RDS 가용성 구성 승인', owner: '인프라',
    blocking: true, evidence: 'DOC_REQUIRED', dependsOn: ['H1'] },

  // ── PREP · 사전 점검(런시트 A) ─────────────────────────────────────────────
  { code: 'P1', phase: 'PREP', group: '사전 점검', title: '전체 백업 + 복구 리허설(RTO 실측)', owner: '운영',
    blocking: true, evidence: 'DOC', docRef: 'docs/백업복구_운영절차서.md',
    hint: '되돌릴 지점이 없으면 비가역 작업을 시작하지 않는다' },
  { code: 'P2', phase: 'PREP', group: '사전 점검', title: '운영 시크릿 확보(JWT·DB·연계)', owner: '운영·보안',
    blocking: true, evidence: 'NONE', hint: '개발 서버 값 재사용 금지 — 전부 신규 발급' },
  { code: 'P5', phase: 'PREP', group: '사전 점검', title: 'PACS cutover-preflight(실 PID·Accession 길이)', owner: '운영·PACS',
    blocking: false, evidence: 'DOC', requires: ['PACS'],
    docRef: 'docs/LIS_의뢰_2026-07-30_PACS_컷오버일정_실PID샘플.md',
    hint: '실 PID 샘플을 컷오버 창 **이전에** 받아야 한다 — 길이 초과가 나오면 채번 규칙을 바꿔야 하고 당일에는 못 한다. '
      + '**기술 검증분 충족(2026-08-03 PACS 실증 수령)**: Accession≤16자·PID 바이트 보존 PASS(ACC-SP-26-0002/P2026-0001·ACC-SP-26-0004/HR-XXXXXXXX-XXXX)·HIS MRN 2형식 3/3. '
      + '남은 것은 컷오버 창(일정)이며 H2 확정 후에 잡힌다' },
  { code: 'P6', phase: 'PREP', group: '사전 점검', title: '연계 왕복 스모크(리허설)', owner: '운영',
    blocking: false, evidence: 'NONE', requires: ['HIS'],
    hint: '✅ 3구간 완결(2026-07-18/19, dev 자격). ⛔**지금 재실행하지 말 것(2026-08-03)** — '
      + '`his-fhir-smoke.sh`·`erp-billing-smoke.sh`는 HIS·ERP에 **실제 데이터를 만든다.** '
      + 'X1·X2로 **그 잔재를 지워 달라고 요청해 둔 상태**라 재실행하면 정리 목록이 다시 늘고 상대 팀이 두 번 일한다. '
      + '재실행이 꼭 필요하면 목록 갱신을 함께 통보할 것. 개시 후 실 왕복 확인은 **PS-3**가 대신한다. '
      + '부작용 없는 점검은 `his-target-token-check.sh`(GET만)·`verify.sh`(읽기 전용)·`restore-rehearsal.sh`(scratch)' },

  // ── PREP · 연계 잔재 정리 ──────────────────────────────────────────────────
  // ★RUN-6는 **LIS 데이터만** 지운다. 파일럿에서 밖으로 내보낸 것은 상대 시스템에 남는다 —
  //   PACS 워크리스트에 고아가 남은 것(2026-08-03)을 계기로 전 연계를 훑어 항목화했다.
  //   "우리 쪽 0"만으로는 개시 후 경보가 신호인지 잔재인지 구분되지 않는다.
  { code: 'X1', phase: 'PREP', group: '연계 잔재 정리', title: 'ERP 파일럿 청구 7건 정리(ACCEPTED 상태)', owner: 'ERP·원무',
    blocking: true, evidence: 'DOC_REQUIRED', requires: ['ERP'], docRef: 'docs/LIS_의뢰_2026-08-03_ERP_파일럿청구_정리.md',
    hint: '🔴 합성 환자 청구가 ERP에서 **실 청구·수납·심사로 진행되면 되돌리기 어렵다**. '
      + 'LIS는 재전송하지 않으므로(재전송 대상은 PENDING뿐) 시점 제약은 없다 — 개시 전 완료가 기준. '
      + '**ERP 회신 수령(2026-08-03)**: 실 청구 경로가 **구조적으로 없음**(캡처 스테이징 격리·mapped=0·산정 보류·진행 0건) · '
      + '취소 EP 신설(v1.287.0) · **ERP 자체 스모크 24건 포함 31건 전량 취소 예정**. '
      + '✅**취소 실행 완료 회신 수령(2026-08-03)**: 관리 API 경유 **31건 전량 취소(cancelled=31 / failed=0)**, '
      + '폴링 응답 `"status":"CANCELLED"` 실측 확인. **완료 처리 가능** — 근거 문서(ERP 회신) 첨부 후 DONE' },
  { code: 'X2', phase: 'PREP', group: '연계 잔재 정리', title: 'HIS 파일럿 결과·Reflex 오더 정리', owner: 'HIS·의료정보',
    blocking: false, evidence: 'DOC_REQUIRED', requires: ['HIS'],
    docRef: 'docs/LIS_의뢰_2026-08-03_HIS_파일럿잔재_정리창.md',
    hint: 'FHIR DiagnosticReport 19건(IF-G08, 07-13~24, 전부 합성환자) + **Reflex SR 1건이 HIS 실 오더로 승인됨**'
      + '(0cae4df6-…) · DLQ 4(HIS 미도달, **재큐 금지**) · 반려 2. '
      + '창(window)은 **목록 전달로 해소** — 기록이 사라지기 전에 넘겼으므로 이후엔 양측이 각자 시점에 정리해도 된다. '
      + 'LIS는 재발신하지 않는다(결과 재시도는 FAILED만·DLQ는 재시도 대상 아님). '
      + '**HIS 선제 실측 회신 수령(2026-08-03)**: 재무 오염 없음 · HIS 실측 **24건**(RECEIVED 17·MATCHED 3 즉시삭제 가능 / **APPLIED 4만 환자별 판단**) · Reflex PENDING 2 취소 가능. '
      + '🔴**잔여 확인 1건: `HR-XXXXXXXX-XXXX`((환자명 가림))이 실 환자인가** — 실 환자라면 그 기록에 **합성 CRP 3.0이 반영된 상태**라 우선 삭제 대상이다. '
      + '건수 차 5는 **응답 유실 재시도로 HIS에만 남은 중복**으로 추정(mcid는 HIS 발급 id라 대조로 특정 가능)' },
  { code: 'X3', phase: 'PREP', group: '연계 잔재 정리', title: 'PACS 워크리스트 잔재 정리', owner: '운영·PACS',
    blocking: false, evidence: 'DOC', requires: ['PACS'],
    docRef: 'docs/LIS_회신_2026-08-03_PACS_2차_RUN6대상_H2Q4.md',
    hint: '✅ PACS 대조 완료(2026-08-03) — 전이 대상 **0건**(LIS 유래 6행 중 SCHEDULED는 ACC-SP-26-0004 하나이고 RUN-6의 CA에 포함). '
      + 'PACS가 **RUN-6 직전 재확인** 약속. 개시일 CA 6건 중 실제 전이는 1건, 나머지는 noop' },

  // ── CUTOVER · 플립(런시트 B) ───────────────────────────────────────────────
  { code: 'RUN-1', phase: 'CUTOVER', group: '플립', title: '시크릿 주입(위험치 채널 포함)', owner: '운영',
    blocking: true, evidence: 'NONE', dependsOn: ['A2', 'P2'] },
  { code: 'RUN-1V', phase: 'CUTOVER', group: '플립', title: '⚠ 위험치 채널 주입 직후 E2E 재실행 — 발신 0 확인', owner: '운영',
    blocking: true, evidence: 'NONE', dependsOn: ['RUN-1'],
    hint: 'E2E 게이트는 운영 .env를 그대로 받는다. 값을 넣는 그 시점이 유일한 발현 시점이라 절차로 확인한다(v1.54.0)' },
  { code: 'RUN-2', phase: 'CUTOVER', group: '플립', title: '실 사용자 계정 생성 · 데모 계정 폐기', owner: '운영',
    blocking: true, evidence: 'NONE', autoCheck: 'demo_accounts', dependsOn: ['RUN-1'] },
  { code: 'RUN-2P', phase: 'CUTOVER', group: '플립', title: '판독의 계정 ↔ Provider 연결', owner: '운영',
    blocking: false, evidence: 'NONE', autoCheck: 'provider_link',
    hint: '미연결이면 병리 사인아웃이 403으로 막힌다', requires: ['PATHOLOGY'] },
  { code: 'RUN-3', phase: 'CUTOVER', group: '플립', title: 'HIS 운영 write 자격 전환(dev 폐기)', owner: '운영',
    blocking: true, evidence: 'NONE', dependsOn: ['E3'], requires: ['HIS'],
    hint: 'HIS 토큰 시크릿 ③ 회전도 이때 함께 처리한다' },
  { code: 'RUN-4', phase: 'CUTOVER', group: '플립', title: 'PACS 컷오버(실 자격·PID)', owner: '운영·PACS',
    blocking: false, evidence: 'DOC', requires: ['PACS'],
    hint: 'P5의 preflight 실증(2026-08-03 수령)은 **현 토폴로지 기준**이다 — LIS가 AWS로 분리되면 '
      + '접점·경로가 바뀌므로 **cutover-preflight를 재실행**한 뒤 전환할 것. 원내 유지로 결정되면 재검증 불요(PACS 확인 완료). '
      + 'Accession 채번은 2자리 연도 고정(연번 6자리까지 16자 수용), 접두어 체계를 바꾸면 PACS에 사전 공유할 것' },
  { code: 'RUN-5', phase: 'CUTOVER', group: '플립', title: '데모 패널 OFF(NEXT_PUBLIC_DEMO="") + web 재빌드', owner: '운영',
    blocking: false, evidence: 'NONE' },
  { code: 'RUN-6', phase: 'CUTOVER', group: '플립', title: '파일럿 데이터 정리', owner: '운영',
    blocking: true, evidence: 'NONE', irreversible: true, dependsOn: ['P1', 'RUN-2'],
    docRef: 'docs/설치_가이드.md#3-1',
    hint: '🔴 비가역. /admin/seed-cleanup(미리보기→확인문구)으로 실행한다. 실 데이터 감지 시 서버가 거부. '
      + '미리보기의 **PACS 워크리스트** 건수를 확인할 것 — 삭제 전 취소 ORM이 자동 발신되며, 실패분은 PACS에 고아로 남아 사람이 CANCELLED 전이시켜야 한다(2026-08-03 PACS 회신)' },

  // ── POST · 개시 후 스모크(런시트 C) ────────────────────────────────────────
  { code: 'PS-1', phase: 'POST', group: '개시 후 스모크', title: '연계 감시 전 지표 0에서 출발', owner: '운영',
    blocking: true, evidence: 'NONE', dependsOn: ['RUN-6'],
    hint: '0에서 출발하지 않으면 이후 경보가 신호인지 잔재인지 구분되지 않는다' },
  { code: 'PS-2', phase: 'POST', group: '개시 후 스모크', title: '위험치 통보 실제 도달 확인(테스트 발송)', owner: '운영',
    blocking: true, evidence: 'NONE', dependsOn: ['RUN-1'] },
  { code: 'PS-3', phase: 'POST', group: '개시 후 스모크', title: 'HIS 오더 폴링 → 접수 → 결과 발신 왕복 1건', owner: '운영',
    blocking: true, evidence: 'NONE', requires: ['HIS'], dependsOn: ['RUN-3'] },
  { code: 'PS-4', phase: 'POST', group: '개시 후 스모크', title: '설치 검증 스크립트 통과(verify.sh)', owner: '운영',
    blocking: false, evidence: 'NONE', hint: 'infra/install/verify.sh — 무인증 401·Swagger 비노출·시크릿 위생' },
  { code: 'PS-5', phase: 'POST', group: '개시 후 스모크', title: '백업 스케줄 동작 확인(첫 백업 + 복원 검증)', owner: '운영',
    blocking: false, evidence: 'NONE', dependsOn: ['C3'],
    hint: '설치만으로는 백업이 돌지 않는다. "백업이 있다"와 "복원된다"는 다른 문제다' },
];

/** 사이트 프로파일에 맞는 항목만 — 비해당은 애초에 만들어지지 않는다(NA 처리가 아니다). */
export function tasksForCapabilities(caps: readonly string[]): GoLiveTask[] {
  return GOLIVE_TASKS.filter(
    (t) => !t.deprecated && (!t.requires || t.requires.every((r) => caps.includes(r))),
  );
}

export const GOLIVE_TASK_BY_CODE = new Map(GOLIVE_TASKS.map((t) => [t.code, t]));
