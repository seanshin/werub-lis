-- BillingItem: 정정 리비전(ERP 역분개용)
ALTER TABLE "billing_item" ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 1;

-- ERP 청구 전송 메시지(1메시지=1오더) 추적
CREATE TABLE "billing_claim" (
    "claim_id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "patient_id" TEXT,
    "visit_id" TEXT,
    "performed_on" TEXT,
    "item_count" INTEGER NOT NULL DEFAULT 0,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "reject_reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sent_dt" TIMESTAMP(3),
    "ack_dt" TIMESTAMP(3),
    "created_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_dt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "billing_claim_pkey" PRIMARY KEY ("claim_id")
);
CREATE INDEX "billing_claim_status_created_dt_idx" ON "billing_claim"("status", "created_dt");
CREATE INDEX "billing_claim_order_id_idx" ON "billing_claim"("order_id");
