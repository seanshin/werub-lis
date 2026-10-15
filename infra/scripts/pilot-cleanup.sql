-- ============================================================================
-- 파일럿 데이터 정리 (개시 런북 단계 6 / 체크리스트 D1)
-- ----------------------------------------------------------------------------
-- 목적: 파일럿·리허설 중 쌓인 합성 트랜잭션 데이터(환자·오더·결과·수혈·연계로그·
--       DLQ·알림 등)를 비우고 **마스터·계정·설정은 보존**한 채 실개시를 시작한다.
--
-- 🔴 이 스크립트는 **폴백**이다. 정본 경로는 `/admin/seed-cleanup`(시드 표식 기반 선택 삭제 +
--    4중 게이트 + **PACS 워크리스트 선취소**)이다. 여기서는 취소 ORM이 나가지 않으므로
--    병리 케이스를 지우면 **PACS 워크리스트에 SCHEDULED가 고아로 남는다**
--    (2026-07-29 픽스처 파기에서 실제 발생 · PACS 감시가 발견). 부득이 이 경로로 지웠다면
--    PACS팀에 잔여 accession을 전달해 CANCELLED 전이를 요청할 것.
--
-- ⚠ 파괴적. 실행 전 반드시:
--   1) 전체 백업:  pg_dump -U lis lis > /backup/pre-cleanup-$(date +%F).sql
--   2) 실개시 직전 1회만. 실행 후 되돌리려면 백업 복원뿐.
--   3) 실 환자 데이터가 이미 들어온 뒤에는 **절대 실행 금지**(전량 소실).
--
-- 실행:  docker exec -i lis-postgres psql -U lis -d lis < infra/scripts/pilot-cleanup.sql
--
-- 근거: 2026-07-22 점검에서 확인된 파일럿 유물(seed 위험치 2·reflex DLQ 4·미적재 오더 1)이
--       감시 baseline을 오염시켰다. 개시 시 clean 상태에서 감시가 의미를 갖게 한다.
-- ============================================================================

-- ── ① DRY-RUN: 지울 대상 건수 먼저 확인(이 블록만 떼어 단독 실행 가능) ────────────
\echo '=== 정리 대상(트랜잭션) 현재 건수 ==='
SELECT relname, n_live_tup FROM pg_stat_user_tables
WHERE relname IN (
  'patient','visit','lab_order','order_item','specimen','aliquot','result_attachment',
  'result','molecular_result','ngs_run','somatic_finding','billing_item','billing_claim','sendout',
  'report_delivery','critical_notify','qc_review','qc_result','culture','culture_report',
  'isolate','susceptibility','pathology_case','pathology_stain_order','pathology_consult',
  'cytology_report','ihc_result','pathology_specimen','pathology_block','pathology_slide',
  'pathology_scan_event','pathology_report','pathology_addendum','blood_unit','blood_typing',
  'patient_transfusion_req','transfusion_act','transfusion_reaction','infectious_report',
  'crossmatch','blood_issue','genomic_order','consent','variant','interpretation',
  'eqa_survey','reflex_execution','reflex_protocol_event','notification','interface_log',
  'integration_state'
) AND n_live_tup > 0
ORDER BY n_live_tup DESC;

\echo '=== 보존 대상(마스터·설정) — 이 테이블들은 건드리지 않는다 ==='
SELECT relname, n_live_tup FROM pg_stat_user_tables
WHERE relname IN (
  'provider','container','test_master','panel','panel_item','reference_range','code_mapping',
  'terminology_code','role','app_user','user_role','qc_material','qc_target',
  'instrument_mapping','barcode_config','reflex_protocol','his_lab_code',
  'org_approval','org_approval_history',
  -- 표준 코드셋 반입·운영 설정·검사실 정의 카탈로그 = 설정/마스터(개시 후에도 유지)
  'catalog_version','catalog_item','system_setting','molecular_assay','ngs_panel',
  'decision_record', -- 개시 조직/외부 결정 기록 = 설정(개시 후에도 유지)
  -- ★개시 전환의 **기록·근거**는 보존한다(v1.55.0 PROTECTED_ENTITIES와 같은 판단).
  --   정리가 자기 실행 이력을 지우면 "무엇을 지웠는가"가 남지 않고,
  --   서명·승인을 지우면 개시가 정당했다는 증거 자체가 사라진다.
  'cutover_run','seed_artifact','golive_task_record','golive_attachment','site_profile',
  'signoff_record','golive_approval'
) AND n_live_tup > 0
ORDER BY relname;

-- ── ② 실제 정리 — 트랜잭션 데이터 TRUNCATE(FK 무관하게 CASCADE 한 번) ──────────────
-- CASCADE는 나열된 트랜잭션 테이블이 참조하는 다른 트랜잭션 테이블만 함께 비운다.
-- 마스터는 트랜잭션을 참조하지 않으므로 CASCADE로도 절대 지워지지 않는다.
BEGIN;

TRUNCATE TABLE
  patient, visit, lab_order, order_item, specimen, aliquot, result_attachment,
  result, molecular_result, ngs_run, somatic_finding, billing_item, billing_claim, sendout,
  report_delivery, critical_notify, qc_review, qc_result, culture, culture_report,
  isolate, susceptibility, pathology_case, pathology_stain_order, pathology_consult,
  cytology_report, ihc_result, pathology_specimen, pathology_block, pathology_slide,
  pathology_scan_event, pathology_report, pathology_addendum, blood_unit, blood_typing,
  patient_transfusion_req, transfusion_act, transfusion_reaction, infectious_report,
  crossmatch, blood_issue, genomic_order, consent, variant, interpretation,
  eqa_survey, reflex_execution, reflex_protocol_event, notification, interface_log,
  integration_state
RESTART IDENTITY CASCADE;

COMMIT;

-- ── ③ 감사로그(audit_log)는 정책 결정 후 별도 처리 ──────────────────────────────
-- 파일럿 감사기록은 tamper-evident 해시체인이다. 지우면 다음 감사가 genesis로 새 체인을
-- 시작한다(정상). 다만 파일럿 감사 보존이 필요하면 **아카이브 후** 삭제한다.
-- 실행하려면 아래 주석을 해제:
--   BEGIN; TRUNCATE TABLE audit_log RESTART IDENTITY; COMMIT;

\echo '=== 정리 후 잔여(0이어야 정상, integration_state는 재폴링으로 채워짐) ==='
SELECT count(*) AS patient FROM patient
UNION ALL SELECT count(*) FROM lab_order
UNION ALL SELECT count(*) FROM result
UNION ALL SELECT count(*) FROM critical_notify
UNION ALL SELECT count(*) FROM interface_log;
