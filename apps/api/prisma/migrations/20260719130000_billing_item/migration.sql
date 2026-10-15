-- D3 청구 데이터 파운데이션. 신규 테이블(검사당 1회 청구 멱등).
CREATE TABLE "billing_item" (
  "billing_id" TEXT NOT NULL,
  "order_id" TEXT NOT NULL,
  "patient_id" TEXT,
  "test_code" TEXT NOT NULL,
  "edi_code" TEXT,
  "test_name" TEXT,
  "quantity" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'CAPTURED',
  "claim_batch_id" TEXT,
  "captured_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "note" TEXT,
  CONSTRAINT "billing_item_pkey" PRIMARY KEY ("billing_id")
);
CREATE UNIQUE INDEX "billing_item_order_id_test_code_key" ON "billing_item"("order_id", "test_code");
CREATE INDEX "billing_item_status_captured_dt_idx" ON "billing_item"("status", "captured_dt");
