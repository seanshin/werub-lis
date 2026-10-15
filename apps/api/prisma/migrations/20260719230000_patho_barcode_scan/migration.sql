-- PP8 블록·슬라이드 바코드·스캔 상태·관리연속성 로그.
ALTER TABLE "pathology_block" ADD COLUMN "barcode" TEXT;
ALTER TABLE "pathology_block" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'CREATED';
CREATE UNIQUE INDEX "pathology_block_barcode_key" ON "pathology_block"("barcode");

ALTER TABLE "pathology_slide" ADD COLUMN "barcode" TEXT;
ALTER TABLE "pathology_slide" ADD COLUMN "scan_status" TEXT NOT NULL DEFAULT 'PENDING';
ALTER TABLE "pathology_slide" ADD COLUMN "scanned_dt" TIMESTAMP(3);
ALTER TABLE "pathology_slide" ADD COLUMN "wsi_ref" TEXT;
CREATE UNIQUE INDEX "pathology_slide_barcode_key" ON "pathology_slide"("barcode");

CREATE TABLE "pathology_scan_event" (
  "event_id" TEXT NOT NULL,
  "target_type" TEXT NOT NULL,
  "target_id" TEXT NOT NULL,
  "sp_no" TEXT NOT NULL,
  "event" TEXT NOT NULL,
  "location" TEXT,
  "scanned_by" TEXT,
  "scanned_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pathology_scan_event_pkey" PRIMARY KEY ("event_id")
);
CREATE INDEX "pathology_scan_event_sp_no_idx" ON "pathology_scan_event"("sp_no");
CREATE INDEX "pathology_scan_event_target_type_target_id_idx" ON "pathology_scan_event"("target_type", "target_id");
