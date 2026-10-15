-- 병리 재점검 B~E: 배정(C)·접수반려(E) 케이스 필드 + 염색오더(B)·컨설트(D) 신규 테이블.
ALTER TABLE "pathology_case" ADD COLUMN "assigned_to" TEXT;
ALTER TABLE "pathology_case" ADD COLUMN "assigned_dt" TIMESTAMP(3);
ALTER TABLE "pathology_case" ADD COLUMN "reject_status" TEXT;
ALTER TABLE "pathology_case" ADD COLUMN "reject_reason" TEXT;
ALTER TABLE "pathology_case" ADD COLUMN "rejected_by" TEXT;
ALTER TABLE "pathology_case" ADD COLUMN "rejected_dt" TIMESTAMP(3);
CREATE INDEX "pathology_case_assigned_to_idx" ON "pathology_case"("assigned_to");

CREATE TABLE "pathology_stain_order" (
  "order_id" TEXT NOT NULL,
  "sp_no" TEXT NOT NULL,
  "block_id" TEXT,
  "order_type" TEXT NOT NULL,
  "detail" TEXT,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "requested_by" TEXT,
  "requested_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_by" TEXT,
  "completed_dt" TIMESTAMP(3),
  "note" TEXT,
  CONSTRAINT "pathology_stain_order_pkey" PRIMARY KEY ("order_id")
);
CREATE INDEX "pathology_stain_order_sp_no_idx" ON "pathology_stain_order"("sp_no");
CREATE INDEX "pathology_stain_order_status_idx" ON "pathology_stain_order"("status");
ALTER TABLE "pathology_stain_order" ADD CONSTRAINT "pathology_stain_order_sp_no_fkey"
  FOREIGN KEY ("sp_no") REFERENCES "pathology_case"("sp_no") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "pathology_consult" (
  "consult_id" TEXT NOT NULL,
  "sp_no" TEXT NOT NULL,
  "consult_type" TEXT NOT NULL,
  "consultant" TEXT,
  "question" TEXT,
  "opinion" TEXT,
  "status" TEXT NOT NULL DEFAULT 'REQUESTED',
  "requested_by" TEXT,
  "requested_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "responded_dt" TIMESTAMP(3),
  CONSTRAINT "pathology_consult_pkey" PRIMARY KEY ("consult_id")
);
CREATE INDEX "pathology_consult_sp_no_idx" ON "pathology_consult"("sp_no");
ALTER TABLE "pathology_consult" ADD CONSTRAINT "pathology_consult_sp_no_fkey"
  FOREIGN KEY ("sp_no") REFERENCES "pathology_case"("sp_no") ON DELETE RESTRICT ON UPDATE CASCADE;
