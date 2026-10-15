-- C2 외부검사 위탁(send-out) 추적. 신규 테이블.
CREATE TABLE "sendout" (
  "sendout_id" TEXT NOT NULL,
  "specimen_no" TEXT NOT NULL,
  "test_code" TEXT NOT NULL,
  "test_name" TEXT,
  "referral_lab" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "requested_by" TEXT,
  "requested_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sent_dt" TIMESTAMP(3),
  "result_value" TEXT,
  "result_unit" TEXT,
  "resulted_by" TEXT,
  "resulted_dt" TIMESTAMP(3),
  "note" TEXT,
  CONSTRAINT "sendout_pkey" PRIMARY KEY ("sendout_id")
);
CREATE INDEX "sendout_status_requested_dt_idx" ON "sendout"("status", "requested_dt");
CREATE INDEX "sendout_specimen_no_idx" ON "sendout"("specimen_no");
