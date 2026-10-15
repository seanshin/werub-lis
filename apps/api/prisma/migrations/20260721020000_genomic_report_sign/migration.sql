-- G3 유전체 보고서 서명·확정 — 판독 서명(배포는 ReportDelivery 재사용).
ALTER TABLE "genomic_order" ADD COLUMN "report_status" TEXT;
ALTER TABLE "genomic_order" ADD COLUMN "report_signed_by" TEXT;
ALTER TABLE "genomic_order" ADD COLUMN "report_signed_dt" TIMESTAMP(3);
