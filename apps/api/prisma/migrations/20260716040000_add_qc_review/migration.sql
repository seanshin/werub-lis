-- CreateTable: 월간 QC 리뷰 사인오프
CREATE TABLE "qc_review" (
    "review_id" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "instrument" TEXT,
    "reviewed_by" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "note" TEXT,
    "reviewed_dt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "qc_review_pkey" PRIMARY KEY ("review_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "qc_review_period_scope_instrument_key" ON "qc_review"("period", "scope", "instrument");

-- CreateIndex
CREATE INDEX "qc_review_period_idx" ON "qc_review"("period");
