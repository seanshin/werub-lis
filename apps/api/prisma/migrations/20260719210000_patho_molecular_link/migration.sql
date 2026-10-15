-- PP5 분자병리 ↔ 병리 케이스/블록 결속. 기존 결과 테이블에 nullable 링크 컬럼 추가.
ALTER TABLE "molecular_result" ADD COLUMN "case_sp_no" TEXT;
ALTER TABLE "molecular_result" ADD COLUMN "block_id" TEXT;
CREATE INDEX "molecular_result_case_sp_no_idx" ON "molecular_result"("case_sp_no");

ALTER TABLE "somatic_finding" ADD COLUMN "case_sp_no" TEXT;
ALTER TABLE "somatic_finding" ADD COLUMN "block_id" TEXT;
CREATE INDEX "somatic_finding_case_sp_no_idx" ON "somatic_finding"("case_sp_no");
