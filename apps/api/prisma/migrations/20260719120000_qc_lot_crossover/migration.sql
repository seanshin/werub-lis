-- D1 QC 로트 크로스오버 — QcTarget 로트별 목표범위, QcResult 로트 기록.
-- 기존 행은 'DEFAULT' 로트로 소급. unique 키에 lot 추가.
UPDATE "qc_target" SET "lot" = 'DEFAULT' WHERE "lot" IS NULL;
ALTER TABLE "qc_target" ALTER COLUMN "lot" SET DEFAULT 'DEFAULT';
ALTER TABLE "qc_target" ALTER COLUMN "lot" SET NOT NULL;
DROP INDEX IF EXISTS "qc_target_qc_code_instrument_test_code_key";
CREATE UNIQUE INDEX "qc_target_qc_code_instrument_test_code_lot_key" ON "qc_target"("qc_code", "instrument", "test_code", "lot");

ALTER TABLE "qc_result" ADD COLUMN "lot" TEXT NOT NULL DEFAULT 'DEFAULT';
