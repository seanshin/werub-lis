-- 서명·결재 인력변경 재검토 + 정기 재검토 + 이력.
ALTER TABLE "org_approval" ADD COLUMN "approver_user_id" TEXT;
ALTER TABLE "org_approval" ADD COLUMN "review_interval_days" INTEGER;
ALTER TABLE "org_approval" ADD COLUMN "next_review_date" TEXT;
ALTER TABLE "org_approval" ADD COLUMN "needs_review" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "org_approval" ADD COLUMN "review_reason" TEXT;

CREATE TABLE "org_approval_history" (
  "history_id" TEXT NOT NULL,
  "gate_code" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "actor" TEXT,
  "doc_no" TEXT,
  "approved_date" TEXT,
  "reason" TEXT,
  "created_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "org_approval_history_pkey" PRIMARY KEY ("history_id")
);
CREATE INDEX "org_approval_history_gate_code_idx" ON "org_approval_history"("gate_code");
