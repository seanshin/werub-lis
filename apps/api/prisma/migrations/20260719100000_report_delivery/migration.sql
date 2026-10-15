-- C1 결과 리포트 배포/전달 로그. 신규 테이블.
CREATE TABLE "report_delivery" (
  "delivery_id" TEXT NOT NULL,
  "specimen_no" TEXT NOT NULL,
  "channel" TEXT NOT NULL,
  "recipient" TEXT,
  "delivered_by" TEXT,
  "delivered_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" TEXT,
  CONSTRAINT "report_delivery_pkey" PRIMARY KEY ("delivery_id")
);
CREATE INDEX "report_delivery_specimen_no_idx" ON "report_delivery"("specimen_no");
