-- 성능 검토(2026-07-30) 인덱스 보강 2차.
-- 1차(20260718010000_perf_indexes)가 상위 테이블을 정리했고, 이번엔 검토에서 확인된
-- 최고빈도 경로의 잔여 공백을 닫는다. 전부 additive — 데이터 무손실.

-- lab_order.patient_id: 결과 입력/검증마다 직전값·델타 조회가 order.patientId로 파고든다.
CREATE INDEX "lab_order_patient_id_order_dt_idx" ON "lab_order"("patient_id", "order_dt");
-- 상태 미지정 기본 목록·대시보드 날짜범위([status,order_dt]는 선도열 불일치라 못 탄다).
CREATE INDEX "lab_order_order_dt_idx" ON "lab_order"("order_dt");

-- audit_log.created_dt: 조회 화면 기본 필터·기간 요약·보존 퍼지 전부 시간축 — 연 수백만 행.
CREATE INDEX "audit_log_created_dt_idx" ON "audit_log"("created_dt");

-- critical_notify: 영구 누적 테이블인데 미확인(ack_dt IS NULL) 조회가 크론 2종+전 사용자 배지 폴링.
CREATE INDEX "critical_notify_ack_dt_created_dt_idx" ON "critical_notify"("ack_dt", "created_dt");
CREATE INDEX "critical_notify_patient_id_idx" ON "critical_notify"("patient_id");
CREATE INDEX "critical_notify_result_id_idx" ON "critical_notify"("result_id");

-- order_item.status: 대시보드 미완료 카운트 — 최대급 테이블 풀스캔 방지.
CREATE INDEX "order_item_status_idx" ON "order_item"("status");

-- visit.patient_id: 환자 상세 include·병합 updateMany.
CREATE INDEX "visit_patient_id_idx" ON "visit"("patient_id");

-- 채번 LIKE 접두 조회의 이식성: 현 컨테이너(alpine, C collation)에서는 PK btree가
-- startsWith를 타지만, AWS RDS(en_US.UTF-8) 이전 시 풀스캔으로 전락한다.
-- text_pattern_ops 인덱스는 collation 무관하게 접두 매칭을 보장한다(Prisma 스키마로는
-- 표현 불가라 raw로 둔다 — drift 검사 시 이 두 건은 의도된 스키마 외 인덱스).
CREATE INDEX "specimen_specimen_no_pattern_idx" ON "specimen"("specimen_no" text_pattern_ops);
CREATE INDEX "pathology_case_sp_no_pattern_idx" ON "pathology_case"("sp_no" text_pattern_ops);
