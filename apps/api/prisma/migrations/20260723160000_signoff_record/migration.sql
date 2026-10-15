-- 검사실·법무 서명 기록(값 스냅샷·해시 동반 — 서명 이후 변경 탐지)
CREATE TABLE "signoff_record" (
    "signoff_id" TEXT NOT NULL,
    "section" TEXT NOT NULL,
    "signer_name" TEXT NOT NULL,
    "signer_role" TEXT,
    "signed_by" TEXT,
    "document_no" TEXT,
    "note" TEXT,
    "snapshot_hash" TEXT NOT NULL,
    "snapshot_json" TEXT NOT NULL,
    "signed_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "signoff_record_pkey" PRIMARY KEY ("signoff_id")
);
CREATE INDEX "signoff_record_section_signed_dt_idx" ON "signoff_record"("section", "signed_dt");
