-- B3 법정감염병·의료관련감염 신고 추적. 신규 테이블.
CREATE TABLE "infectious_report" (
  "report_id" TEXT NOT NULL,
  "isolate_id" TEXT,
  "patient_id" TEXT,
  "patient_name" TEXT,
  "organism" TEXT NOT NULL,
  "disease" TEXT NOT NULL,
  "grade" TEXT,
  "specimen_no" TEXT,
  "detected_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "notified_dt" TIMESTAMP(3),
  "notified_by" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "note" TEXT,
  CONSTRAINT "infectious_report_pkey" PRIMARY KEY ("report_id")
);
CREATE INDEX "infectious_report_status_detected_dt_idx" ON "infectious_report"("status", "detected_dt");
