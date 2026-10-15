-- D4 분자진단/PCR 결과 파운데이션. 신규 테이블.
CREATE TABLE "molecular_result" (
  "mol_id" TEXT NOT NULL,
  "specimen_no" TEXT NOT NULL,
  "panel_code" TEXT,
  "target" TEXT NOT NULL,
  "assay" TEXT,
  "detection" TEXT NOT NULL,
  "ct" DOUBLE PRECISION,
  "quant_value" TEXT,
  "quant_unit" TEXT,
  "interpretation" TEXT,
  "reported_by" TEXT,
  "reported_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "status" TEXT NOT NULL DEFAULT 'FINAL',
  CONSTRAINT "molecular_result_pkey" PRIMARY KEY ("mol_id")
);
CREATE INDEX "molecular_result_specimen_no_idx" ON "molecular_result"("specimen_no");
CREATE INDEX "molecular_result_target_reported_dt_idx" ON "molecular_result"("target", "reported_dt");
