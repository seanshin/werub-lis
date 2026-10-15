-- 조직 게이트(A-1/A-2/A-3/PACS) 결재 추적 — dev 플레이스홀더 seed. 신규 테이블.
CREATE TABLE "org_approval" (
  "approval_id" TEXT NOT NULL,
  "gate_code" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "owner" TEXT,
  "scope" TEXT,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "doc_no" TEXT,
  "approved_date" TEXT,
  "approver" TEXT,
  "note" TEXT,
  "updated_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "org_approval_pkey" PRIMARY KEY ("approval_id")
);
CREATE UNIQUE INDEX "org_approval_gate_code_key" ON "org_approval"("gate_code");
