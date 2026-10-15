-- B5 검사별 자동검증·델타 설정 + QC 로트. 추가 컬럼(nullable/기본값), 기존 행 영향 0.
ALTER TABLE "test_master" ADD COLUMN "auto_verify" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "test_master" ADD COLUMN "delta_pct_limit" DOUBLE PRECISION;
ALTER TABLE "test_master" ADD COLUMN "delta_abs_limit" DOUBLE PRECISION;
ALTER TABLE "test_master" ADD COLUMN "delta_window_days" INTEGER;
ALTER TABLE "qc_target" ADD COLUMN "lot" TEXT;
