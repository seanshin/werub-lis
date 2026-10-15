-- P2 정합성: 누락 유니크 제약 3건 (재검토 2026-07-21 발견목록 P2)
-- 사전 점검(2026-07-22, 운영 lis DB): 세 대상 모두 중복 0건 확인 후 작성.
-- LabOrder.hisOrderNo는 의도적으로 제외 — 재채취 오더가 hisOrderNo를 복제(원 HIS 오더 회신 결속).

-- HIS 오더당 병리 케이스 1건(이중 유입 DB-레벨 차단)
DROP INDEX IF EXISTS "pathology_case_his_order_no_idx";
CREATE UNIQUE INDEX "pathology_case_his_order_no_key" ON "pathology_case"("his_order_no");

-- 오더당 동일 검사 1항목(중복 수행·중복 청구 원천 차단)
CREATE UNIQUE INDEX "order_item_order_id_test_code_key" ON "order_item"("order_id", "test_code");

-- 보고서당 추가보고 seq 유일(동시 등록 경합 중복 차단)
DROP INDEX IF EXISTS "pathology_addendum_sp_no_idx";
CREATE UNIQUE INDEX "pathology_addendum_sp_no_seq_key" ON "pathology_addendum"("sp_no", "seq");
