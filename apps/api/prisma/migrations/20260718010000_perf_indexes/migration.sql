-- 성능 인덱스(성능감사 P2) — 고빈도 조회·대량표 풀스캔 방지. 파일럿 소량 DB라 락 영향 0.
-- ⚠ 실 데이터 대량 상태에서 재적용 시엔 CREATE INDEX CONCURRENTLY(점검창) 권장. 명명은 Prisma 규칙 준수.

-- CodeMapping: resolveTestCodes 핫패스(hisCode/ediCode 조회) 풀스캔 제거
CREATE INDEX "code_mapping_his_code_idx" ON "code_mapping"("his_code");
CREATE INDEX "code_mapping_edi_code_idx" ON "code_mapping"("edi_code");

-- InterfaceLog: 무한증가 대량표 — 스케줄러·콘솔·웹훅 조회 컬럼
CREATE INDEX "interface_log_if_id_direction_status_created_dt_idx" ON "interface_log"("if_id", "direction", "status", "created_dt");
CREATE INDEX "interface_log_direction_created_dt_idx" ON "interface_log"("direction", "created_dt");
CREATE INDEX "interface_log_his_ref_idx" ON "interface_log"("his_ref");

-- Susceptibility: antibiogram/getCulture 조인
CREATE INDEX "susceptibility_isolate_id_idx" ON "susceptibility"("isolate_id");

-- Result: 최대 테이블 — stats(reportedDt 범위)·델타(testCode)
CREATE INDEX "result_reported_dt_idx" ON "result"("reported_dt");
CREATE INDEX "result_test_code_reported_dt_idx" ON "result"("test_code", "reported_dt");

-- ReflexExecution: 결과회신·웹훅 매칭
CREATE INDEX "reflex_execution_outbound_mcid_idx" ON "reflex_execution"("outbound_mcid");
CREATE INDEX "reflex_execution_order_id_idx" ON "reflex_execution"("order_id");

-- Notification: 미확인 알림 조회
CREATE INDEX "notification_ack_dt_ntype_created_dt_idx" ON "notification"("ack_dt", "ntype", "created_dt");

-- BloodUnit: 재고(IN_STOCK)·근접만료·혈액형 조회
CREATE INDEX "blood_unit_status_expiry_date_idx" ON "blood_unit"("status", "expiry_date");
CREATE INDEX "blood_unit_blood_group_status_idx" ON "blood_unit"("blood_group", "status");

-- Culture/Isolate: 조인·목록 필터
CREATE INDEX "culture_specimen_no_idx" ON "culture"("specimen_no");
CREATE INDEX "culture_report_status_idx" ON "culture"("report_status");
CREATE INDEX "isolate_culture_id_idx" ON "isolate"("culture_id");

-- QcResult: getStatus/monthlySummary(testCode·measuredDt) — 기존 복합의 선도열 불일치 보완
CREATE INDEX "qc_result_test_code_measured_dt_idx" ON "qc_result"("test_code", "measured_dt");

-- ReferenceRange: testCode 조회
CREATE INDEX "reference_range_test_code_idx" ON "reference_range"("test_code");
