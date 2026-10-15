-- 개시 조직/외부 결정 등록부(사람·조직 결정 캡처)
CREATE TABLE "decision_record" (
    "decision_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decided_value" TEXT,
    "decided_by_name" TEXT,
    "decided_by" TEXT,
    "decided_date" TEXT,
    "document_ref" TEXT,
    "note" TEXT,
    "updated_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "decision_record_pkey" PRIMARY KEY ("decision_id")
);
CREATE UNIQUE INDEX "decision_record_key_key" ON "decision_record"("key");
